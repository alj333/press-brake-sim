/**
 * Express 5 application: static `dist/` with SPA fallback, the shared tool-library API
 * (`GET/PUT /api/library`, JSON file `$DATA_DIR/library.json`, optimistic-concurrency
 * revisions → 409 with the current body) and `GET /api/health`. See ARCHITECTURE "Server & Docker".
 */
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateLibraryShape } from './library-shape.ts';
import type { LibraryShape } from './library-shape.ts';

export interface AppOptions {
  /** Built front-end (Vite output). Missing ⇒ only the API is served. */
  distDir: string;
  /** Directory of `library.json` (created on first PUT). */
  dataDir: string;
  /** Request body limit for PUT /api/library. Default '25mb'. */
  bodyLimit?: string;
  /** Console logging of requests / errors. Default true. */
  log?: boolean;
}

export const LIBRARY_FILE = 'library.json';

/** Serialises reads-then-writes of the library file so concurrent PUTs cannot both pass the revision check. */
class LibraryFileStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly dir: string;
  readonly file: string;
  constructor(dir: string) { this.dir = dir; this.file = path.join(dir, LIBRARY_FILE); }

  /** Run `fn` exclusively (FIFO). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Current stored library, or null when no file exists yet. Throws on unreadable / corrupt JSON. */
  async read(): Promise<LibraryShape | null> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const parsed: unknown = JSON.parse(text);
    const shape = validateLibraryShape(parsed);
    if (!shape.ok) throw new Error(`stored ${LIBRARY_FILE} is not a tool library: ${shape.errors[0]}`);
    return shape.library;
  }

  /** Atomic replace: write a temp file in the same directory, fsync-free rename over the target. */
  private async writeAtomic(lib: LibraryShape): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.${LIBRARY_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(lib, null, 2), 'utf8');
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Revision-checked update. Accepts the body when the store is empty or `body.revision` equals the
   * stored revision; stores it with revision + 1 and a fresh `updatedAt`. Otherwise returns the
   * current copy for a 409.
   */
  update(body: LibraryShape): Promise<{ status: 'stored'; library: LibraryShape } | { status: 'conflict'; current: LibraryShape }> {
    return this.locked(async () => {
      const current = await this.read();
      if (current && current.revision !== body.revision) return { status: 'conflict', current };
      const next: LibraryShape = {
        ...body,
        revision: (current ? current.revision : body.revision) + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.writeAtomic(next);
      return { status: 'stored', library: next };
    });
  }
}

export function createApp(opts: AppOptions): Express {
  const app = express();
  const store = new LibraryFileStore(path.resolve(opts.dataDir));
  const distDir = path.resolve(opts.distDir);
  const indexHtml = path.join(distDir, 'index.html');
  const log = opts.log ?? true;

  app.disable('x-powered-by');
  app.set('etag', 'weak');

  // ── API ───────────────────────────────────────────────────────────────────
  const api = express.Router();
  api.use(express.json({ limit: opts.bodyLimit ?? '25mb', strict: true }));

  api.get('/health', async (_req, res) => {
    let library: { exists: boolean; revision?: number; updatedAt?: string; error?: string } = { exists: false };
    try {
      const lib = await store.read();
      if (lib) library = { exists: true, revision: lib.revision, updatedAt: lib.updatedAt };
    } catch (err) {
      library = { exists: true, error: (err as Error).message };
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, status: 'ok', uptimeS: Math.round(process.uptime()), now: new Date().toISOString(), dist: existsSync(indexHtml), library });
  });

  api.get('/library', async (_req, res, next) => {
    try {
      const lib = await store.read();
      res.set('Cache-Control', 'no-store');
      if (!lib) { res.status(404).json({ error: 'no shared library yet', code: 'not-found' }); return; }
      res.json(lib);
    } catch (err) { next(err); }
  });

  api.put('/library', async (req, res, next) => {
    try {
      const shape = validateLibraryShape(req.body);
      res.set('Cache-Control', 'no-store');
      if (!shape.ok) { res.status(400).json({ error: 'invalid tool library', code: 'invalid-shape', details: shape.errors }); return; }
      const result = await store.update(shape.library);
      if (result.status === 'conflict') { res.status(409).json(result.current); return; }
      res.status(200).json(result.library);
    } catch (err) { next(err); }
  });

  api.use((_req, res) => { res.status(404).json({ error: 'not found', code: 'not-found' }); });
  app.use('/api', api);

  // ── static front-end + SPA fallback ───────────────────────────────────────
  app.use(express.static(distDir, {
    index: ['index.html'],
    fallthrough: true,
    setHeaders(res, filePath) {
      // Vite hashes everything under /assets → cache forever; index.html and the samples/fonts revalidate.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
    if (req.path.startsWith('/api/') || path.extname(req.path) !== '' || !existsSync(indexHtml)) { next(); return; }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
  app.use((_req, res) => { res.status(404).type('text/plain').send('Not found'); });

  // ── errors ────────────────────────────────────────────────────────────────
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
    const status = e.status ?? e.statusCode ?? 500;
    if (log && status >= 500) console.error('[pbsim]', e.message ?? err);
    res.status(status).json({ error: status >= 500 ? 'internal error' : (e.message ?? 'bad request'), code: e.type ?? (status >= 500 ? 'internal' : 'bad-request') });
  });

  return app;
}

/** Resolve the library file path for logs. */
export function libraryFilePath(dataDir: string): string { return path.join(path.resolve(dataDir), LIBRARY_FILE); }

/** True when `dir/index.html` exists (the front-end was built). */
export async function hasBuiltFrontend(distDir: string): Promise<boolean> {
  try { return (await stat(path.join(distDir, 'index.html'))).isFile(); } catch { return false; }
}
