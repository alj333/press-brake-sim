/**
 * Derive tool parameters (tip angle/radius, V width/angle/shoulder radius, stop height …) from a
 * profile polygon already placed in its tool frame. Used by the custom-tool creators and by the
 * library migration. Never throws; sane fallbacks + messages. See docs/specs/tooling-machine.md §1.4.
 */
import type { Message, Polygon2, Vec2 } from '../types';
import { ensureCCW, pointSegmentDistance } from '../geom';
import { angleBetweenDeg, fitCircle, profileExtent, turnAngleDeg } from './profile';

const VERTEX_TOL = 0.05;       // "at the origin" tolerance, mm
const SURFACE_TOL = 0.005;     // "on the top surface" tolerance, mm (small fillets have vertices 0.04 below the top)
const MAX_TIP_RADIUS = 30;     // fitted tip circles above this are chamfers, not radii
/** A flank leaving a genuine tip arc is tangent to it (CAD exports end the arc at the tangent
 *  point; sampled arcs deviate by ≤ half a chord step). Larger deviations mean the "arc" is
 *  really a sharp vertex with an obtuse angle (3 points always fit a circle). */
const MAX_TANGENT_DEVIATION_DEG = 25;

export interface DerivedPunchParams {
  tipRadius: number;
  tipAngle: number;
  bodyWidth: number;
  tangCentreX: number;
  height: number;
  /** Indices of the profile vertices that form the tip arc (empty for sharp / flat tips). */
  arcVertices: number[];
  messages: Message[];
}

function dist(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }

function nearestVertex(pts: Polygon2, p: Vec2): { index: number; distance: number } {
  let index = 0, distance = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[i]!, p);
    if (d < distance) { distance = d; index = i; }
  }
  return { index, distance };
}

/** Mid-x of the run of vertices within tol of the max y (the tang top). */
function topRunMidX(pts: Polygon2, tol = VERTEX_TOL): number {
  const ext = profileExtent(pts);
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) if (p.y >= ext.maxY - tol) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
  return lo <= hi ? (lo + hi) / 2 : (ext.minX + ext.maxX) / 2;
}

/** Punch: tip at the origin (vertex nearest to it), arc fit for rounded tips. */
export function derivePunchParams(points: Polygon2): DerivedPunchParams {
  const pts = ensureCCW(points);
  const n = pts.length;
  const messages: Message[] = [];
  const ext = profileExtent(pts);
  const height = ext.maxY - ext.minY;
  const bodyWidth = ext.maxX - ext.minX;
  const tangCentreX = topRunMidX(pts);
  const base = { bodyWidth, tangCentreX, height, messages };
  if (n < 3) {
    messages.push({ key: 'warnings.tool.tipNotFound', severity: 'warning' });
    return { ...base, tipRadius: 0, tipAngle: 88, arcVertices: [] };
  }
  const origin = { x: 0, y: 0 };
  const near = nearestVertex(pts, origin);
  const at = (k: number): Vec2 => pts[((k % n) + n) % n]!;
  const flat = (): DerivedPunchParams => ({ ...base, tipRadius: 0, tipAngle: 180, arcVertices: [] });
  const sharp = (turn: number): DerivedPunchParams => ({ ...base, tipRadius: 0, tipAngle: 180 - turn, arcVertices: [] });
  // seed of the tip arc: [lo, hi] vertex indices (inclusive, cyclic); `fallback` = the answer
  // when the seed turns out not to be an arc (a sharp vertex, or a flat face through the origin)
  let lo: number, hi: number;
  let fallback: () => DerivedPunchParams;
  if (near.distance <= VERTEX_TOL) {
    const turn = turnAngleDeg(pts, near.index);
    if (turn < 0.5) return flat();
    if (turn > 50) return sharp(turn);
    lo = near.index - 1; hi = near.index + 1;
    fallback = () => sharp(turn);
  } else {
    // origin on an edge: a chord of a rounded tip (both ends turn gently) or a flat face
    let edge = -1;
    for (let i = 0; i < n; i++) {
      if (pointSegmentDistance(origin, pts[i]!, pts[(i + 1) % n]!) <= VERTEX_TOL) { edge = i; break; }
    }
    if (edge < 0) {
      // the origin is not on the profile: the tip of a punch is its lowest point, so seed from the
      // lowest vertex (ties → the one nearest x = 0) and report the offset
      let lowest = near.index;
      for (let i = 0; i < n; i++) {
        const p = pts[i]!, q = pts[lowest]!;
        if (p.y < q.y - 1e-9 || (Math.abs(p.y - q.y) <= 1e-9 && Math.abs(p.x) < Math.abs(q.x))) lowest = i;
      }
      messages.push({ key: 'warnings.tool.tipNotFound', severity: 'warning', params: { distance: Number(dist(pts[lowest]!, origin).toFixed(3)) } });
      const turn = turnAngleDeg(pts, lowest);
      if (turn < 0.5) return flat();
      if (turn > 50) return sharp(turn);
      lo = lowest - 1; hi = lowest + 1;
      fallback = () => sharp(turn);
    } else {
      const tA = turnAngleDeg(pts, edge), tB = turnAngleDeg(pts, edge + 1);
      if (tA < 0.5 || tB < 0.5 || tA > 50 || tB > 50) return flat();
      lo = edge - 1; hi = edge + 2;
      fallback = flat;
    }
  }
  // rounded candidate: grow the arc on both sides while the vertices stay on the fitted circle
  const collect = (): Vec2[] => { const out: Vec2[] = []; for (let k = lo; k <= hi; k++) out.push(at(k)); return out; };
  let fit = fitCircle(collect());
  if (!fit || fit.r > MAX_TIP_RADIUS) return fallback();
  let grew = true;
  while (grew && fit && hi - lo + 1 < n - 2) {
    grew = false;
    const tol = 0.02 + 0.01 * fit.r;
    const candLo = at(lo - 1);
    if (Math.abs(dist(candLo, fit.centre) - fit.r) <= tol) {
      lo--;
      const f = fitCircle(collect());
      if (f && f.residual <= tol) { fit = f; grew = true; } else lo++;
    }
    if (hi - lo + 1 >= n - 2) break;
    const candHi = at(hi + 1);
    if (Math.abs(dist(candHi, fit.centre) - fit.r) <= tol) {
      hi++;
      const f = fitCircle(collect());
      if (f && f.residual <= tol) { fit = f; grew = true; } else hi--;
    }
  }
  // flank directions leaving the arc ends
  const leftEnd = at(lo), leftNext = at(lo - 1);
  const rightEnd = at(hi), rightNext = at(hi + 1);
  const dirL = { x: leftNext.x - leftEnd.x, y: leftNext.y - leftEnd.y };
  const dirR = { x: rightNext.x - rightEnd.x, y: rightNext.y - rightEnd.y };
  // the flanks must be (nearly) tangent to the fitted circle at the arc ends, otherwise this is
  // an obtuse sharp vertex whose two neighbours happen to define a circle
  const tangentDeviation = (end: Vec2, dir: Vec2): number => {
    const radial = { x: end.x - fit!.centre.x, y: end.y - fit!.centre.y };
    return Math.abs(90 - angleBetweenDeg(radial, dir));
  };
  if (tangentDeviation(leftEnd, dirL) > MAX_TANGENT_DEVIATION_DEG || tangentDeviation(rightEnd, dirR) > MAX_TANGENT_DEVIATION_DEG) {
    return fallback();
  }
  const tipAngle = angleBetweenDeg(dirL, dirR);
  if (tipAngle < 5 || tipAngle > 179) return fallback();
  const arcVertices: number[] = [];
  for (let k = lo; k <= hi; k++) arcVertices.push(((k % n) + n) % n);
  return { ...base, tipRadius: fit.r, tipAngle, arcVertices };
}

export interface DerivedDieParams {
  vWidth: number;
  vAngle: number;
  shoulderRadius: number;
  bodyWidth: number;
  height: number;
  /** X of the detected V centre (the point the die frame origin should sit on). */
  vCentreX: number;
  /** Y of the top surface (0 when the profile is already in the die frame). */
  topY: number;
  hasNotch: boolean;
  messages: Message[];
}

interface Run { start: number; inner: number[]; end: number; depth: number }

/** Die: the notch cut into the top surface (y = max y) that straddles x = 0 (else the deepest). */
export function deriveDieParams(points: Polygon2): DerivedDieParams {
  const pts = ensureCCW(points);
  const n = pts.length;
  const messages: Message[] = [];
  const ext = profileExtent(pts);
  const height = ext.maxY - ext.minY;
  const bodyWidth = ext.maxX - ext.minX;
  const topY = ext.maxY;
  const tol = Math.max(SURFACE_TOL, 1e-5 * height);
  const isTop = (i: number): boolean => pts[i]!.y >= topY - tol;
  const noNotch = (): DerivedDieParams => {
    messages.push({ key: 'warnings.tool.notchNotFound', severity: 'warning' });
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) if (isTop(i)) { lo = Math.min(lo, pts[i]!.x); hi = Math.max(hi, pts[i]!.x); }
    const vCentreX = lo <= hi ? (lo + hi) / 2 : (ext.minX + ext.maxX) / 2;
    return { vWidth: 0, vAngle: 180, shoulderRadius: 0, bodyWidth, height, vCentreX, topY, hasNotch: false, messages };
  };
  if (n < 4) return noNotch();
  // collect runs of non-top vertices between two top vertices, traversed right → left
  const runs: Run[] = [];
  for (let s = 0; s < n; s++) {
    if (!isTop(s) || isTop((s + 1) % n)) continue;
    const inner: number[] = [];
    let j = (s + 1) % n, guard = 0;
    while (!isTop(j) && guard++ < n) { inner.push(j); j = (j + 1) % n; }
    if (!isTop(j) || inner.length === 0) continue;
    if (pts[s]!.x <= pts[j]!.x) continue; // traversed left → right: that is the body, not a notch
    let depth = 0;
    for (const k of inner) depth = Math.max(depth, topY - pts[k]!.y);
    runs.push({ start: s, inner, end: j, depth });
  }
  if (runs.length === 0) return noNotch();
  const straddling = runs.filter(r => pts[r.end]!.x <= VERTEX_TOL && pts[r.start]!.x >= -VERTEX_TOL);
  const pool = straddling.length > 0 ? straddling : runs;
  const run = pool.reduce((a, b) => (b.depth > a.depth ? b : a));
  const seq = [run.start, ...run.inner, run.end];
  // deepest vertex (first and last within 1e-6 of the minimum, for flat-bottomed notches)
  let minY = Infinity;
  for (const k of seq) minY = Math.min(minY, pts[k]!.y);
  let bR = -1, bL = -1;
  for (let q = 0; q < seq.length; q++) {
    if (pts[seq[q]!]!.y <= minY + 1e-6) { if (bR < 0) bR = q; bL = q; }
  }
  const longestFace = (from: number, to: number): [number, number] | null => {
    let best: [number, number] | null = null, bestLen = 0;
    for (let q = from; q < to; q++) {
      const a = pts[seq[q]!]!, b = pts[seq[q + 1]!]!;
      const len = dist(a, b);
      if (len < 1e-9 || Math.abs(b.y - a.y) < 0.3 * len) continue; // skip near-horizontal edges
      if (len > bestLen) { bestLen = len; best = [q, q + 1]; }
    }
    return best;
  };
  const faceR = longestFace(0, bR);
  const faceL = longestFace(bL, seq.length - 1);
  if (!faceR || !faceL) return noNotch();
  const lineX = (upper: Vec2, lower: Vec2): number => upper.x + (topY - upper.y) * ((lower.x - upper.x) / (lower.y - upper.y));
  const rUp = pts[seq[faceR[0]]!]!, rLo = pts[seq[faceR[1]]!]!;
  const lLo = pts[seq[faceL[0]]!]!, lUp = pts[seq[faceL[1]]!]!;
  const xR = lineX(rUp, rLo), xL = lineX(lUp, lLo);
  const vWidth = Math.abs(xR - xL);
  const vCentreX = (xR + xL) / 2;
  const uR = { x: rLo.x - rUp.x, y: rLo.y - rUp.y }, uL = { x: lLo.x - lUp.x, y: lLo.y - lUp.y };
  const vAngle = angleBetweenDeg(uR, uL);
  // shoulder fillets: vertices between the top vertex and the face's upper vertex (inclusive)
  const filletRadius = (from: number, to: number): number | null => {
    const arc: Vec2[] = [];
    for (let q = Math.min(from, to); q <= Math.max(from, to); q++) arc.push(pts[seq[q]!]!);
    if (arc.length < 3) return null;
    const f = fitCircle(arc);
    if (!f || f.r > height || f.residual > 0.05 + 0.01 * f.r) return null;
    return f.r;
  };
  const rsR = filletRadius(0, faceR[0]);
  const rsL = filletRadius(faceL[1], seq.length - 1);
  const fillets = [rsR, rsL].filter((v): v is number => v !== null);
  const shoulderRadius = fillets.length > 0 ? fillets.reduce((a, b) => a + b, 0) / fillets.length : 0;
  return { vWidth, vAngle, shoulderRadius, bodyWidth, height, vCentreX, topY, hasNotch: true, messages };
}

export interface DerivedFingerParams {
  stopHeight: number;
  bodyDepth: number;
  height: number;
  messages: Message[];
}

/**
 * Finger: stop face = the lowest chain of vertical edges on x = 0 (the front face). Its top is
 * `stopHeight` (the contract says the face spans (0,0)–(0,stopHeight); a small chamfer or
 * radius under the face is tolerated — the chain then starts slightly above the origin).
 */
export function deriveFingerParams(points: Polygon2): DerivedFingerParams {
  const pts = ensureCCW(points);
  const n = pts.length;
  const messages: Message[] = [];
  const ext = profileExtent(pts);
  const height = ext.maxY - ext.minY;
  const bodyDepth = ext.maxX - ext.minX;
  const notFound = (): DerivedFingerParams => {
    messages.push({ key: 'warnings.tool.stopFaceNotFound', severity: 'warning' });
    return { stopHeight: Math.min(height, 20), bodyDepth, height, messages };
  };
  if (n < 3) return notFound();
  // climb the vertical edges on x ≈ 0 from vertex i in direction `step`; returns the top y reached
  const climb = (start: number, step: 1 | -1): number => {
    let i = start, top = pts[i]!.y, guard = 0;
    while (guard++ < n) {
      const j = ((i + step) % n + n) % n;
      const a = pts[i]!, b = pts[j]!;
      if (Math.abs(b.x) > VERTEX_TOL || Math.abs(b.x - a.x) > VERTEX_TOL || b.y <= a.y + 1e-9) break;
      top = b.y; i = j;
    }
    return top;
  };
  // candidate chain bottoms: vertices on x ≈ 0 that start a vertical edge upward; take the lowest
  let bottom: { y: number; top: number } | null = null;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    if (Math.abs(p.x) > VERTEX_TOL) continue;
    const top = Math.max(climb(i, 1), climb(i, -1));
    if (top - p.y <= VERTEX_TOL) continue;
    if (!bottom || p.y < bottom.y - 1e-9) bottom = { y: p.y, top };
  }
  if (!bottom) return notFound();
  // the face must start at (or very near) the origin: y ∈ [0, stopHeight] is what the gauge model uses
  if (bottom.y > 2 + VERTEX_TOL) return notFound();
  return { stopHeight: bottom.top, bodyDepth, height, messages };
}
