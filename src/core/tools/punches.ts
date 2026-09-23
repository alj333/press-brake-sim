/**
 * Parametric punch generators (Promecam / European style). Profiles are closed CCW polygons in
 * the punch frame: tip at the origin, +Y up toward the clamp, +X toward the machine back,
 * y ∈ [0, height]. See docs/specs/tooling-machine.md §1.1.
 */
import type { Punch, PunchFamily, ToolSource, Vec2 } from '../types';
import { finishProfile, roundTo, tipArc } from './profile';

const DEG = Math.PI / 180;

/** Standard European segment set (mm) plus a full 3 m bar. */
export const STANDARD_SEGMENT_LENGTHS: readonly number[] = [10, 15, 20, 40, 50, 100, 200, 300, 415, 835, 3000];

/** Default ratings (kN/m) per punch family. */
export const PUNCH_RATINGS: Record<PunchFamily, number> = {
  straight: 1000, gooseneck: 600, acute: 400, radius: 800, hemming: 800, custom: 600,
};

export interface PunchMeta {
  id?: string;
  name?: string;
  maxLoadPerMeter?: number;
  segmentLengths?: number[];
  notes?: string;
  source?: ToolSource;
  family?: PunchFamily;
}

export interface StraightPunchParams {
  tipRadius?: number;   // default 0.8
  tipAngle?: number;    // included angle, default 88
  height?: number;      // default 120
  bodyWidth?: number;   // default 20
}

function slug(v: number): string { return String(roundTo(v, 3)); }

/** Parameter guards shared by the generators (they never throw; nonsense becomes the nearest sane value). */
function tipParams(p: { tipRadius?: number; tipAngle?: number; height?: number }, defaults: { tipRadius: number; tipAngle: number; height: number; minHeight: number }): { tipRadius: number; tipAngle: number; height: number } {
  const r = p.tipRadius ?? defaults.tipRadius, a = p.tipAngle ?? defaults.tipAngle, h = p.height ?? defaults.height;
  return {
    tipRadius: Number.isFinite(r) && r > 0 ? r : 0,
    tipAngle: Number.isFinite(a) ? Math.min(180, Math.max(1, a)) : defaults.tipAngle,
    height: Number.isFinite(h) && h >= defaults.minHeight ? h : Number.isFinite(h) && h > 0 ? defaults.minHeight : defaults.height,
  };
}

function makePunch(
  family: PunchFamily, points: Vec2[], p: { tipRadius: number; tipAngle: number; height: number; bodyWidth: number; tangCentreX: number },
  meta: PunchMeta, defaultId: string, defaultName: string,
): Punch {
  return {
    kind: 'punch',
    id: meta.id ?? defaultId,
    name: meta.name ?? defaultName,
    source: meta.source ?? 'standard',
    family: meta.family ?? family,
    height: p.height,
    maxLoadPerMeter: meta.maxLoadPerMeter ?? PUNCH_RATINGS[meta.family ?? family],
    segmentLengths: meta.segmentLengths ?? [...STANDARD_SEGMENT_LENGTHS],
    profile: finishProfile(points.map(q => ({ x: roundTo(q.x), y: roundTo(q.y) }))),
    tipRadius: p.tipRadius,
    tipAngle: p.tipAngle,
    bodyWidth: p.bodyWidth,
    tangCentreX: p.tangCentreX,
    ...(meta.notes !== undefined ? { notes: meta.notes } : {}),
  };
}

/**
 * Straight punch: rounded tip, flanks at ±tipAngle/2 from vertical until the half-width reaches
 * bodyWidth/2, then a vertical body up to the tang top at y = height.
 */
export function straightPunch(params: StraightPunchParams = {}, meta: PunchMeta = {}): Punch {
  const { tipRadius, tipAngle, height } = tipParams(params, { tipRadius: 0.8, tipAngle: 88, height: 120, minHeight: 2 });
  const alpha = tipAngle / 2;
  const arc = tipArc(tipRadius, alpha);
  const tR = arc[arc.length - 1]!;
  const tanA = Math.tan(alpha * DEG);
  let halfW = (Number.isFinite(params.bodyWidth) && (params.bodyWidth ?? 0) > 0 ? params.bodyWidth! : 20) / 2;
  if (halfW < tR.x + 0.5) halfW = tR.x + 0.5;                       // body cannot be narrower than the tip arc
  let yBody = tanA > 1e-9 ? tR.y + (halfW - tR.x) / tanA : height;  // where the flank meets the body side
  let points: Vec2[];
  if (yBody >= height - 1) {
    // wedge all the way up: cut at the tang top
    const xTop = tR.x + (height - tR.y) * tanA;
    halfW = xTop;
    yBody = height;
    points = [...arc, { x: xTop, y: height }, { x: -xTop, y: height }];
  } else {
    points = [
      ...arc,
      { x: halfW, y: yBody }, { x: halfW, y: height },
      { x: -halfW, y: height }, { x: -halfW, y: yBody },
    ];
  }
  const family = meta.family ?? 'straight';
  return makePunch(family, points, { tipRadius, tipAngle, height, bodyWidth: 2 * halfW, tangCentreX: 0 }, meta,
    `std:punch-${family}-${slug(tipAngle)}-r${slug(tipRadius)}`,
    `${family === 'acute' ? 'Acute' : 'Straight'} punch ${slug(tipAngle)}° R${slug(tipRadius)} H${slug(height)}`);
}

export interface GooseneckPunchParams { tipRadius?: number; tipAngle?: number; height?: number }

/** Reference gooseneck outline above the nose (height 120), ARCHITECTURE "Tooling & machine". */
const GOOSENECK_BODY: readonly Vec2[] = [
  { x: 6, y: 25 }, { x: 26, y: 55 }, { x: 26, y: 120 }, { x: -12, y: 120 }, { x: -12, y: 92 },
  { x: 4, y: 70 }, { x: 6, y: 45 }, { x: -7, y: 28 },
];

/**
 * Gooseneck punch: short nose (x ∈ [−6, 6]), relief cut back above the nose toward −X (the
 * operator side), load-bearing back toward +X; tang x ∈ [−12, 26] ⇒ tangCentreX = 7.
 */
export function gooseneckPunch(params: GooseneckPunchParams = {}, meta: PunchMeta = {}): Punch {
  // the nose is 25 high and the body above it is scaled: below 45 mm the outline would fold over;
  // the flanks must reach x = ±6 below the nose top (tip angle ≥ 28°) and the tip arc must fit
  // inside the 12 mm nose
  const p = tipParams(params, { tipRadius: 0.8, tipAngle: 88, height: 120, minHeight: 45 });
  const tipAngle = Math.max(28, p.tipAngle), height = p.height;
  const alpha = tipAngle / 2;
  const noseHalf = 6;
  const tipRadius = Math.min(p.tipRadius, Math.max(0, (noseHalf - 2 * Math.sin(alpha * DEG)) / Math.cos(alpha * DEG)));
  const arc = tipArc(tipRadius, alpha);
  const tR = arc[arc.length - 1]!;
  const tanA = Math.tan(alpha * DEG);
  const yFlank = tR.y + (noseHalf - tR.x) / tanA;
  const sy = (y: number): number => (y <= 25 ? y : 25 + ((y - 25) * (height - 25)) / 95);
  const points: Vec2[] = [
    ...arc,
    { x: noseHalf, y: yFlank },
    ...GOOSENECK_BODY.map(p => ({ x: p.x, y: sy(p.y) })),
    { x: -noseHalf, y: yFlank },
  ];
  return makePunch('gooseneck', points, { tipRadius, tipAngle, height, bodyWidth: 38, tangCentreX: 7 }, meta,
    `std:punch-gooseneck-${slug(tipAngle)}-r${slug(tipRadius)}`, `Gooseneck punch ${slug(tipAngle)}° R${slug(tipRadius)} H${slug(height)}`);
}

export interface AcutePunchParams { tipAngle?: number; tipRadius?: number; height?: number; bodyWidth?: number }

/** Acute (sash) punch: 30° (or 28°) tip, long slender nose. */
export function acutePunch(params: AcutePunchParams = {}, meta: PunchMeta = {}): Punch {
  const tipAngle = params.tipAngle ?? 30;
  const tipRadius = params.tipRadius ?? 0.8;
  return straightPunch({ tipAngle, tipRadius, height: params.height ?? 120, bodyWidth: params.bodyWidth ?? 20 },
    { ...meta, family: meta.family ?? 'acute' });
}

export interface RadiusPunchParams { radius: number; tipAngle?: number; height?: number; bodyWidth?: number }

/** Radius punch: large tip radius (R3/R5/R10) with 88° flanks. */
export function radiusPunch(params: RadiusPunchParams, meta: PunchMeta = {}): Punch {
  const bodyWidth = params.bodyWidth ?? Math.max(20, Math.ceil(2 * params.radius) + 6);
  return straightPunch({ tipRadius: params.radius, tipAngle: params.tipAngle ?? 88, height: params.height ?? 120, bodyWidth }, {
    ...meta,
    family: meta.family ?? 'radius',
    id: meta.id ?? `std:punch-radius-r${slug(params.radius)}`,
    name: meta.name ?? `Radius punch R${slug(params.radius)} H${params.height ?? 120}`,
  });
}

export interface HemmingPunchParams { faceWidth?: number; height?: number }

/** Flat-faced flattening (hemming) punch: tipAngle 180 — never usable for air bending. */
export function hemmingPunch(params: HemmingPunchParams = {}, meta: PunchMeta = {}): Punch {
  const w = Number.isFinite(params.faceWidth) && (params.faceWidth ?? 0) > 0 ? params.faceWidth! : 30;
  const h = Number.isFinite(params.height) && (params.height ?? 0) > 0 ? params.height! : 120;
  const points: Vec2[] = [{ x: -w / 2, y: 0 }, { x: 0, y: 0 }, { x: w / 2, y: 0 }, { x: w / 2, y: h }, { x: -w / 2, y: h }];
  return makePunch('hemming', points, { tipRadius: 0, tipAngle: 180, height: h, bodyWidth: w, tangCentreX: 0 }, meta,
    'std:punch-hemming', `Hemming (flattening) punch ${w} H${h}`);
}
