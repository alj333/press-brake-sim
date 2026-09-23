/**
 * Station selection per bend (ARCHITECTURE "Bend-sequence planner" §1, docs/specs/planner.md §1):
 * angle feasibility, V preference, station length, Z-clearance (usable punch length from the
 * flat pattern and the folded geometry), punch segments and position.
 */
import type { Message, Polygon2, Vec2 } from '../types';
import { vec2, mat4, pointInPolygon } from '../geom';
import type { SilhouettePiece } from '../part';
import {
  actualInnerRadius, airBendForce, hemFlattenForce, minLeg, overbend, ramDepth, recommendedV, springback, toolAngleFeasible,
} from '../bend';
import { toolLoadCheck } from '../tools';
import type { ToolLoadCheck } from '../tools';
import type { BendInfo, PlanContext, StationInfo } from './context';
import type { PlacementDetails } from './placement';

/** Clearance kept between the punch piece and the nearest obstacle on each side (mm). */
export const PUNCH_CLEARANCE = 1;
/** A hem pre-bend must reach at least this angle from flat (deg) for the flattening to close it. */
export const HEM_PREBEND_MIN = 135;

/** Per (bend, station) numbers that do not depend on the placement. */
export interface BendStationMaths {
  /** Angle from flat that is air-bent on this station (the pre-bend angle for hems). */
  formAngle: number;
  riActual: number;
  springback: number;
  overbendAngle: number;
  loadedIncludedAngle: number;
  /** toolAngleFeasible (with the 1° margin): false ⇒ bottoming. */
  angleOk: boolean;
  /** The tools physically fit inside the loaded angle (no margin): false ⇒ infeasible. */
  angleFits: boolean;
  ramDepth: number;
  force: number;
  forcePerMeter: number;
  load: ToolLoadCheck;
  minLeg: number;
  /** |V − recommended| / recommended (0 = ideal). */
  vPreference: number;
  hemFlatten: boolean;
}

function hemPreBendAngle(ctx: PlanContext, b: BendInfo, st: StationInfo, riActual: number): number {
  const maxTool = Math.max(st.punch.tipAngle, st.die.vAngle);
  const corr = b.bend.angleCorrection ?? 0;
  let angle = Math.min(b.formAngle, 179 - maxTool - corr);
  for (let i = 0; i < 3; i++) {
    const sb = springback(ctx.material, riActual, ctx.t, angle);
    angle = Math.min(b.formAngle, 179 - maxTool - corr - sb);
  }
  return Math.max(1, angle);
}

export function bendStationMaths(ctx: PlanContext, b: BendInfo, st: StationInfo): BendStationMaths {
  const t = ctx.t, m = ctx.material;
  if (st.isHemming) {
    const force = hemFlattenForce(m.tensileStrength, t, b.length);
    const forcePerMeter = b.length > 0 ? (force * 1000) / b.length : 0;
    return {
      formAngle: 180, riActual: b.bend.innerRadius, springback: 0, overbendAngle: 180, loadedIncludedAngle: 0,
      angleOk: b.isHem, angleFits: b.isHem, ramDepth: -(2 * t + (b.bend.hem === 'open' ? (b.bend.hemGap ?? t) : 0)) + ctx.machine.yCorrection,
      force, forcePerMeter, load: toolLoadCheck(forcePerMeter, st.punch, st.die), minLeg: 0, vPreference: 0, hemFlatten: true,
    };
  }
  const V = st.die.vWidth;
  const riActual = actualInnerRadius(V, m, t, st.punch.tipRadius);
  const formAngle = b.isHem ? hemPreBendAngle(ctx, b, st, riActual) : b.bend.angle;
  const ob = overbend(m, riActual, t, formAngle, b.bend.angleCorrection ?? 0);
  const reachable = !b.isHem || formAngle >= HEM_PREBEND_MIN - 1e-9;
  const angleOk = reachable && toolAngleFeasible(st.punch.tipAngle, st.die.vAngle, ob.overbendAngle);
  const angleFits = reachable && st.punch.tipAngle <= ob.loadedIncludedAngle + 1e-9 && st.die.vAngle <= ob.loadedIncludedAngle + 1e-9;
  const D = ramDepth(V, t, riActual, ob.loadedIncludedAngle, st.die.shoulderRadius, st.die.vAngle) + ctx.machine.yCorrection;
  const f = airBendForce(m.tensileStrength, b.length, t, V);
  const rec = recommendedV(t);
  return {
    formAngle, riActual, springback: ob.springback, overbendAngle: ob.overbendAngle, loadedIncludedAngle: ob.loadedIncludedAngle,
    angleOk, angleFits, ramDepth: D, force: f.force, forcePerMeter: f.forcePerMeter, load: toolLoadCheck(f.forcePerMeter, st.punch, st.die),
    minLeg: minLeg(V, ob.loadedIncludedAngle, st.die.shoulderRadius),
    vPreference: rec > 0 ? Math.abs(V - rec) / rec : 0, hemFlatten: false,
  };
}

/**
 * Flat-material limits along the bend line: the nearest material (outline minus holes) within
 * `band` of the line beyond each end, as distances s along the line (s < 0 / s > L); ±Infinity
 * when there is none.
 */
export function flatMaterialLimits(outline: Polygon2, holes: Polygon2[], p0: Vec2, p1: Vec2, band: number): { sLeft: number; sRight: number } {
  const d = vec2.sub(p1, p0);
  const L = vec2.length(d);
  if (L < 1e-9) return { sLeft: -Infinity, sRight: Infinity };
  const e = vec2.scale(d, 1 / L), n = vec2.perp(e);
  let sMin = Infinity, sMax = -Infinity;
  for (const p of outline) {
    const s = vec2.dot(vec2.sub(p, p0), e);
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  const offsets = [-band, -band / 2, 0, band / 2, band];
  const hasMaterial = (s: number): boolean => {
    for (const off of offsets) {
      const p = vec2.add(p0, vec2.add(vec2.scale(e, s), vec2.scale(n, off)));
      if (pointInPolygon(p, outline) && !holes.some(h => pointInPolygon(p, h))) return true;
    }
    return false;
  };
  const step = 0.5;
  let sLeft = -Infinity;
  for (let s = -step / 2; s >= sMin - 1; s -= step) {
    if (hasMaterial(s)) { sLeft = s + step / 2; break; }
  }
  let sRight = Infinity;
  for (let s = L + step / 2; s <= sMax + 1; s += step) {
    if (hasMaterial(s)) { sRight = s - step / 2; break; }
  }
  return { sLeft, sRight };
}

/**
 * Best combination of pieces with sum ≤ limit (0.5 mm resolution): each mounted piece at most
 * once (`multiset = false`) or unlimited repeats of the available lengths (`true`). Returns the
 * pieces (largest first); empty when nothing fits.
 */
export function bestSegmentsWithin(limit: number, pieces: readonly number[], multiset: boolean): number[] {
  const N = Math.floor(limit * 2 + 1e-4);   // tolerate float noise in the usable interval
  if (N <= 0) return [];
  const sizes = pieces.map(p => Math.round(p * 2)).filter(p => p > 0 && p <= N);
  if (sizes.length === 0) return [];
  // from[s] = index of the piece that reached sum s (−1 = unreachable); 0/1 vs unbounded
  const from = new Int32Array(N + 1).fill(-1);
  from[0] = 0;
  if (multiset) {
    // unbounded: fewest pieces for every reachable sum, largest piece first on ties
    const uniq = [...new Set(sizes)].sort((a, b) => b - a);
    const cnt = new Int32Array(N + 1).fill(-1);
    cnt[0] = 0;
    for (let sSum = 1; sSum <= N; sSum++) {
      for (let i = 0; i < uniq.length; i++) {
        const p = uniq[i]!;
        if (p > sSum || cnt[sSum - p]! < 0) continue;
        const c = cnt[sSum - p]! + 1;
        if (cnt[sSum]! < 0 || c < cnt[sSum]!) { cnt[sSum] = c; from[sSum] = i + 1; }
      }
    }
    let best = N;
    while (best > 0 && cnt[best]! < 0) best--;
    const out: number[] = [];
    for (let sSum = best; sSum > 0;) { const p = uniq[from[sSum]! - 1]!; out.push(p / 2); sSum -= p; }
    return out.sort((a, b) => b - a);
  }
  // 0/1: process pieces one by one, descending sums
  const used = new Int32Array(N + 1).fill(-1);
  for (let i = 0; i < sizes.length; i++) {
    const p = sizes[i]!;
    for (let sSum = N; sSum >= p; sSum--) {
      if (from[sSum]! < 0 && from[sSum - p]! >= 0) { from[sSum] = 1; used[sSum] = i; }
    }
  }
  let best = N;
  while (best > 0 && from[best]! < 0) best--;
  // reconstruct: walk back through the pieces recorded in `used` (each piece once by construction)
  const out: number[] = [];
  const taken = new Set<number>();
  for (let sSum = best; sSum > 0;) {
    const i = used[sSum]!;
    if (i < 0 || taken.has(i)) break;
    taken.add(i); out.push(sizes[i]! / 2); sSum -= sizes[i]!;
  }
  return out.sort((a, b) => b - a);
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** flatMaterialLimits depends only on the bend and the band: memoised per context. */
const limitsCache = new WeakMap<PlanContext, Map<string, { sLeft: number; sRight: number }>>();

function flatLimitsFor(ctx: PlanContext, b: BendInfo, band: number): { sLeft: number; sRight: number } {
  let m = limitsCache.get(ctx);
  if (!m) { m = new Map(); limitsCache.set(ctx, m); }
  const key = `${b.id}|${band}`;
  let lim = m.get(key);
  if (!lim) {
    lim = flatMaterialLimits(ctx.part.flat.outline, ctx.part.flat.holes, b.bend.p0, b.bend.p1, band);
    m.set(key, lim);
  }
  return lim;
}

export interface StationAnalysis {
  station: StationInfo;
  maths: BendStationMaths;
  /** Usable Z interval for the punch around the bend line (machine Z, clipped to the station). */
  usable: [number, number];
  punchZ: [number, number];
  punchLength: number;
  segments: number[];
  required: number;
  tooShort: boolean;
  warnings: Message[];
  hardErrors: number;
}

/**
 * Station analysis for a bend at a placement: usable punch interval, punch piece and segments.
 * `pieces` = the part silhouette at the placement (f = 0).
 */
export function analyseStation(ctx: PlanContext, b: BendInfo, st: StationInfo, maths: BendStationMaths, details: PlacementDetails, pieces: SilhouettePiece[]): StationAnalysis {
  const t = ctx.t;
  const warnings: Message[] = [];
  let hardErrors = 0;
  const [zb0, zb1] = details.bendZ;
  const required = Math.max(0, b.length - 2 * (b.bend.innerRadius + t));

  const angleParams = { bendId: b.id, stationId: st.station.id, punchAngle: st.punch.tipAngle, vAngle: st.die.vAngle, loadedAngle: Math.round(maths.loadedIncludedAngle * 100) / 100 };
  if (!maths.angleFits) {
    warnings.push({ key: 'warnings.tool.angle', severity: 'error', params: angleParams });
    hardErrors++;
  } else if (!maths.angleOk) {
    warnings.push({ key: 'warnings.tool.bottoming', severity: 'info', params: angleParams });
  }

  // 1. flat-material limit (s along the bend line → machine Z)
  let left = -Infinity, right = Infinity;
  if (!maths.hemFlatten) {
    const band = st.die.vWidth / 2 + 1;
    const lim = flatLimitsFor(ctx, b, band);
    // s = 0 ↔ p0, s = L ↔ p1; the placement may map p0 to either Z end
    const [z0, z1] = details.bendZ01;
    const L = b.length;
    const map = (s: number): number => z0 + ((z1 - z0) * s) / (L > 0 ? L : 1);
    for (const s of [lim.sLeft, lim.sRight]) {
      if (!Number.isFinite(s)) continue;
      const v = map(s);
      if (v <= zb0 + 1e-6) left = Math.max(left, v); else right = Math.min(right, v);
    }
  }

  // 2. standing features of the folded part (pieces above the sheet, beside the bend line in Z, within the punch's X extent)
  const prof = st.punch.profile.points;
  let px0 = Infinity, px1 = -Infinity;
  for (const p of prof) { const x = st.station.punchFlipped ? -p.x : p.x; if (x < px0) px0 = x; if (x > px1) px1 = x; }
  px0 -= 2; px1 += 2;
  for (const piece of pieces) {
    let maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const p of piece.polygon) { if (p.y > maxY) maxY = p.y; if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
    if (maxY <= t + 0.5) continue;
    if (maxX < px0 || minX > px1) continue;
    const [pz0, pz1] = piece.zRange;
    if (pz1 <= zb0 + 1) left = Math.max(left, pz1);
    else if (pz0 >= zb1 - 1) right = Math.min(right, pz0);
  }

  // the piece is centred on the bend line and may extend equally on both sides as far as the
  // nearer limit allows (a one-sided obstacle does not send the piece far over the free side)
  const u0 = Math.max(st.zStart, Number.isFinite(left) ? left + PUNCH_CLEARANCE : st.zStart);
  const u1 = Math.min(st.zEnd, Number.isFinite(right) ? right - PUNCH_CLEARANCE : st.zEnd);
  const zc = (zb0 + zb1) / 2;
  const half = Math.max(0, Math.min(zc - u0, u1 - zc));
  const usable: [number, number] = [zc - half, zc + half];
  const usableLength = usable[1] - usable[0];

  // punch pieces
  let punchLength: number, segments: number[];
  if (usableLength >= st.length - 1e-6) {
    punchLength = st.length;
    segments = st.station.segments.slice();
  } else {
    const fromStation = bestSegmentsWithin(usableLength, st.station.segments, false);
    let best = fromStation, bestSum = sum(fromStation);
    if (bestSum < required - 1e-9 || bestSum <= 0) {
      const fromPunch = bestSegmentsWithin(usableLength, st.punch.segmentLengths, true);
      const s2 = sum(fromPunch);
      if (s2 > bestSum) { best = fromPunch; bestSum = s2; }
    }
    if (bestSum <= 0 && st.station.segments.length === 0 && st.punch.segmentLengths.length === 0) {
      // a single full-length tool: it cannot be shortened
      best = []; bestSum = st.length;
    }
    punchLength = bestSum;
    segments = best;
  }
  const tooShort = punchLength < required - 1e-9;
  if (tooShort) {
    warnings.push({
      key: 'warnings.tool.tooShort', severity: 'error',
      params: { bendId: b.id, stationId: st.station.id, stationLength: Math.round(punchLength * 100) / 100, required: Math.round(required * 100) / 100 },
    });
    hardErrors++;
  }

  // punch piece position: centred on the bend line (a full-length tool that cannot be shortened is clamped to the station)
  let zp0 = zc - punchLength / 2, zp1 = zc + punchLength / 2;
  if (zp0 < usable[0]) { zp1 += usable[0] - zp0; zp0 = usable[0]; }
  if (zp1 > usable[1]) { zp0 -= zp1 - usable[1]; zp1 = usable[1]; }
  if (zp0 < st.zStart) { zp1 += st.zStart - zp0; zp0 = st.zStart; }
  if (zp1 > st.zEnd) { zp0 -= zp1 - st.zEnd; zp1 = st.zEnd; }

  return { station: st, maths, usable, punchZ: [zp0, zp1], punchLength, segments, required, tooShort, warnings, hardErrors };
}

/** Placement details translated along the bed by `dz` (transform, Z extents, bounds, partZOffset). */
export function shiftPlacementDetails(details: PlacementDetails, dz: number): PlacementDetails {
  if (Math.abs(dz) < 1e-12) return details;
  return {
    ...details,
    placement: { ...details.placement, transform: mat4.multiply(mat4.translationXYZ(0, 0, dz), details.placement.transform), partZOffset: details.placement.partZOffset + dz },
    bendZ: [details.bendZ[0] + dz, details.bendZ[1] + dz],
    bendZ01: [details.bendZ01[0] + dz, details.bendZ01[1] + dz],
    bounds: { min: { ...details.bounds.min, z: details.bounds.min.z + dz }, max: { ...details.bounds.max, z: details.bounds.max.z + dz } },
  };
}

/**
 * Convention for the program: the punch piece (`punchLength`) is mounted CENTRED in the station
 * and the part is placed relative to it (`partZOffset`) — so the sim reconstructs the piece's Z
 * range from the BendStep alone. When the Z-clearance analysis placed the piece off the station
 * centre, the part, its silhouette and the analysis are translated together by the difference.
 */
export function centrePunchInStation(st: StationInfo, details: PlacementDetails, pieces: SilhouettePiece[], analysis: StationAnalysis): { details: PlacementDetails; pieces: SilhouettePiece[]; analysis: StationAnalysis } {
  const dz = (st.zStart + st.zEnd) / 2 - (analysis.punchZ[0] + analysis.punchZ[1]) / 2;
  if (Math.abs(dz) < 1e-9) return { details, pieces, analysis };
  return {
    details: shiftPlacementDetails(details, dz),
    pieces: pieces.map(p => ({ ...p, zRange: [p.zRange[0] + dz, p.zRange[1] + dz] as [number, number] })),
    analysis: {
      ...analysis,
      usable: [Math.max(st.zStart, analysis.usable[0] + dz), Math.min(st.zEnd, analysis.usable[1] + dz)],
      punchZ: [analysis.punchZ[0] + dz, analysis.punchZ[1] + dz],
    },
  };
}
