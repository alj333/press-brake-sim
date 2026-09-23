/**
 * Custom (on-site) tools from a DXF cross-section: normalise the point list into the tool frame,
 * then build a Punch / Die / Finger with derived parameters. See docs/specs/tooling-machine.md §1.4.
 */
import type { Die, DieFamily, Finger, Message, Polygon2, Punch, PunchFamily, ToolProfile, Vec2 } from '../types';
import { area, dedupe, ensureCCW } from '../geom';
import { derivePunchParams, deriveDieParams, deriveFingerParams } from './derive';
import { isSimplePolygon, profileExtent, roundTo } from './profile';
import { PUNCH_RATINGS } from './punches';

export type ToolKind = 'punch' | 'die' | 'finger';
export type ProfileUpDir = 'y+' | 'y-' | 'x+' | 'x-';

export interface NormalizeProfileOptions {
  kind: ToolKind;
  /** Point of the drawing (in its own units, before `scale`) that becomes the tool origin. */
  referencePoint?: Vec2;
  /** Drawing direction that should point up (+Y) in the tool frame. Default 'y+'. */
  upDir?: ProfileUpDir;
  /** Mirror x → −x after rotation (e.g. a gooseneck drawn with the relief toward +X). */
  mirrorX?: boolean;
  /** Unit scale applied first (e.g. 25.4 for inch drawings). Default 1. */
  scale?: number;
}

export interface NormalizedProfile {
  profile: ToolProfile;
  height: number;
  /** Extra translation applied after the reference point to satisfy the y-extent rule. */
  shift: Vec2;
  messages: Message[];
}

const ROTATION_DEG: Record<ProfileUpDir, number> = { 'y+': 0, 'x+': 90, 'y-': 180, 'x-': -90 };

function rotate(p: Vec2, deg: number): Vec2 {
  if (deg === 0) return p;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Default reference (tool origin) of a profile already rotated/mirrored into the tool orientation. */
function autoReference(kind: ToolKind, pts: Polygon2): Vec2 {
  const ext = profileExtent(pts);
  const tol = 0.01;
  if (kind === 'punch') {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) if (p.y <= ext.minY + tol) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
    return { x: (lo + hi) / 2, y: ext.minY };
  }
  if (kind === 'die') {
    const d = deriveDieParams(pts);
    return { x: d.vCentreX, y: d.topY };
  }
  let lo = Infinity;
  for (const p of pts) if (p.x <= ext.minX + tol) lo = Math.min(lo, p.y);
  return { x: ext.minX, y: lo };
}

/**
 * Place a raw profile point list in the tool frame: scale → translate the reference point to the
 * origin → rotate so `upDir` is +Y → mirror → dedupe + CCW → enforce the y-extent rule of the kind
 * (punch/finger y ≥ 0 with min y = 0, finger also min x = 0; die max y = 0), reporting any shift.
 * Never throws; problems come back as messages (severity 'error' for unusable profiles).
 */
export function normalizeProfile(points: Vec2[], opts: NormalizeProfileOptions): NormalizedProfile {
  const messages: Message[] = [];
  const scale = Number.isFinite(opts.scale) && (opts.scale ?? 1) > 0 ? (opts.scale ?? 1) : 1;
  const rot = ROTATION_DEG[opts.upDir ?? 'y+'];
  const mirror = opts.mirrorX === true;
  const ref = opts.referencePoint && Number.isFinite(opts.referencePoint.x) && Number.isFinite(opts.referencePoint.y) ? opts.referencePoint : undefined;
  const finite = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finite.length < points.length) {
    messages.push({ key: 'warnings.tool.profileInvalidPoints', severity: 'warning', params: { count: points.length - finite.length } });
  }
  let pts: Vec2[] = finite.map(p => {
    let q: Vec2 = { x: p.x * scale, y: p.y * scale };
    if (ref) q = { x: q.x - ref.x * scale, y: q.y - ref.y * scale };
    q = rotate(q, rot);
    if (mirror) q = { x: -q.x, y: q.y };
    return q;
  });
  pts = ensureCCW(dedupe(pts, 1e-3));
  if (pts.length < 3) {
    messages.push({ key: 'warnings.tool.profileTooFewPoints', severity: 'error', params: { count: pts.length } });
    return { profile: { points: pts }, height: 0, shift: { x: 0, y: 0 }, messages };
  }
  if (!isSimplePolygon(pts)) messages.push({ key: 'warnings.tool.profileSelfIntersecting', severity: 'error' });
  else if (area(pts) < 1e-6) messages.push({ key: 'warnings.tool.profileDegenerate', severity: 'error' });
  if (!ref) {
    const auto = autoReference(opts.kind, pts);
    pts = pts.map(p => ({ x: p.x - auto.x, y: p.y - auto.y }));
  }
  // y-extent rule
  const ext = profileExtent(pts);
  let dx = 0, dy = 0;
  if (opts.kind === 'die') dy = -ext.maxY;
  else dy = -ext.minY;
  if (opts.kind === 'finger') dx = -ext.minX;
  if (Math.abs(dx) < 1e-6) dx = 0;
  if (Math.abs(dy) < 1e-6) dy = 0;
  if (dx !== 0 || dy !== 0) {
    pts = pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    messages.push({ key: 'warnings.tool.profileShifted', severity: 'info', params: { kind: opts.kind, dx: roundTo(dx, 3), dy: roundTo(dy, 3) } });
  }
  pts = pts.map(p => ({ x: roundTo(p.x, 6), y: roundTo(p.y, 6) }));
  const e2 = profileExtent(pts);
  return { profile: { points: pts }, height: roundTo(e2.maxY - e2.minY, 6), shift: { x: dx, y: dy }, messages };
}

/** 'custom:<uuid>' — crypto.randomUUID when available, Math.random v4 otherwise. */
export function newCustomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try { return `custom:${c.randomUUID()}`; } catch { /* fall through */ }
  }
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += hex[8 + Math.floor(Math.random() * 4)];
    else s += hex[Math.floor(Math.random() * 16)];
  }
  return `custom:${s}`;
}

export interface CustomToolMeta {
  id?: string;
  name?: string;
  notes?: string;
  maxLoadPerMeter?: number;
  segmentLengths?: number[];
}

export interface CustomPunchMeta extends CustomToolMeta {
  family?: PunchFamily;
  tipRadius?: number;
  tipAngle?: number;
  bodyWidth?: number;
  tangCentreX?: number;
}

export interface CustomDieMeta extends CustomToolMeta {
  family?: DieFamily;
  vWidth?: number;
  vAngle?: number;
  shoulderRadius?: number;
  bodyWidth?: number;
}

export interface CustomFingerMeta extends CustomToolMeta {
  stopHeight?: number;
  bodyDepth?: number;
  width?: number;
}

function profilePoints(profile: ToolProfile | Polygon2): Polygon2 {
  return Array.isArray(profile) ? profile : profile.points;
}

/**
 * Shift a profile so that it satisfies the y-extent rule of its kind (punch/finger min y = 0,
 * finger also min x = 0, die max y = 0). Already-normalised profiles come back unchanged (same
 * array), so `normalizeProfile` output is not touched twice.
 */
export function enforceFrameExtents(points: Polygon2, kind: ToolKind): Polygon2 {
  const pts = ensureCCW(points);
  if (pts.length === 0) return pts;
  const ext = profileExtent(pts);
  const dy = kind === 'die' ? -ext.maxY : -ext.minY;
  const dx = kind === 'finger' ? -ext.minX : 0;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return pts;
  return pts.map(p => ({ x: roundTo(p.x + dx, 6), y: roundTo(p.y + dy, 6) }));
}

/** Default rating for a custom tool of unknown family (kN/m). */
export const CUSTOM_DEFAULT_RATING = 600;

export function createCustomPunch(profile: ToolProfile | Polygon2, meta: CustomPunchMeta = {}): Punch {
  const pts = enforceFrameExtents(profilePoints(profile), 'punch');
  const d = derivePunchParams(pts);
  const family = meta.family ?? 'custom';
  return {
    kind: 'punch',
    id: meta.id ?? newCustomId(),
    name: meta.name ?? 'Custom punch',
    source: 'custom',
    family,
    height: roundTo(d.height, 6),
    maxLoadPerMeter: meta.maxLoadPerMeter ?? (family === 'custom' ? CUSTOM_DEFAULT_RATING : PUNCH_RATINGS[family]),
    segmentLengths: meta.segmentLengths ?? [],
    profile: { points: pts },
    tipRadius: meta.tipRadius ?? roundTo(d.tipRadius, 3),
    tipAngle: meta.tipAngle ?? roundTo(d.tipAngle, 2),
    bodyWidth: meta.bodyWidth ?? roundTo(d.bodyWidth, 3),
    tangCentreX: meta.tangCentreX ?? roundTo(d.tangCentreX, 3),
    ...(meta.notes !== undefined ? { notes: meta.notes } : {}),
  };
}

export function createCustomDie(profile: ToolProfile | Polygon2, meta: CustomDieMeta = {}): Die {
  const pts = enforceFrameExtents(profilePoints(profile), 'die');
  const d = deriveDieParams(pts);
  return {
    kind: 'die',
    id: meta.id ?? newCustomId(),
    name: meta.name ?? 'Custom die',
    source: 'custom',
    family: meta.family ?? (d.hasNotch ? 'custom' : 'hemming'),
    height: roundTo(d.height, 6),
    maxLoadPerMeter: meta.maxLoadPerMeter ?? CUSTOM_DEFAULT_RATING,
    segmentLengths: meta.segmentLengths ?? [],
    profile: { points: pts },
    vWidth: meta.vWidth ?? roundTo(d.vWidth, 3),
    vAngle: meta.vAngle ?? roundTo(d.vAngle, 2),
    shoulderRadius: meta.shoulderRadius ?? roundTo(d.shoulderRadius, 3),
    bodyWidth: meta.bodyWidth ?? roundTo(d.bodyWidth, 3),
    ...(meta.notes !== undefined ? { notes: meta.notes } : {}),
  };
}

export function createCustomFinger(profile: ToolProfile | Polygon2, meta: CustomFingerMeta = {}): Finger {
  const pts = enforceFrameExtents(profilePoints(profile), 'finger');
  const d = deriveFingerParams(pts);
  return {
    kind: 'finger',
    id: meta.id ?? newCustomId(),
    name: meta.name ?? 'Custom finger',
    source: 'custom',
    height: roundTo(d.height, 6),
    maxLoadPerMeter: meta.maxLoadPerMeter ?? 0,
    segmentLengths: meta.segmentLengths ?? [],
    profile: { points: pts },
    stopHeight: meta.stopHeight ?? roundTo(d.stopHeight, 3),
    bodyDepth: meta.bodyDepth ?? roundTo(d.bodyDepth, 3),
    width: meta.width ?? 30,
    ...(meta.notes !== undefined ? { notes: meta.notes } : {}),
  };
}
