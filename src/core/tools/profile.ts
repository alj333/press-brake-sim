/**
 * Shared helpers for tool cross-section profiles (pure, mm). See docs/specs/tooling-machine.md.
 * Profiles are closed CCW Polygon2 in the tool's local frame (types.ts header).
 */
import type { Polygon2, ToolProfile, Vec2 } from '../types';
import { dedupe, ensureCCW, segmentIntersect, bounds } from '../geom';

/** Chord error used when flattening tool arcs (finer than the 0.05 mm part default). */
export const TOOL_CHORD_TOL = 0.02;

const DEG = Math.PI / 180;

/** Max angular step (deg) for radius r so the chord error stays ≤ chordTol; capped at 45°. */
export function toolArcStepDeg(r: number, chordTol = TOOL_CHORD_TOL): number {
  if (!(r > 0) || chordTol >= r) return 45;
  return Math.min(45, Math.max((2 * Math.acos(1 - chordTol / r)) / DEG, 1e-3));
}

/**
 * Rounded tip of a punch with included angle 2·alpha and radius r: the circle of radius r
 * centred at (0, r) is tangent to both flanks; the points run from the left tangent point
 * T_L = (−r·cos α, r·(1 − sin α)) through the ORIGIN (an explicit vertex) to the right tangent
 * point T_R, counter-clockwise about the centre (i.e. along the bottom, left → right).
 * r ≤ 0 ⇒ [origin].
 */
export function tipArc(r: number, alphaDeg: number, chordTol = TOOL_CHORD_TOL): Vec2[] {
  if (!(r > 0)) return [{ x: 0, y: 0 }];
  const a = alphaDeg * DEG;
  // angles about the centre: T_L at 180° + α, bottom at 270°, T_R at 360° − α
  const halfSweepDeg = 90 - alphaDeg;
  const nHalf = Math.max(1, Math.ceil(halfSweepDeg / toolArcStepDeg(r, chordTol) - 1e-9));
  const pts: Vec2[] = [];
  for (let i = -nHalf; i <= nHalf; i++) {
    const ang = (270 + (i * halfSweepDeg) / nHalf) * DEG;
    pts.push({ x: r * Math.cos(ang), y: r + r * Math.sin(ang) });
  }
  // exact end points and the exact origin (avoid 1e-17 residues)
  pts[0] = { x: -r * Math.cos(a), y: r * (1 - Math.sin(a)) };
  pts[nHalf] = { x: 0, y: 0 };
  pts[2 * nHalf] = { x: r * Math.cos(a), y: r * (1 - Math.sin(a)) };
  return pts;
}

/** Dedupe (1e-6) + CCW: the canonical form of every generated profile. */
export function finishProfile(points: Vec2[]): ToolProfile {
  return { points: ensureCCW(dedupe(points.map(p => ({ x: p.x, y: p.y })), 1e-6)) };
}

export function translateProfile(points: Polygon2, dx: number, dy: number): Polygon2 {
  return points.map(p => ({ x: p.x + dx, y: p.y + dy }));
}

/** Mirror x → −x and restore CCW winding. */
export function mirrorProfileX(points: Polygon2): Polygon2 {
  return ensureCCW(points.map(p => ({ x: -p.x, y: p.y })));
}

/** Axis-aligned rectangle, CCW. */
export function rect(x0: number, y0: number, x1: number, y1: number): Polygon2 {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1), ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  return [{ x: xa, y: ya }, { x: xb, y: ya }, { x: xb, y: yb }, { x: xa, y: yb }];
}

/** Simple polygon test: ≥ 3 vertices and no two non-adjacent edges intersect. */
export function isSimplePolygon(poly: Polygon2, tol = 1e-9): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a0 = poly[i]!, a1 = poly[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a vertex
      const b0 = poly[j]!, b1 = poly[(j + 1) % n]!;
      if (segmentIntersect(a0, a1, b0, b1, tol)) return false;
    }
  }
  return true;
}

export interface CircleFit { centre: Vec2; r: number; residual: number }

/** Kåsa algebraic least-squares circle fit (≥ 3 non-collinear points), residual = max |d − r|. */
export function fitCircle(points: Vec2[]): CircleFit | null {
  const n = points.length;
  if (n < 3) return null;
  // centre the data for conditioning
  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of points) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null; // collinear
  const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (suu * b2 - suv * b1) / det;
  const centre = { x: uc + mx, y: vc + my };
  let r = 0;
  for (const p of points) r += Math.hypot(p.x - centre.x, p.y - centre.y);
  r /= n;
  let residual = 0;
  for (const p of points) residual = Math.max(residual, Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - r));
  return { centre, r, residual };
}

/** Exterior turn angle (deg, ≥ 0) at vertex i of a polygon. */
export function turnAngleDeg(poly: Polygon2, i: number): number {
  const n = poly.length;
  const a = poly[(i + n - 1) % n]!, b = poly[i]!, c = poly[(i + 1) % n]!;
  const u = { x: b.x - a.x, y: b.y - a.y }, v = { x: c.x - b.x, y: c.y - b.y };
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  if (lu === 0 || lv === 0) return 0;
  const cosT = Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv)));
  return Math.acos(cosT) / DEG;
}

/** Angle (deg) between two directions, 0..180. */
export function angleBetweenDeg(u: Vec2, v: Vec2): number {
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  if (lu === 0 || lv === 0) return 0;
  const c = Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv)));
  return Math.acos(c) / DEG;
}

export function profileExtent(points: Polygon2): { minX: number; maxX: number; minY: number; maxY: number } {
  const b = bounds(points);
  return { minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y };
}

/** Round to n decimals (kills 1e-17 residues in generated coordinates). */
export function roundTo(v: number, decimals = 9): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r; // never −0 (JSON round trips would differ)
}
