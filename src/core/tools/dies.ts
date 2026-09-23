/**
 * Parametric die generators. Profiles are closed CCW polygons in the die frame: origin at the
 * V centre on the shoulder plane (top surface), +Y up, y ∈ [−height, 0].
 * See docs/specs/tooling-machine.md §1.2.
 */
import type { Die, DieFamily, ToolSource, Vec2 } from '../types';
import { arcToPoints } from '../geom';
import { TOOL_CHORD_TOL, finishProfile, roundTo } from './profile';
import { STANDARD_SEGMENT_LENGTHS } from './punches';

const DEG = Math.PI / 180;

export interface DieMeta {
  id?: string;
  name?: string;
  maxLoadPerMeter?: number;
  segmentLengths?: number[];
  notes?: string;
  source?: ToolSource;
  family?: DieFamily;
}

/** bodyWidth = max(60, V + 2·max(10, 0.25·V)) rounded up to 10 mm. */
export function standardDieBodyWidth(vWidth: number): number {
  return Math.ceil(Math.max(60, vWidth + 2 * Math.max(10, 0.25 * vWidth)) / 10 - 1e-9) * 10;
}

/** height 60 (V ≤ 25), 90 (V ≤ 50), 100 above. */
export function standardDieHeight(vWidth: number): number {
  return vWidth <= 25 ? 60 : vWidth <= 50 ? 90 : 100;
}

/** shoulder radius = V/10 rounded to the nearest 0.5 mm (V16 → 1.5, V12 → 1.0). */
export function standardShoulderRadius(vWidth: number): number {
  return Math.round((vWidth / 10) * 2) / 2;
}

/** maxLoadPerMeter: V6 300, V8 400, V10 600, V ≥ 12 1000 kN/m. */
export function standardDieRating(vWidth: number): number {
  return vWidth < 8 ? 300 : vWidth < 10 ? 400 : vWidth < 12 ? 600 : 1000;
}

/** Depth of a sharp V below the shoulder plane: (V/2)/tan(vAngle/2). */
export function vNotchDepth(vWidth: number, vAngle: number): number {
  const beta = (vAngle / 2) * DEG;
  return Math.tan(beta) > 1e-12 ? (vWidth / 2) / Math.tan(beta) : 0;
}

/** Largest shoulder radius whose fillet takes at most half of the V face (foot at s = rs·(1 − sin β)/cos β along the face). */
export function maxShoulderRadius(vWidth: number, vAngle: number): number {
  const beta = (vAngle / 2) * DEG;
  const faceLength = (vWidth / 2) / Math.sin(beta);
  const k = (1 - Math.sin(beta)) / Math.cos(beta);
  return k > 1e-12 ? (0.5 * faceLength) / k : Infinity;
}

/** X of the fillet's top tangent point (the flat shoulder starts here): V/2 + rs·(1 − sin β)/cos β. */
export function shoulderTangentX(vWidth: number, vAngle: number, shoulderRadius: number): number {
  const beta = (vAngle / 2) * DEG;
  return vWidth / 2 + (Math.max(0, shoulderRadius) * (1 - Math.sin(beta))) / Math.cos(beta);
}

/** Guards applied by every V generator: angle in (0, 180], V ≥ 0, fillet radius that fits the face. */
function vParams(vWidth: number, vAngle: number, shoulderRadius: number): { vWidth: number; vAngle: number; shoulderRadius: number } {
  const v = Number.isFinite(vWidth) && vWidth > 0 ? vWidth : 0;
  const a = Number.isFinite(vAngle) ? Math.min(180, Math.max(1, vAngle)) : 88;
  const rsRaw = Number.isFinite(shoulderRadius) && shoulderRadius > 0 ? shoulderRadius : 0;
  const rs = v > 0 && a < 180 ? Math.min(rsRaw, maxShoulderRadius(v, a)) : 0;
  return { vWidth: v, vAngle: a, shoulderRadius: rs };
}

/**
 * Top edge of a V die from (+halfBody, 0) to (−halfBody, 0) through the notch (CCW order for a
 * body below y = 0): right shoulder → right fillet → right V face → bottom vertex → left V face →
 * left fillet → left shoulder. The V faces pass through the virtual sharp shoulders (±V/2, 0).
 * `halfBody` must exceed the shoulder tangent x (see `shoulderTangentX`); the generators ensure it.
 */
export function vNotchTopEdge(vWidth: number, vAngle: number, shoulderRadius: number, halfBody: number): Vec2[] {
  const beta = (vAngle / 2) * DEG;
  const half = vWidth / 2;
  const depth = vNotchDepth(vWidth, vAngle);
  const rs = Math.max(0, shoulderRadius);
  const pts: Vec2[] = [{ x: halfBody, y: 0 }];
  if (rs > 0) {
    const xc = half + (rs * (1 - Math.sin(beta))) / Math.cos(beta);
    // right fillet: centre (xc, −rs), from 90° (top tangent) to 180° − β (face tangent), CCW
    const right = arcToPoints({ x: xc, y: -rs }, rs, 90, 180 - vAngle / 2, true, TOOL_CHORD_TOL);
    pts.push(...right);
    pts.push({ x: 0, y: -depth });
    // left fillet: centre (−xc, −rs), from β (face tangent) to 90° (top tangent), CCW
    const left = arcToPoints({ x: -xc, y: -rs }, rs, vAngle / 2, 90, true, TOOL_CHORD_TOL);
    pts.push(...left);
  } else {
    pts.push({ x: half, y: 0 }, { x: 0, y: -depth }, { x: -half, y: 0 });
  }
  pts.push({ x: -halfBody, y: 0 });
  return pts.map(p => ({ x: roundTo(p.x), y: roundTo(p.y) }));
}

function makeDie(
  family: DieFamily, points: Vec2[], p: { vWidth: number; vAngle: number; shoulderRadius: number; height: number; bodyWidth: number },
  meta: DieMeta, defaultId: string, defaultName: string, defaultRating: number,
): Die {
  return {
    kind: 'die',
    id: meta.id ?? defaultId,
    name: meta.name ?? defaultName,
    source: meta.source ?? 'standard',
    family: meta.family ?? family,
    height: p.height,
    maxLoadPerMeter: meta.maxLoadPerMeter ?? defaultRating,
    segmentLengths: meta.segmentLengths ?? [...STANDARD_SEGMENT_LENGTHS],
    profile: finishProfile(points),
    vWidth: p.vWidth,
    vAngle: p.vAngle,
    shoulderRadius: p.shoulderRadius,
    bodyWidth: p.bodyWidth,
    ...(meta.notes !== undefined ? { notes: meta.notes } : {}),
  };
}

export interface VDieParams {
  vWidth: number;
  vAngle?: number;          // default 88
  shoulderRadius?: number;  // default standardShoulderRadius(V)
  height?: number;          // default standardDieHeight(V)
  bodyWidth?: number;       // default standardDieBodyWidth(V)
}

/**
 * Single-V die block with rounded shoulders. Heights/body widths too small for the notch are
 * enlarged (rounded up to 10 mm) so the profile is always a simple polygon.
 */
export function vDie(params: VDieParams, meta: DieMeta = {}): Die {
  const { vWidth, vAngle, shoulderRadius } = vParams(params.vWidth, params.vAngle ?? 88, params.shoulderRadius ?? standardShoulderRadius(params.vWidth));
  const depth = vNotchDepth(vWidth, vAngle);
  const ceil10 = (v: number): number => Math.ceil(v / 10 - 1e-9) * 10;
  const heightRaw = Number.isFinite(params.height) && (params.height ?? 0) > 0 ? params.height! : standardDieHeight(vWidth);
  const height = heightRaw >= depth + 5 ? heightRaw : ceil10(depth + 5);
  const minBody = 2 * (shoulderTangentX(vWidth, vAngle, shoulderRadius) + 2);
  const bodyRaw = Number.isFinite(params.bodyWidth) && (params.bodyWidth ?? 0) > 0 ? params.bodyWidth! : standardDieBodyWidth(vWidth);
  const bodyWidth = bodyRaw >= minBody ? bodyRaw : ceil10(minBody);
  const hb = bodyWidth / 2;
  const points: Vec2[] = [
    { x: -hb, y: -height }, { x: hb, y: -height },
    ...vNotchTopEdge(vWidth, vAngle, shoulderRadius, hb),
  ];
  const vs = String(roundTo(vWidth, 3)), as = String(roundTo(vAngle, 3));
  return makeDie('v', points, { vWidth, vAngle, shoulderRadius, height, bodyWidth }, meta,
    `std:die-v${vs}-${as}`, `V${vs} die ${as}° R${shoulderRadius} H${height}`, standardDieRating(vWidth));
}

export interface MultiVDieParams {
  vWidths?: [number, number, number, number]; // default [16, 22, 35, 50]
  active?: number;                            // index of the V on top, default 0
  vAngle?: number;                            // default 88
  size?: number;                              // block size, default 90
}

/** Rating for the 4-way block (weaker than a solid V die). */
export const MULTI_V_RATING = 600;

function rotateAbout(p: Vec2, c: Vec2, deg: number): Vec2 {
  const r = deg * DEG, cs = Math.cos(r), sn = Math.sin(r);
  const x = p.x - c.x, y = p.y - c.y;
  return { x: roundTo(c.x + x * cs - y * sn), y: roundTo(c.y + x * sn + y * cs) };
}

/**
 * 4-way multi-V block (size × size): the active V on top at the origin, the next V (index + 1)
 * on the right side (+X), + 2 on the bottom, + 3 on the left. Every V has the standard shoulder
 * radius for its width.
 */
export function multiVDie(params: MultiVDieParams = {}, meta: DieMeta = {}): Die {
  const raw = params.vWidths ?? [16, 22, 35, 50];
  const active = Number.isInteger(params.active) ? (((params.active ?? 0) % 4) + 4) % 4 : 0;
  const vAngle = Number.isFinite(params.vAngle) ? Math.min(179, Math.max(1, params.vAngle!)) : 88;
  const vs = raw.map(v => vParams(v, vAngle, standardShoulderRadius(v)));
  // the block must be wide enough for every notch's shoulders and deep enough for two opposite notches
  let size = Number.isFinite(params.size) && (params.size ?? 0) > 0 ? params.size! : 90;
  const need = Math.max(
    ...vs.map(v => 2 * (shoulderTangentX(v.vWidth, v.vAngle, v.shoulderRadius) + 2)),
    vNotchDepth(vs[0]!.vWidth, vAngle) + vNotchDepth(vs[2]!.vWidth, vAngle) + 10,
    vNotchDepth(vs[1]!.vWidth, vAngle) + vNotchDepth(vs[3]!.vWidth, vAngle) + 10,
  );
  if (size < need) size = Math.ceil(need / 10 - 1e-9) * 10;
  const half = size / 2;
  const centre = { x: 0, y: -half };
  const edge = (i: number): Vec2[] => vNotchTopEdge(vs[i]!.vWidth, vs[i]!.vAngle, vs[i]!.shoulderRadius, half);
  const top = edge(active);
  const right = edge((active + 1) % 4).map(p => rotateAbout(p, centre, -90));
  const bottom = edge((active + 2) % 4).map(p => rotateAbout(p, centre, 180));
  const left = edge((active + 3) % 4).map(p => rotateAbout(p, centre, 90));
  // CCW: bottom (left → right), right side (bottom → top), top (right → left), left side (top → bottom)
  const points: Vec2[] = [...bottom, ...right, ...top, ...left];
  const v = vs[active]!;
  const label = vs.map(x => roundTo(x.vWidth, 3)).join('/');
  return makeDie('multi-v', points, { vWidth: v.vWidth, vAngle: v.vAngle, shoulderRadius: v.shoulderRadius, height: size, bodyWidth: size }, meta,
    `std:die-multi-v${roundTo(v.vWidth, 3)}`, `Multi-V ${label} block — V${roundTo(v.vWidth, 3)} up`, MULTI_V_RATING);
}

export interface HemmingDieParams { width?: number; height?: number }

/** Flat-topped hemming (flattening) die: no V (vWidth 0, vAngle 180). */
export function hemmingDie(params: HemmingDieParams = {}, meta: DieMeta = {}): Die {
  const w = Number.isFinite(params.width) && (params.width ?? 0) > 0 ? params.width! : 60;
  const h = Number.isFinite(params.height) && (params.height ?? 0) > 0 ? params.height! : 60;
  const points: Vec2[] = [{ x: -w / 2, y: -h }, { x: w / 2, y: -h }, { x: w / 2, y: 0 }, { x: 0, y: 0 }, { x: -w / 2, y: 0 }];
  return makeDie('hemming', points, { vWidth: 0, vAngle: 180, shoulderRadius: 0, height: h, bodyWidth: w }, meta,
    'std:die-hemming', `Hemming (flattening) die ${w} H${h}`, 800);
}
