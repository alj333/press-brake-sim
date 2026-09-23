/**
 * Reviewer edge-case tests for src/core/library: hostile / stale JSON, frame normalisation on
 * migration, forwarded derivation messages, version downgrades, store failure modes.
 */
import { describe, it, expect } from 'vitest';
import { bounds } from '../geom';
import { buildStandardLibrary, LIBRARY_VERSION } from '../tools/standard';
import { createCustomPunch, createCustomDie, createCustomFinger, normalizeProfile } from '../tools/custom';
import { vDie } from '../tools/dies';
import { flatFinger } from '../tools/fingers';
import { migrateLibraryDetailed, mergeLibraries, withStandardItems, migratePunch, migrateMachine } from './migrate';
import { LibraryStore } from './store';
import type { FetchLike, StorageLike } from './store';
import { findTool, findMachine, findMaterial } from './lookup';
import type { Message, ToolLibrary } from '../types';

const std = buildStandardLibrary();

describe('migrateLibrary — hostile values', () => {
  it('negative / non-numeric ratings, sizes and factors fall back to defaults; segments are filtered', () => {
    const { library, messages } = migrateLibraryDetailed({
      version: 1,
      punches: [{ id: 'custom:p', profile: [[0, 0], [8, 8], [8, 100], [-8, 100], [-8, 8]], segmentLengths: [-5, 'x', 100, 0, NaN], maxLoadPerMeter: -1, tipAngle: 'nope', tipRadius: -3, bodyWidth: 0, height: -100 }],
      dies: [{ id: 'custom:d', profile: [[-30, -60], [30, -60], [30, 0], [8, 0], [0, -8.284], [-8, 0], [-30, 0]], vAngle: 400, shoulderRadius: -1, maxLoadPerMeter: 'lots' }],
      fingers: [{ id: 'custom:f', profile: { points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 35 }, { x: 0, y: 20 }] }, width: -3, stopHeight: 0 }],
      materials: [{ id: 'custom:mat', tensileStrength: 'a', kFactor: 5, springbackDeg: -2, minInnerRadiusFactor: -1, density: -7 }],
    });
    const p = library.punches[0]!;
    expect(p.segmentLengths).toEqual([100]);
    expect(p.maxLoadPerMeter).toBe(600);
    expect(p.tipAngle).toBeCloseTo(90, 6); expect(p.tipRadius).toBe(0); expect(p.bodyWidth).toBe(16); expect(p.height).toBe(100);
    const d = library.dies[0]!;
    expect(d.vAngle).toBeCloseTo(88, 2); expect(d.shoulderRadius).toBe(0); expect(d.maxLoadPerMeter).toBe(600); expect(d.vWidth).toBeCloseTo(16, 6);
    const f = library.fingers[0]!;
    expect(f.width).toBe(30); expect(f.stopHeight).toBe(20);
    expect(library.materials[0]).toEqual({ id: 'custom:mat', name: 'custom:mat', tensileStrength: 420, kFactor: 0.44, springbackDeg: 1.5, minInnerRadiusFactor: 0.8 });
    expect(messages.filter(m => m.key === 'warnings.library.itemDropped')).toEqual([]);
  });

  it('profiles are shifted into the tool frame on migration (die top → 0, punch/finger bottom → 0)', () => {
    const { library } = migrateLibraryDetailed({
      punches: [{ id: 'custom:p', profile: [[0, 5], [8, 13], [8, 105], [-8, 105], [-8, 13]] }],
      dies: [{ id: 'custom:d', profile: [[-30, 5], [30, 5], [30, 65], [8, 65], [0, 56.716], [-8, 65], [-30, 65]] }],
      fingers: [{ id: 'custom:f', profile: [[2, 2], [62, 2], [62, 37], [17, 37], [2, 22]] }],
    });
    expect(bounds(library.punches[0]!.profile.points).min.y).toBe(0);
    expect(library.punches[0]!.height).toBe(100);
    expect(bounds(library.dies[0]!.profile.points).max.y).toBe(0);
    expect(library.dies[0]!.height).toBe(60);
    expect(library.dies[0]!.vWidth).toBeCloseTo(16, 2);
    expect(bounds(library.fingers[0]!.profile.points).min).toEqual({ x: 0, y: 0 });
    expect(library.fingers[0]!.stopHeight).toBe(20);
  });

  it('derivation messages are forwarded with the collection and id', () => {
    const { messages } = migrateLibraryDetailed({
      dies: [{ id: 'custom:flat', profile: [[-30, -50], [30, -50], [30, 0], [-30, 0]] }],
      fingers: [{ id: 'custom:noface', profile: [[0, 0], [60, 0], [60, 35], [5, 35]] }],
      punches: [{ id: 'custom:offtip', profile: [[3, 1], [11, 9.3], [11, 100], [-5, 100], [-5, 9.3]] }],
    });
    const byKey = (k: string): Message | undefined => messages.find(m => m.key === k);
    expect(byKey('warnings.tool.notchNotFound')?.params).toMatchObject({ collection: 'dies', id: 'custom:flat' });
    expect(byKey('warnings.tool.stopFaceNotFound')?.params).toMatchObject({ collection: 'fingers', id: 'custom:noface' });
    expect(byKey('warnings.tool.tipNotFound')?.params).toMatchObject({ collection: 'punches', id: 'custom:offtip' });
  });

  it('a std: item from an old file keeps its standard family and rating', () => {
    const messages: Message[] = [];
    const gn = migratePunch({ id: 'std:punch-gooseneck-88-r0.8', profile: std.punches.find(p => p.id === 'std:punch-gooseneck-88-r0.8')!.profile.points }, 0, messages)!;
    expect(gn.family).toBe('gooseneck'); expect(gn.maxLoadPerMeter).toBe(600); expect(gn.source).toBe('standard');
    expect(gn.tangCentreX).toBe(7);
    const unknownStd = migratePunch({ id: 'std:punch-future', profile: [[0, 0], [8, 8], [8, 100], [-8, 100], [-8, 8]] }, 0, messages)!;
    expect(unknownStd.family).toBe('custom'); expect(unknownStd.source).toBe('standard');
  });

  it('version handling: 1 → silent, 0 → info, 2 (newer app) → warning; revision floor', () => {
    expect(migrateLibraryDetailed({ version: 1 }).messages).toEqual([]);
    expect(migrateLibraryDetailed({ version: 0 }).messages[0]).toMatchObject({ key: 'warnings.library.migrated', severity: 'info' });
    expect(migrateLibraryDetailed({ version: 2 }).messages[0]).toMatchObject({ key: 'warnings.library.migrated', severity: 'warning', params: { from: 2, to: LIBRARY_VERSION } });
    expect(migrateLibraryDetailed({ revision: 3.7 }).library.revision).toBe(3);
    expect(migrateLibraryDetailed({ revision: '5' }).library.revision).toBe(0);
    for (const bad of [null, [], 'x', 42]) expect(() => migrateLibraryDetailed(bad)).toThrow(TypeError);
  });

  it('a machine with garbage nested objects gets defaults but keeps its own numbers', () => {
    const messages: Message[] = [];
    const m = migrateMachine({ id: 'custom:m', ram: 'no', table: null, backgauge: { fingerCount: 2.5, independentX: 'yes', speed: 0 }, capacity: 630 }, 0, messages)!;
    expect(m.capacity).toBe(630);
    expect(m.ram.clampThickness).toBe(110); expect(m.table.holderHeight).toBe(60);
    expect(m.backgauge.fingerCount).toBe(2); expect(m.backgauge.independentX).toBe(true); expect(m.backgauge.speed).toBe(0);
  });

  it('tools created by createCustom* round-trip through migrate unchanged', () => {
    const p = createCustomPunch(normalizeProfile([{ x: 0, y: 0 }, { x: 6, y: 6.2 }, { x: 6, y: 120 }, { x: -6, y: 120 }, { x: -6, y: 6.2 }], { kind: 'punch' }).profile, { id: 'custom:p' });
    const d = createCustomDie(vDie({ vWidth: 20 }).profile, { id: 'custom:d' });
    const f = createCustomFinger(flatFinger().profile, { id: 'custom:f', width: 40 });
    const lib: ToolLibrary = { ...std, punches: [p], dies: [d], fingers: [f] };
    const back = migrateLibraryDetailed(JSON.parse(JSON.stringify(lib)));
    expect(back.messages).toEqual([]);
    expect(back.library.punches[0]).toEqual(p);
    expect(back.library.dies[0]).toEqual(d);
    expect(back.library.fingers[0]).toEqual(f);
  });

  it('mergeLibraries keeps base order, appends overlay-only items, and withStandardItems is idempotent', () => {
    const custom = createCustomPunch(std.punches[0]!.profile, { id: 'custom:x' });
    const a: ToolLibrary = { ...std, punches: [std.punches[0]!, std.punches[1]!], revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' };
    const b: ToolLibrary = { ...std, punches: [custom, { ...std.punches[1]!, name: 'edited' }], revision: 4, updatedAt: '2026-02-01T00:00:00.000Z' };
    const merged = mergeLibraries(a, b);
    expect(merged.punches.map(p => p.id)).toEqual([std.punches[0]!.id, std.punches[1]!.id, 'custom:x']);
    expect(merged.punches[1]!.name).toBe('edited');
    expect(merged.revision).toBe(4); expect(merged.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    const once = withStandardItems(merged);
    expect(withStandardItems(once)).toEqual(once);
    expect(once.punches.length).toBe(std.punches.length + 1);
  });
});

describe('LibraryStore — failure modes', () => {
  const okJson = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });

  it('remote 500 on load → unavailable, state untouched; unparsable remote body → unavailable', async () => {
    const s = new LibraryStore({ storage: null, fetch: async () => okJson(500, {}) });
    const before = s.get();
    expect((await s.load()).remote).toBe('unavailable');
    expect(s.get()).toBe(before);
    const garbage = new LibraryStore({ storage: null, fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) });
    expect((await garbage.load()).remote).toBe('unavailable');
    const notObject = new LibraryStore({ storage: null, fetch: async () => okJson(200, [1, 2]) });
    expect((await notObject.load()).remote).toBe('unavailable');
  });

  it('save: a 200 with an unparsable body keeps our state and still reports saved', async () => {
    const s = new LibraryStore({ storage: null, fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }) });
    const custom = createCustomPunch(std.punches[0]!.profile, { id: 'custom:x' });
    s.upsert(custom);
    const r = await s.save();
    expect(r.remote).toBe('saved');
    expect(s.find('custom:x')).toBeDefined();
  });

  it('a storage that throws is treated as unavailable, never propagates', () => {
    const throwing: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const s = new LibraryStore({ storage: throwing, fetch: null });
    expect(s.loadLocal()).toBe('unavailable');
    expect(s.saveLocal()).toBe(false);
  });

  it('load with a 409-only server on save keeps the merged copy for a later retry', async () => {
    const serverLib: ToolLibrary = { ...std, revision: 9, materials: [...std.materials, { id: 'custom:srv', name: 'srv', tensileStrength: 300, kFactor: 0.4, springbackDeg: 1, minInnerRadiusFactor: 1 }] };
    let puts = 0;
    const fetch: FetchLike = async (_u, init) => { if (init?.method === 'PUT') { puts++; return okJson(409, serverLib); } return okJson(404, {}); };
    const s = new LibraryStore({ storage: null, fetch });
    s.upsert(createCustomPunch(std.punches[0]!.profile, { id: 'custom:mine' }));
    const r = await s.save();
    expect(r.remote).toBe('conflict'); expect(puts).toBe(2);
    expect(s.get().revision).toBe(9);
    expect(s.find('custom:srv')).toBeDefined(); expect(s.find('custom:mine')).toBeDefined();
  });

  it('upsert/remove for machines and materials; importJson rejects unparsable text', () => {
    const s = new LibraryStore({ storage: null, fetch: null });
    s.upsert({ ...s.get().machines[0]!, id: 'custom:brake', name: 'Small brake', bedLength: 1250 });
    expect(findMachine(s.get(), 'custom:brake')?.bedLength).toBe(1250);
    expect(findTool(s.get(), 'custom:brake')).toBeUndefined();
    expect(findMaterial(s.get(), 'std:mild-steel')?.tensileStrength).toBe(420);
    expect(s.remove('custom:brake')).toBe(true);
    expect(findMachine(s.get(), 'custom:brake')).toBeUndefined();
    expect(() => s.importJson('{not json')).toThrow();
    expect(() => s.importJson('[]')).toThrow(TypeError);
    // an import with nothing in it changes nothing but the timestamp
    const before = s.get();
    expect(s.importJson('{"version":1}')).toEqual([]);
    expect(s.get().punches).toEqual(before.punches);
  });
});
