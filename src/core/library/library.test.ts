import { describe, it, expect } from 'vitest';
import { buildStandardLibrary, LIBRARY_VERSION } from '../tools/standard';
import { createCustomPunch, normalizeProfile } from '../tools/custom';
import { isCCW } from '../geom';
import { migrateLibrary, migrateLibraryDetailed, mergeLibraries, withStandardItems, STORAGE_KEY } from './migrate';
import { LibraryStore, collectionOf } from './store';
import type { FetchLike, FetchResponseLike, StorageLike } from './store';
import type { ToolLibrary } from '../types';

function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: k => { map.delete(k); } };
}

/** In-memory /api/library server: GET → 404 until the first PUT; PUT with a stale revision → 409 + current body. */
function fakeServer(initial?: ToolLibrary): { fetch: FetchLike; state: { lib: ToolLibrary | null; puts: number; gets: number } } {
  const state = { lib: initial ?? null, puts: 0, gets: 0 };
  const res = (status: number, body: unknown): FetchResponseLike => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });
  const fetch: FetchLike = async (_url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') { state.gets++; return state.lib ? res(200, state.lib) : res(404, { error: 'none' }); }
    if (method === 'PUT') {
      state.puts++;
      const body = JSON.parse(init?.body ?? '{}') as ToolLibrary;
      if (state.lib && body.revision !== state.lib.revision) return res(409, state.lib);
      state.lib = { ...body, revision: (state.lib?.revision ?? 0) + 1 };
      return res(200, state.lib);
    }
    return res(405, {});
  };
  return { fetch, state };
}

const customPunch = () => createCustomPunch(normalizeProfile([{ x: 0, y: 0 }, { x: 8, y: 8 }, { x: 8, y: 100 }, { x: -8, y: 100 }, { x: -8, y: 8 }], { kind: 'punch' }).profile, { id: 'custom:p1', name: 'P1' });

describe('migrateLibrary', () => {
  it('round-trips the standard library through JSON unchanged', () => {
    const lib = buildStandardLibrary();
    const back = migrateLibraryDetailed(JSON.parse(JSON.stringify(lib)));
    expect(back.messages).toEqual([]);
    expect(back.library).toEqual(lib);
  });

  it('migrates a v0 object: [x, y] points, missing kind/source/ratings/version, invalid items dropped', () => {
    const v0 = {
      punches: [
        { id: 'custom:old-punch', name: 'Old', profile: [[0, 0], [6, 6.2], [6, 120], [-6, 120], [-6, 6.2]] },
        { id: 'std:punch-straight-88-r0.8', profile: { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 120 }, { x: -10, y: 120 }, { x: -10, y: 10 }] }, tipRadius: 0.8 },
        { name: 'no id', profile: [[0, 0], [1, 0], [1, 1]] },
        { id: 'custom:bad', profile: [[0, 0], [1, 0]] },
        'garbage',
      ],
      dies: [{ id: 'custom:die', profile: [[-30, 0], [-8, 0], [0, -8.284242510324557], [8, 0], [30, 0], [30, -60], [-30, -60]] }],
      fingers: [{ id: 'custom:finger', profile: [[0, 0], [0, 20], [25, 20], [25, 35], [60, 35], [60, 0]] }],
      materials: [{ id: 'custom:brass', name: 'Brass', tensileStrength: 350 }, { name: 'no id' }],
      machines: [{ id: 'custom:m1', name: 'Small brake', bedLength: 1250, capacity: 400, backgauge: { xMax: 500 } }],
    };
    const { library, messages } = migrateLibraryDetailed(v0);
    expect(library.version).toBe(LIBRARY_VERSION); expect(library.revision).toBe(0);
    expect(typeof library.updatedAt).toBe('string');
    expect(library.punches.map(p => p.id)).toEqual(['custom:old-punch', 'std:punch-straight-88-r0.8']);
    const old = library.punches[0]!;
    expect(old.kind).toBe('punch'); expect(old.source).toBe('custom'); expect(old.family).toBe('custom');
    expect(old.height).toBe(120); expect(old.tipAngle).toBeCloseTo(2 * Math.atan(6 / 6.2) * 180 / Math.PI, 6); expect(old.tipRadius).toBe(0);
    expect(old.maxLoadPerMeter).toBe(600); expect(old.segmentLengths).toEqual([]); expect(isCCW(old.profile.points)).toBe(true);
    expect(library.punches[1]!.source).toBe('standard'); expect(library.punches[1]!.tipAngle).toBeCloseTo(90, 6);
    const die = library.dies[0]!;
    expect(die.kind).toBe('die'); expect(die.vWidth).toBeCloseTo(16, 6); expect(die.vAngle).toBeCloseTo(88, 6); expect(die.height).toBe(60); expect(die.shoulderRadius).toBe(0);
    const finger = library.fingers[0]!;
    expect(finger.kind).toBe('finger'); expect(finger.stopHeight).toBe(20); expect(finger.bodyDepth).toBe(60); expect(finger.width).toBe(30);
    expect(library.materials).toEqual([{ id: 'custom:brass', name: 'Brass', tensileStrength: 350, kFactor: 0.44, springbackDeg: 1.5, minInnerRadiusFactor: 0.8 }]);
    const m = library.machines[0]!;
    expect(m.bedLength).toBe(1250); expect(m.capacity).toBe(400); expect(m.backgauge.xMax).toBe(500); expect(m.backgauge.xMin).toBe(10); expect(m.ram.clampFrontOffset).toBe(55);
    const dropped = messages.filter(x => x.key === 'warnings.library.itemDropped');
    expect(dropped).toHaveLength(4);
    expect(messages.some(x => x.key === 'warnings.library.migrated' && x.params?.from === 0)).toBe(true);
    expect(() => migrateLibrary('nope')).toThrow(TypeError);
    expect(migrateLibrary({}).punches).toEqual([]);
  });

  it('mergeLibraries / withStandardItems', () => {
    const std = buildStandardLibrary();
    const a: ToolLibrary = { ...std, punches: [], revision: 3 };
    const b: ToolLibrary = { ...std, punches: [customPunch()], dies: [], revision: 5 };
    const m = mergeLibraries(a, b);
    expect(m.punches.map(p => p.id)).toEqual(['custom:p1']);
    expect(m.dies.length).toBe(std.dies.length); expect(m.revision).toBe(5);
    const filled = withStandardItems({ ...std, punches: [customPunch()], dies: [] });
    expect(filled.punches.length).toBe(std.punches.length + 1); expect(filled.dies.length).toBe(std.dies.length);
    // overlay wins for the same id
    const edited = { ...std.dies[0]!, maxLoadPerMeter: 123 };
    expect(mergeLibraries(std, { ...std, dies: [edited] }).dies.find(d => d.id === edited.id)!.maxLoadPerMeter).toBe(123);
  });
});

describe('LibraryStore', () => {
  it('get/upsert/remove/subscribe with immutable snapshots', () => {
    const store = new LibraryStore({ storage: null, fetch: null });
    const before = store.get();
    let calls = 0;
    const unsub = store.subscribe(() => { calls++; });
    store.upsert(customPunch());
    expect(calls).toBe(1);
    expect(store.get()).not.toBe(before);
    expect(before.punches.some(p => p.id === 'custom:p1')).toBe(false);
    expect(store.find('custom:p1')?.name).toBe('P1');
    store.upsert({ ...customPunch(), name: 'P1b' });
    expect(store.get().punches.filter(p => p.id === 'custom:p1')).toHaveLength(1);
    expect(store.find('custom:p1')?.name).toBe('P1b');
    expect(store.remove('custom:p1')).toBe(true);
    expect(store.remove('custom:p1')).toBe(false);
    expect(calls).toBe(3);
    unsub();
    store.upsert({ id: 'custom:mat', name: 'M', tensileStrength: 500, kFactor: 0.4, springbackDeg: 2, minInnerRadiusFactor: 1 });
    expect(calls).toBe(3);
    expect(collectionOf(store.find('custom:mat')!)).toBe('materials');
    expect(collectionOf(store.get().machines[0]!)).toBe('machines');
    expect(collectionOf(store.get().dies[0]!)).toBe('dies');
    // editing a standard item then resetting restores the generated one
    const v16 = store.get().dies.find(d => d.id === 'std:die-v16-88')!;
    store.upsert({ ...v16, maxLoadPerMeter: 1 });
    expect(store.find('std:die-v16-88')).toMatchObject({ maxLoadPerMeter: 1 });
    store.resetStandardItems();
    expect(store.find('std:die-v16-88')).toMatchObject({ maxLoadPerMeter: 1000 });
    expect(store.find('custom:mat')).toBeDefined();
  });

  it('localStorage cache round trip and export/import JSON', () => {
    const storage = fakeStorage();
    const store = new LibraryStore({ storage, fetch: null });
    store.upsert(customPunch());
    expect(store.saveLocal()).toBe(true);
    expect(storage.map.has(STORAGE_KEY)).toBe(true);
    const store2 = new LibraryStore({ storage, fetch: null });
    expect(store2.find('custom:p1')).toBeUndefined();
    expect(store2.loadLocal()).toBe('loaded');
    expect(store2.find('custom:p1')?.name).toBe('P1');
    expect(store2.get().punches.length).toBe(buildStandardLibrary().punches.length + 1);
    // export → import (merge and replace)
    const json = store2.exportJson();
    expect(JSON.parse(json).version).toBe(LIBRARY_VERSION);
    const store3 = new LibraryStore({ storage: null, fetch: null });
    expect(store3.importJson(json)).toEqual([]);
    expect(store3.find('custom:p1')).toBeDefined();
    const v0json = JSON.stringify({ punches: [{ id: 'custom:v0', profile: [[0, 0], [5, 5], [5, 100], [-5, 100], [-5, 5]] }] });
    const msgs = store3.importJson(v0json, 'replace');
    expect(msgs.some(m => m.key === 'warnings.library.migrated')).toBe(true);
    expect(store3.find('custom:v0')).toBeDefined();
    expect(store3.find('custom:p1')).toBeUndefined();
    expect(store3.find('std:punch-straight-88-r0.8')).toBeDefined(); // standard items always present
    // corrupt cache → 'invalid', empty → 'empty', no storage → 'unavailable'
    storage.map.set(STORAGE_KEY, '{not json');
    expect(new LibraryStore({ storage, fetch: null }).loadLocal()).toBe('invalid');
    storage.map.delete(STORAGE_KEY);
    expect(new LibraryStore({ storage, fetch: null }).loadLocal()).toBe('empty');
    expect(new LibraryStore({ storage: null, fetch: null }).loadLocal()).toBe('unavailable');
  });

  it('remote: load (404 then 200), save with revision bump, 409 merge + retry once', async () => {
    const server = fakeServer();
    const storage = fakeStorage();
    const a = new LibraryStore({ storage, fetch: server.fetch });
    const l1 = await a.load();
    expect(l1).toMatchObject({ local: 'empty', remote: 'not-found' });
    a.upsert(customPunch());
    const s1 = await a.save();
    expect(s1.remote).toBe('saved'); expect(s1.revision).toBe(1); expect(a.get().revision).toBe(1);
    expect(server.state.lib?.punches.some(p => p.id === 'custom:p1')).toBe(true);
    // a second client loads the remote copy
    const b = new LibraryStore({ storage: fakeStorage(), fetch: server.fetch });
    const l2 = await b.load();
    expect(l2.remote).toBe('loaded'); expect(b.find('custom:p1')).toBeDefined(); expect(b.get().revision).toBe(1);
    // b saves a new material → revision 2; a (stale, revision 1) then saves a new die → 409 → merge → retry
    b.upsert({ id: 'custom:m2', name: 'M2', tensileStrength: 300, kFactor: 0.4, springbackDeg: 2, minInnerRadiusFactor: 1 });
    expect((await b.save()).revision).toBe(2);
    a.upsert(createCustomPunch(customPunch().profile, { id: 'custom:p2', name: 'P2' }));
    const putsBefore = server.state.puts;
    const s3 = await a.save();
    expect(s3.remote).toBe('conflict-resolved'); expect(s3.revision).toBe(3);
    expect(server.state.puts - putsBefore).toBe(2);
    expect(a.find('custom:m2')).toBeDefined(); expect(a.find('custom:p2')).toBeDefined();
    expect(server.state.lib?.materials.some(m => m.id === 'custom:m2')).toBe(true);
    expect(server.state.lib?.punches.some(p => p.id === 'custom:p2')).toBe(true);
    // local cache updated with the server revision
    expect(JSON.parse(storage.map.get(STORAGE_KEY)!).revision).toBe(3);
  });

  it('remote failures are reported, never thrown', async () => {
    const failing: FetchLike = async () => { throw new Error('offline'); };
    const s = new LibraryStore({ storage: null, fetch: failing });
    expect((await s.load()).remote).toBe('unavailable');
    expect((await s.save())).toMatchObject({ local: 'unavailable', remote: 'unavailable' });
    const conflicting: FetchLike = async () => ({ ok: false, status: 409, json: async () => buildStandardLibrary() });
    const c = new LibraryStore({ storage: null, fetch: conflicting });
    expect((await c.save()).remote).toBe('conflict');
    const disabled = new LibraryStore({ storage: null, fetch: null });
    expect((await disabled.load()).remote).toBe('disabled');
    expect((await disabled.save()).remote).toBe('disabled');
    const error: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    expect((await new LibraryStore({ storage: null, fetch: error }).save()).remote).toBe('error');
  });
});
