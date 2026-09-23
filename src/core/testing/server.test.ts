/**
 * Integration test of the production server (server/app.ts): the shared-library API contract that
 * `LibraryStore` (src/core/library) relies on — GET 404 before the first save, PUT with the
 * current revision → 200 + bumped body, a stale revision → 409 + the current body (merged and
 * retried once by the client), shape validation → 400, atomic file, health, static + SPA fallback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../../server/app.ts';
import { validateLibraryShape } from '../../../server/library-shape.ts';
import { LibraryStore } from '../library';
import type { FetchLike } from '../library';
import { buildStandardLibrary, createCustomPunch, normalizeProfile, straightPunch } from '../tools';
import type { ToolLibrary } from '../types';

let server: Server;
let base = '';
let dataDir = '';
let distDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pbsim-data-'));
  distDir = await mkdtemp(join(tmpdir(), 'pbsim-dist-'));
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
  await writeFile(join(distDir, 'assets', 'index-abc123.js'), 'console.log(1)');
  const app = createApp({ distDir, dataDir, log: false });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
});

const json = (method: string, body?: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

/** A LibraryStore fetch adapter bound to the test server (the app uses the relative '/api/library'). */
const fetchTo = (origin: string): FetchLike => async (url, init) => {
  const res = await fetch(origin + url, init);
  return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() };
};

describe('server /api', () => {
  it('health reports ok without a library file', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; library: { exists: boolean }; dist: boolean };
    expect(body.ok).toBe(true);
    expect(body.library.exists).toBe(false);
    expect(body.dist).toBe(true);
  });

  it('GET /api/library is 404 before the first save', async () => {
    const res = await fetch(`${base}/api/library`);
    expect(res.status).toBe(404);
  });

  it('rejects bodies that are not a tool library (400) and bad JSON', async () => {
    const bad = await fetch(`${base}/api/library`, json('PUT', { punches: 'nope' }));
    expect(bad.status).toBe(400);
    const details = (await bad.json() as { details: string[] }).details;
    expect(details.some(d => d.includes('punches'))).toBe(true);
    const notJson = await fetch(`${base}/api/library`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(notJson.status).toBe(400);
    expect((await notJson.json() as { code: string }).code).toBe('entity.parse.failed');
    const unknown = await fetch(`${base}/api/nope`);
    expect(unknown.status).toBe(404);
    expect(await readdir(dataDir)).toEqual([]); // nothing written
  });

  it('PUT stores with a bumped revision, a stale revision gets 409 with the current body', async () => {
    const lib = buildStandardLibrary();
    expect(lib.revision).toBe(0);
    const first = await fetch(`${base}/api/library`, json('PUT', lib));
    expect(first.status).toBe(200);
    const stored = await first.json() as ToolLibrary;
    expect(stored.revision).toBe(1);
    expect(stored.punches.length).toBe(lib.punches.length);
    expect(Date.parse(stored.updatedAt)).toBeGreaterThan(0);

    const onDisk = JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8')) as ToolLibrary;
    expect(onDisk.revision).toBe(1);
    expect((await readdir(dataDir)).filter(f => f.endsWith('.tmp'))).toEqual([]); // atomic: no temp file left

    const stale = await fetch(`${base}/api/library`, json('PUT', { ...lib, revision: 0 }));
    expect(stale.status).toBe(409);
    expect((await stale.json() as ToolLibrary).revision).toBe(1);

    const next = await fetch(`${base}/api/library`, json('PUT', { ...stored, revision: 1 }));
    expect(next.status).toBe(200);
    expect((await next.json() as ToolLibrary).revision).toBe(2);

    const get = await fetch(`${base}/api/library`);
    expect(get.status).toBe(200);
    expect((await get.json() as ToolLibrary).revision).toBe(2);
    expect(get.headers.get('cache-control')).toBe('no-store');
  });

  it('concurrent PUTs with the same revision: exactly one wins', async () => {
    const current = await (await fetch(`${base}/api/library`)).json() as ToolLibrary;
    const results = await Promise.all([0, 1, 2].map(i => fetch(`${base}/api/library`, json('PUT', { ...current, updatedAt: `race-${i}` }))));
    const statuses = results.map(r => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const after = await (await fetch(`${base}/api/library`)).json() as ToolLibrary;
    expect(after.revision).toBe(current.revision + 1);
  });

  it('LibraryStore round trip: load merges the server copy, save resolves a 409 by merging and retrying', async () => {
    // Client A adds a custom punch and saves.
    const a = new LibraryStore({ storage: null, fetch: fetchTo(base) });
    const loadA = await a.load();
    expect(loadA.remote).toBe('loaded');
    const revA = a.get().revision;
    const profile = normalizeProfile(straightPunch({}).profile.points, { kind: 'punch' }).profile;
    a.upsert(createCustomPunch(profile, { id: 'custom:test-a', name: 'A punch' }));
    const saveA = await a.save();
    expect(saveA.remote).toBe('saved');
    expect(saveA.revision).toBe(revA + 1);

    // Client B still holds the old revision, adds its own punch: first PUT is 409, the store merges and retries.
    const b = new LibraryStore({ storage: null, fetch: fetchTo(base) });
    b.replace({ ...buildStandardLibrary(), revision: revA });
    b.upsert(createCustomPunch(profile, { id: 'custom:test-b', name: 'B punch' }));
    const saveB = await b.save();
    expect(saveB.remote).toBe('conflict-resolved');
    expect(saveB.revision).toBe(revA + 2);
    const ids = b.get().punches.map(p => p.id);
    expect(ids).toContain('custom:test-a');
    expect(ids).toContain('custom:test-b');

    // A fresh client sees both.
    const c = new LibraryStore({ storage: null, fetch: fetchTo(base) });
    await c.load();
    expect(c.get().punches.map(p => p.id)).toEqual(expect.arrayContaining(['custom:test-a', 'custom:test-b']));
    expect(c.get().revision).toBe(revA + 2);
  });
});

describe('server static + SPA', () => {
  it('serves index.html for the root and for client-side routes, assets with long caching', async () => {
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('cache-control')).toBe('no-cache');
    const route = await fetch(`${base}/some/client/route`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('id="root"');
    const asset = await fetch(`${base}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    const missing = await fetch(`${base}/assets/missing.js`);
    expect(missing.status).toBe(404);
    const apiMissing = await fetch(`${base}/api/`);
    expect(apiMissing.status).toBe(404);
    expect(root.headers.get('x-powered-by')).toBeNull();
  });
});

describe('validateLibraryShape', () => {
  it('accepts the standard library and fills defaults', () => {
    const r = validateLibraryShape(buildStandardLibrary());
    expect(r.ok).toBe(true);
    const { version, revision, ...rest } = buildStandardLibrary();
    const filled = validateLibraryShape(rest);
    expect(filled.ok && filled.library.version).toBe(1);
    expect(filled.ok && filled.library.revision).toBe(0);
    void version; void revision;
  });
  it('rejects non-objects, bad collections, bad ids and profiles', () => {
    expect(validateLibraryShape(null).ok).toBe(false);
    expect(validateLibraryShape([]).ok).toBe(false);
    const lib = buildStandardLibrary();
    expect(validateLibraryShape({ ...lib, dies: {} }).ok).toBe(false);
    expect(validateLibraryShape({ ...lib, revision: 1.5 }).ok).toBe(false);
    expect(validateLibraryShape({ ...lib, punches: [{ ...lib.punches[0], id: '' }] }).ok).toBe(false);
    expect(validateLibraryShape({ ...lib, punches: [{ ...lib.punches[0], profile: { points: [{ x: 0, y: 0 }] } }] }).ok).toBe(false);
    expect(validateLibraryShape({ ...lib, punches: [lib.punches[0], lib.punches[0]] }).ok).toBe(false);
    expect(validateLibraryShape({ ...lib, materials: [{ id: 'm', tensileStrength: 'strong' }] }).ok).toBe(false);
  });
});
