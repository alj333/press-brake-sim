/**
 * ToolLibrary persistence: shape validation, default filling and version migration.
 * Accepts v0 objects (partial tools, missing metadata, [x, y] profile points). Never throws for
 * malformed items — they are dropped with a message; only a non-object input throws.
 * See docs/specs/tooling-machine.md §3.
 */
import type { Die, DieFamily, Finger, Machine, Material, Message, Polygon2, Punch, PunchFamily, ToolLibrary, ToolSource } from '../types';
import { ensureCCW, dedupe } from '../geom';
import { derivePunchParams, deriveDieParams, deriveFingerParams } from '../tools/derive';
import { PUNCH_RATINGS } from '../tools/punches';
import { standardDieRating } from '../tools/dies';
import { LIBRARY_VERSION, buildStandardLibrary } from '../tools/standard';
import { CUSTOM_DEFAULT_RATING, enforceFrameExtents } from '../tools/custom';
import type { ToolKind } from '../tools/custom';
import { defaultMachine } from '../machine/default';

export const STORAGE_KEY = 'pbsim.library.v1';

export interface MigrationResult { library: ToolLibrary; messages: Message[] }

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown, fallback: number): number => (fin(v) ? v : fallback);
/** Finite and > 0 (or ≥ 0 with `zeroOk`), else the fallback — for dimensions and ratings. */
const pos = (v: unknown, fallback: number, zeroOk = false): number => (fin(v) && (zeroOk ? v >= 0 : v > 0) ? v : fallback);
/** Finite and within [lo, hi], else the fallback — for angles and factors. */
const within = (v: unknown, lo: number, hi: number, fallback: number): number => (fin(v) && v >= lo && v <= hi ? v : fallback);
const isPos = (v: unknown, zeroOk = false): boolean => fin(v) && (zeroOk ? v >= 0 : v > 0);
const isWithin = (v: unknown, lo: number, hi: number): boolean => fin(v) && v >= lo && v <= hi;

const PUNCH_FAMILIES: readonly PunchFamily[] = ['straight', 'gooseneck', 'acute', 'radius', 'hemming', 'custom'];
const DIE_FAMILIES: readonly DieFamily[] = ['v', 'multi-v', 'hemming', 'u', 'custom'];

/** Profile points as {x,y} or [x,y]; deduped, CCW and shifted into the tool frame of `kind`. */
function parsePoints(v: unknown, kind: ToolKind): Polygon2 | null {
  const raw = isRec(v) ? v['points'] : v;
  if (!Array.isArray(raw)) return null;
  const pts: Polygon2 = [];
  for (const p of raw) {
    if (Array.isArray(p) && fin(p[0]) && fin(p[1])) pts.push({ x: p[0], y: p[1] });
    else if (isRec(p) && fin(p['x']) && fin(p['y'])) pts.push({ x: p['x'], y: p['y'] });
    else return null;
  }
  const clean = ensureCCW(dedupe(pts, 1e-9));
  return clean.length >= 3 ? enforceFrameExtents(clean, kind) : null;
}

/** Generated standard items by id (lazy): defaults for `std:` items whose old record lacks fields. */
let standardById: Map<string, Punch | Die | Finger> | null = null;
function standardItem(id: string): Punch | Die | Finger | undefined {
  if (!id.startsWith('std:')) return undefined;
  if (!standardById) {
    const std = buildStandardLibrary();
    standardById = new Map<string, Punch | Die | Finger>([...std.punches, ...std.dies, ...std.fingers].map(t => [t.id, t]));
  }
  return standardById.get(id);
}

/** Forward the derivation's messages (tip/notch/stop face not found) tagged with the item. */
function forward(messages: Message[], derived: Message[], collection: string, id: string): void {
  for (const m of derived) messages.push({ ...m, params: { ...(m.params ?? {}), collection, id } });
}

function parseSegments(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => fin(x) && x > 0);
}

function sourceOf(raw: Rec, id: string): ToolSource {
  return raw['source'] === 'standard' || raw['source'] === 'custom' ? raw['source'] : id.startsWith('std:') ? 'standard' : 'custom';
}

function toolBase(raw: Rec, index: number, collection: string, kind: ToolKind, messages: Message[]): { id: string; name: string; source: ToolSource; points: Polygon2; segmentLengths: number[]; notes?: string } | null {
  const id = raw['id'];
  if (!str(id) || id.length === 0) {
    messages.push({ key: 'warnings.library.itemDropped', severity: 'warning', params: { collection, index, reason: 'missing id' } });
    return null;
  }
  const points = parsePoints(raw['profile'], kind);
  if (!points) {
    messages.push({ key: 'warnings.library.itemDropped', severity: 'warning', params: { collection, index, reason: 'invalid profile', id } });
    return null;
  }
  const notes = raw['notes'];
  return {
    id, name: str(raw['name']) && raw['name'].length > 0 ? raw['name'] : id, source: sourceOf(raw, id), points,
    segmentLengths: parseSegments(raw['segmentLengths']),
    ...(str(notes) ? { notes } : {}),
  };
}

export function migratePunch(v: unknown, index: number, messages: Message[]): Punch | null {
  if (!isRec(v)) { messages.push({ key: 'warnings.library.itemDropped', severity: 'warning', params: { collection: 'punches', index, reason: 'not an object' } }); return null; }
  const base = toolBase(v, index, 'punches', 'punch', messages);
  if (!base) return null;
  const std = standardItem(base.id);
  const family: PunchFamily = PUNCH_FAMILIES.includes(v['family'] as PunchFamily) ? (v['family'] as PunchFamily) : std?.kind === 'punch' ? std.family : 'custom';
  const needDerive = !isPos(v['tipRadius'], true) || !isWithin(v['tipAngle'], 1, 180) || !isPos(v['bodyWidth']) || !fin(v['tangCentreX']) || !isPos(v['height']);
  const d = needDerive ? derivePunchParams(base.points) : null;
  if (d) forward(messages, d.messages, 'punches', base.id);
  const { points, ...rest } = base;
  return {
    kind: 'punch', ...rest, family,
    profile: { points },
    height: pos(v['height'], d ? d.height : 0),
    maxLoadPerMeter: pos(v['maxLoadPerMeter'], std?.maxLoadPerMeter ?? (family === 'custom' ? CUSTOM_DEFAULT_RATING : PUNCH_RATINGS[family]), true),
    tipRadius: pos(v['tipRadius'], d ? d.tipRadius : 0, true),
    tipAngle: within(v['tipAngle'], 1, 180, d ? d.tipAngle : 88),
    bodyWidth: pos(v['bodyWidth'], d ? d.bodyWidth : 20),
    tangCentreX: num(v['tangCentreX'], d ? d.tangCentreX : 0),
  };
}

export function migrateDie(v: unknown, index: number, messages: Message[]): Die | null {
  if (!isRec(v)) { messages.push({ key: 'warnings.library.itemDropped', severity: 'warning', params: { collection: 'dies', index, reason: 'not an object' } }); return null; }
  const base = toolBase(v, index, 'dies', 'die', messages);
  if (!base) return null;
  const std = standardItem(base.id);
  const family: DieFamily = DIE_FAMILIES.includes(v['family'] as DieFamily) ? (v['family'] as DieFamily) : std?.kind === 'die' ? std.family : 'custom';
  const needDerive = !isPos(v['vWidth'], true) || !isWithin(v['vAngle'], 0, 180) || !isPos(v['shoulderRadius'], true) || !isPos(v['bodyWidth']) || !isPos(v['height']);
  const d = needDerive ? deriveDieParams(base.points) : null;
  if (d) forward(messages, d.messages, 'dies', base.id);
  const vWidth = pos(v['vWidth'], d ? d.vWidth : 0, true);
  const { points, ...rest } = base;
  return {
    kind: 'die', ...rest, family,
    profile: { points },
    height: pos(v['height'], d ? d.height : 0),
    maxLoadPerMeter: pos(v['maxLoadPerMeter'], std?.maxLoadPerMeter ?? (family === 'v' && vWidth > 0 ? standardDieRating(vWidth) : CUSTOM_DEFAULT_RATING), true),
    vWidth,
    vAngle: within(v['vAngle'], 0, 180, d ? d.vAngle : 88),
    shoulderRadius: pos(v['shoulderRadius'], d ? d.shoulderRadius : 0, true),
    bodyWidth: pos(v['bodyWidth'], d ? d.bodyWidth : 60),
  };
}

export function migrateFinger(v: unknown, index: number, messages: Message[]): Finger | null {
  if (!isRec(v)) { messages.push({ key: 'warnings.library.itemDropped', severity: 'warning', params: { collection: 'fingers', index, reason: 'not an object' } }); return null; }
  const base = toolBase(v, index, 'fingers', 'finger', messages);
  if (!base) return null;
  const needDerive = !isPos(v['stopHeight']) || !isPos(v['bodyDepth']) || !isPos(v['height']);
  const d = needDerive ? deriveFingerParams(base.points) : null;
  if (d) forward(messages, d.messages, 'fingers', base.id);
  const { points, ...rest } = base;
  return {
    kind: 'finger', ...rest,
    profile: { points },
    height: pos(v['height'], d ? d.height : 0),
    maxLoadPerMeter: pos(v['maxLoadPerMeter'], 0, true),
    stopHeight: pos(v['stopHeight'], d ? d.stopHeight : 20),
    bodyDepth: pos(v['bodyDepth'], d ? d.bodyDepth : 60),
    width: pos(v['width'], 30),
  };
}

export function migrateMaterial(v: unknown, index: number, messages: Message[]): Material | null {
  if (!isRec(v) || !str(v['id']) || v['id'].length === 0) {
    messages.push({ key: 'warnings.library.itemDropped', severity: 'warning', params: { collection: 'materials', index, reason: 'missing id' } });
    return null;
  }
  const id = v['id'];
  const density = v['density'];
  return {
    id,
    name: str(v['name']) && v['name'].length > 0 ? v['name'] : id,
    tensileStrength: pos(v['tensileStrength'], 420),
    kFactor: within(v['kFactor'], 0.01, 1, 0.44),
    springbackDeg: pos(v['springbackDeg'], 1.5, true),
    minInnerRadiusFactor: pos(v['minInnerRadiusFactor'], 0.8, true),
    ...(fin(density) && density > 0 ? { density } : {}),
  };
}

export function migrateMachine(v: unknown, index: number, messages: Message[]): Machine | null {
  if (!isRec(v) || !str(v['id']) || v['id'].length === 0) {
    messages.push({ key: 'warnings.library.itemDropped', severity: 'warning', params: { collection: 'machines', index, reason: 'missing id' } });
    return null;
  }
  const d = defaultMachine();
  const ram = isRec(v['ram']) ? v['ram'] : {};
  const speeds = isRec(ram['speeds']) ? ram['speeds'] : {};
  const table = isRec(v['table']) ? v['table'] : {};
  const bg = isRec(v['backgauge']) ? v['backgauge'] : {};
  return {
    id: v['id'],
    name: str(v['name']) && v['name'].length > 0 ? v['name'] : v['id'],
    bedLength: num(v['bedLength'], d.bedLength),
    capacity: num(v['capacity'], d.capacity),
    stroke: num(v['stroke'], d.stroke),
    daylight: num(v['daylight'], d.daylight),
    throatDepth: num(v['throatDepth'], d.throatDepth),
    distanceBetweenFrames: num(v['distanceBetweenFrames'], d.distanceBetweenFrames),
    ram: {
      thickness: num(ram['thickness'], d.ram.thickness),
      height: num(ram['height'], d.ram.height),
      clampThickness: num(ram['clampThickness'], d.ram.clampThickness),
      clampHeight: num(ram['clampHeight'], d.ram.clampHeight),
      clampFrontOffset: num(ram['clampFrontOffset'], d.ram.clampFrontOffset),
      speeds: {
        approach: num(speeds['approach'], d.ram.speeds.approach),
        bend: num(speeds['bend'], d.ram.speeds.bend),
        retract: num(speeds['retract'], d.ram.speeds.retract),
      },
    },
    table: {
      width: num(table['width'], d.table.width),
      holderWidth: num(table['holderWidth'], d.table.holderWidth),
      holderHeight: num(table['holderHeight'], d.table.holderHeight),
      height: num(table['height'], d.table.height),
    },
    backgauge: {
      xMin: num(bg['xMin'], d.backgauge.xMin), xMax: num(bg['xMax'], d.backgauge.xMax),
      rMin: num(bg['rMin'], d.backgauge.rMin), rMax: num(bg['rMax'], d.backgauge.rMax),
      zMin: num(bg['zMin'], d.backgauge.zMin), zMax: num(bg['zMax'], d.backgauge.zMax),
      fingerCount: Number.isInteger(bg['fingerCount']) && (bg['fingerCount'] as number) >= 1 ? (bg['fingerCount'] as number) : d.backgauge.fingerCount,
      fingerId: str(bg['fingerId']) && bg['fingerId'].length > 0 ? bg['fingerId'] : d.backgauge.fingerId,
      independentX: typeof bg['independentX'] === 'boolean' ? bg['independentX'] : d.backgauge.independentX,
      independentR: typeof bg['independentR'] === 'boolean' ? bg['independentR'] : d.backgauge.independentR,
      beamDepth: num(bg['beamDepth'], d.backgauge.beamDepth),
      beamHeight: num(bg['beamHeight'], d.backgauge.beamHeight),
      retractAtPinch: num(bg['retractAtPinch'], d.backgauge.retractAtPinch),
      speed: num(bg['speed'], d.backgauge.speed),
    },
    yCorrection: num(v['yCorrection'], d.yCorrection),
  };
}

function collect<T extends { id: string }>(raw: unknown, migrate: (v: unknown, i: number, m: Message[]) => T | null, messages: Message[]): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  raw.forEach((v, i) => {
    const item = migrate(v, i, messages);
    if (!item) return;
    const id = item.id;
    if (seen.has(id)) { messages.push({ key: 'warnings.library.itemDropped', severity: 'warning', params: { collection: 'library', index: i, reason: 'duplicate id', id } }); return; }
    seen.add(id);
    out.push(item);
  });
  return out;
}

/** Validate + fill defaults + bump the version. Throws TypeError for a non-object input. */
export function migrateLibraryDetailed(json: unknown, now: Date = new Date()): MigrationResult {
  if (!isRec(json)) throw new TypeError('library: expected a JSON object');
  const messages: Message[] = [];
  const from = fin(json['version']) ? json['version'] : 0;
  const updatedAt = str(json['updatedAt']) && !Number.isNaN(Date.parse(json['updatedAt'])) ? new Date(json['updatedAt']).toISOString() : now.toISOString();
  const library: ToolLibrary = {
    punches: collect(json['punches'], migratePunch, messages),
    dies: collect(json['dies'], migrateDie, messages),
    fingers: collect(json['fingers'], migrateFinger, messages),
    materials: collect(json['materials'], migrateMaterial, messages),
    machines: collect(json['machines'], migrateMachine, messages),
    version: LIBRARY_VERSION,
    revision: fin(json['revision']) && json['revision'] >= 0 ? Math.floor(json['revision']) : 0,
    updatedAt,
  };
  // a file from a NEWER app version is read best-effort (unknown fields dropped) → warn rather than inform
  if (from !== LIBRARY_VERSION) messages.push({ key: 'warnings.library.migrated', severity: from > LIBRARY_VERSION ? 'warning' : 'info', params: { from, to: LIBRARY_VERSION } });
  return { library, messages };
}

export function migrateLibrary(json: unknown): ToolLibrary {
  return migrateLibraryDetailed(json).library;
}

/** Union by id per collection; `overlay` wins on conflicts; revision = the larger one. */
export function mergeLibraries(base: ToolLibrary, overlay: ToolLibrary): ToolLibrary {
  const merge = <T extends { id: string }>(a: T[], b: T[]): T[] => {
    const map = new Map<string, T>();
    for (const x of a) map.set(x.id, x);
    for (const x of b) map.set(x.id, x);
    return [...map.values()];
  };
  return {
    punches: merge(base.punches, overlay.punches),
    dies: merge(base.dies, overlay.dies),
    fingers: merge(base.fingers, overlay.fingers),
    materials: merge(base.materials, overlay.materials),
    machines: merge(base.machines, overlay.machines),
    version: LIBRARY_VERSION,
    revision: Math.max(base.revision, overlay.revision),
    updatedAt: base.updatedAt > overlay.updatedAt ? base.updatedAt : overlay.updatedAt,
  };
}

/** Add every standard item missing from `lib` (new app versions ship new tools). */
export function withStandardItems(lib: ToolLibrary): ToolLibrary {
  const std = buildStandardLibrary();
  const fill = <T extends { id: string }>(have: T[], standard: T[]): T[] => {
    const ids = new Set(have.map(x => x.id));
    return [...have, ...standard.filter(x => !ids.has(x.id))];
  };
  return {
    ...lib,
    punches: fill(lib.punches, std.punches),
    dies: fill(lib.dies, std.dies),
    fingers: fill(lib.fingers, std.fingers),
    materials: fill(lib.materials, std.materials),
    machines: fill(lib.machines, std.machines),
  };
}
