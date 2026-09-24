/**
 * LibraryStore — in-memory ToolLibrary + localStorage cache + optional remote (GET/PUT
 * /api/library with optimistic-concurrency revisions). Works in Node: storage/fetch are
 * optional and every access is guarded. See docs/specs/tooling-machine.md §3.
 */
import type { Machine, Material, Message, Tool, ToolLibrary } from '../types';
import { buildStandardLibrary, LIBRARY_VERSION } from '../tools/standard';
import { STORAGE_KEY, mergeLibraries, migrateLibraryDetailed, withStandardItems } from './migrate';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponseLike>;

export interface LibraryStoreOptions {
  /** Cache; default `globalThis.localStorage` when available, `null` disables. */
  storage?: StorageLike | null;
  storageKey?: string;
  /** Remote transport; default `globalThis.fetch` when available, `null` disables the remote. */
  fetch?: FetchLike | null;
  remoteUrl?: string;
  /** Starting state; default `buildStandardLibrary()`. */
  initial?: ToolLibrary;
}

export type LibraryItem = Tool | Material | Machine;
export type LibraryCollection = 'punches' | 'dies' | 'fingers' | 'materials' | 'machines';

export interface LoadResult {
  local: 'loaded' | 'empty' | 'invalid' | 'unavailable';
  remote: 'loaded' | 'not-found' | 'unavailable' | 'disabled';
  messages: Message[];
}

export interface SaveResult {
  local: 'saved' | 'unavailable';
  remote: 'saved' | 'conflict-resolved' | 'conflict' | 'unavailable' | 'disabled' | 'error';
  revision: number;
  messages: Message[];
}

function defaultStorage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike };
    const s = g.localStorage;
    if (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') return s;
  } catch { /* access can throw (privacy modes) */ }
  return null;
}

function defaultFetch(): FetchLike | null {
  const g = globalThis as { fetch?: unknown };
  if (typeof g.fetch === 'function') return ((url, init) => (g.fetch as (u: string, i?: unknown) => Promise<FetchResponseLike>)(url, init));
  return null;
}

/** Which collection an item belongs to (by shape). */
export function collectionOf(item: LibraryItem): LibraryCollection {
  if ('kind' in item) return item.kind === 'punch' ? 'punches' : item.kind === 'die' ? 'dies' : 'fingers';
  if ('bedLength' in item) return 'machines';
  return 'materials';
}

export class LibraryStore {
  private lib: ToolLibrary;
  private readonly listeners = new Set<(lib: ToolLibrary) => void>();
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly fetchFn: FetchLike | null;
  private readonly remoteUrl: string;

  constructor(opts: LibraryStoreOptions = {}) {
    this.lib = opts.initial ?? buildStandardLibrary();
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.storageKey = opts.storageKey ?? STORAGE_KEY;
    this.fetchFn = opts.fetch === undefined ? defaultFetch() : opts.fetch;
    this.remoteUrl = opts.remoteUrl ?? '/api/library';
  }

  /** Current snapshot (treat as immutable; every change produces a new object). */
  get(): ToolLibrary { return this.lib; }

  find(id: string): LibraryItem | undefined {
    const l = this.lib;
    return l.punches.find(x => x.id === id) ?? l.dies.find(x => x.id === id) ?? l.fingers.find(x => x.id === id)
      ?? l.materials.find(x => x.id === id) ?? l.machines.find(x => x.id === id);
  }

  subscribe(fn: (lib: ToolLibrary) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Replace the whole state (already migrated) and notify. */
  replace(lib: ToolLibrary): void {
    this.lib = lib;
    for (const fn of [...this.listeners]) fn(lib);
  }

  /** Apply a change, notify, and write the local cache through (the remote PUT stays explicit via
   *  `save()`): a machine edit or a custom tool must survive a reload even when nobody presses "Save". */
  private touch(patch: Partial<ToolLibrary>): void {
    this.replace({ ...this.lib, ...patch, version: LIBRARY_VERSION, updatedAt: new Date().toISOString() });
    this.saveLocal();
  }

  /** Insert or replace an item (by id) in its collection. */
  upsert(item: LibraryItem): void {
    const col = collectionOf(item);
    const arr = this.lib[col] as LibraryItem[];
    const i = arr.findIndex(x => x.id === item.id);
    const next = arr.slice();
    if (i >= 0) next[i] = item; else next.push(item);
    this.touch({ [col]: next } as Partial<ToolLibrary>);
  }

  remove(id: string): boolean {
    const cols: LibraryCollection[] = ['punches', 'dies', 'fingers', 'materials', 'machines'];
    for (const col of cols) {
      const arr = this.lib[col] as LibraryItem[];
      if (arr.some(x => x.id === id)) {
        this.touch({ [col]: arr.filter(x => x.id !== id) } as Partial<ToolLibrary>);
        return true;
      }
    }
    return false;
  }

  /** Regenerate every `std:` item from code (drops edits made to standard items). */
  resetStandardItems(): void {
    const std = buildStandardLibrary();
    const reset = <T extends { id: string }>(have: T[], standard: T[]): T[] => [
      ...standard, ...have.filter(x => !x.id.startsWith('std:')),
    ];
    this.touch({
      punches: reset(this.lib.punches, std.punches),
      dies: reset(this.lib.dies, std.dies),
      fingers: reset(this.lib.fingers, std.fingers),
      materials: reset(this.lib.materials, std.materials),
      machines: reset(this.lib.machines, std.machines),
    });
  }

  // ── local cache ───────────────────────────────────────────────────────────

  loadLocal(): LoadResult['local'] {
    if (!this.storage) return 'unavailable';
    let text: string | null;
    try { text = this.storage.getItem(this.storageKey); } catch { return 'unavailable'; }
    if (!text) return 'empty';
    try {
      const { library } = migrateLibraryDetailed(JSON.parse(text));
      this.replace(withStandardItems(library));
      return 'loaded';
    } catch {
      return 'invalid';
    }
  }

  saveLocal(): boolean {
    if (!this.storage) return false;
    try { this.storage.setItem(this.storageKey, JSON.stringify(this.lib)); return true; } catch { return false; }
  }

  // ── remote ────────────────────────────────────────────────────────────────

  /** Local cache first, then the remote copy (remote wins per id, local-only items kept). */
  async load(): Promise<LoadResult> {
    const messages: Message[] = [];
    const local = this.loadLocal();
    if (!this.fetchFn) return { local, remote: 'disabled', messages };
    let res: FetchResponseLike;
    try { res = await this.fetchFn(this.remoteUrl, { method: 'GET', headers: { Accept: 'application/json' } }); }
    catch { return { local, remote: 'unavailable', messages }; }
    if (res.status === 404) return { local, remote: 'not-found', messages };
    if (!res.ok) return { local, remote: 'unavailable', messages };
    try {
      const { library, messages: m } = migrateLibraryDetailed(await res.json());
      messages.push(...m);
      const merged = mergeLibraries(this.lib, library);
      this.replace(withStandardItems({ ...merged, revision: library.revision }));
      this.saveLocal();
      return { local, remote: 'loaded', messages };
    } catch {
      return { local, remote: 'unavailable', messages };
    }
  }

  /** Cache locally, then PUT to the remote with our revision; on 409 merge the server copy under ours and retry once. */
  async save(): Promise<SaveResult> {
    const messages: Message[] = [];
    const local: SaveResult['local'] = this.saveLocal() ? 'saved' : 'unavailable';
    if (!this.fetchFn) return { local, remote: 'disabled', revision: this.lib.revision, messages };
    const put = async (): Promise<FetchResponseLike> => this.fetchFn!(this.remoteUrl, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(this.lib),
    });
    let conflictResolved = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: FetchResponseLike;
      try { res = await put(); } catch { return { local, remote: 'unavailable', revision: this.lib.revision, messages }; }
      if (res.ok) {
        try {
          const { library } = migrateLibraryDetailed(await res.json());
          this.replace(withStandardItems(library));
          this.saveLocal();
        } catch { /* keep our state; the server accepted it */ }
        return { local, remote: conflictResolved ? 'conflict-resolved' : 'saved', revision: this.lib.revision, messages };
      }
      if (res.status === 409) {
        try {
          const { library: server, messages: m } = migrateLibraryDetailed(await res.json());
          messages.push(...m);
          const merged = mergeLibraries(server, { ...this.lib, revision: server.revision });
          this.replace(withStandardItems({ ...merged, revision: server.revision }));
          conflictResolved = true;
          continue;
        } catch {
          return { local, remote: 'error', revision: this.lib.revision, messages };
        }
      }
      return { local, remote: 'error', revision: this.lib.revision, messages };
    }
    return { local, remote: 'conflict', revision: this.lib.revision, messages };
  }

  // ── files ─────────────────────────────────────────────────────────────────

  exportJson(): string { return JSON.stringify(this.lib, null, 2); }

  /** Import a `.json` export: merge (imported items win by id) or replace. Returns the migration messages. */
  importJson(json: string, mode: 'merge' | 'replace' = 'merge'): Message[] {
    const { library, messages } = migrateLibraryDetailed(JSON.parse(json));
    const next = mode === 'replace' ? withStandardItems(library) : mergeLibraries(this.lib, library);
    this.replace({ ...next, revision: this.lib.revision, updatedAt: new Date().toISOString() });
    return messages;
  }
}
