/**
 * Bend-line frame in the FLAT plane: s along the line (0..length), d across it (perp, +90°).
 * Zone = { |d| ≤ BA/2, 0 ≤ s ≤ length }. Internal to core-geometry/part.
 */
import type { BendLine, Polygon2, Vec2 } from '../types';
import { vec2, centroid } from '../geom';

export interface BendFrame {
  bend: BendLine;
  p0: Vec2;
  /** Unit direction p0 → p1. */
  e: Vec2;
  /** Unit normal = perp(e) (+90°); d = dot(p − p0, n). */
  n: Vec2;
  length: number;
  /** Bend allowance (zone width). */
  ba: number;
}

/** Tolerance for "a vertex lies on a split line" (split points carry ~1e-12 error). */
export const LINE_TOL = 1e-5;
/** Minimum overlap length for adjacency / union-find. */
export const CHAIN_TOL = 0.01;
/** Material within this distance beyond a bend line's ends (inside the zone band) counts as zone. */
export const END_TOL = 0.1;

export function bendFrame(bend: BendLine, ba: number): BendFrame {
  const d = vec2.sub(bend.p1, bend.p0);
  const length = vec2.length(d);
  const e = length > 0 ? vec2.scale(d, 1 / length) : { x: 1, y: 0 };
  return { bend, p0: bend.p0, e, n: vec2.perp(e), length, ba };
}

export function coordS(f: BendFrame, p: Vec2): number { return vec2.dot(vec2.sub(p, f.p0), f.e); }
export function coordD(f: BendFrame, p: Vec2): number { return vec2.dot(vec2.sub(p, f.p0), f.n); }

/** Length of the polygon's boundary lying on the line d = dLine within s ∈ [0, length]. */
export function edgeLengthOnLongSide(poly: Polygon2, f: BendFrame, dLine: number, lineTol = LINE_TOL): number {
  let total = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!;
    if (Math.abs(coordD(f, a) - dLine) > lineTol || Math.abs(coordD(f, b) - dLine) > lineTol) continue;
    const sa = coordS(f, a), sb = coordS(f, b);
    const lo = Math.max(0, Math.min(sa, sb)), hi = Math.min(f.length, Math.max(sa, sb));
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/** Which side of the bend (sign of d) a fragment's centroid lies on. */
export function fragmentSide(poly: Polygon2, f: BendFrame): 1 | -1 {
  return coordD(f, centroid(poly)) >= 0 ? 1 : -1;
}

/**
 * Sides (+1 / −1) of the bend that a polygon is adjacent to: it has an edge on the long-side
 * line d = side·BA/2 inside the slab range (overlap > minOverlap). Independent of where the
 * polygon's centroid lies (a flange may wrap around the end of a short bend). For a degenerate
 * zero-width zone (both lines coincide) the centroid side is used.
 */
export function polygonBendSides(poly: Polygon2, f: BendFrame, minOverlap = CHAIN_TOL): Array<1 | -1> {
  const out: Array<1 | -1> = [];
  if (f.ba <= 2 * LINE_TOL) {
    const side = fragmentSide(poly, f);
    if (edgeLengthOnLongSide(poly, f, 0) > minOverlap) out.push(side);
    return out;
  }
  for (const side of [1, -1] as const) {
    if (edgeLengthOnLongSide(poly, f, (side * f.ba) / 2) > minOverlap) out.push(side);
  }
  return out;
}

/**
 * Side of the bend a set of polygons is adjacent to (+1 / −1), or 0 when none of them has an
 * edge on a long-side line inside the slab range. When the set touches both sides the side
 * with the longer contact wins.
 */
export function regionsSideOfBend(polys: Polygon2[], f: BendFrame, minOverlap = CHAIN_TOL): 1 | -1 | 0 {
  let plus = 0, minus = 0;
  for (const poly of polys) {
    if (f.ba <= 2 * LINE_TOL) {
      const l = edgeLengthOnLongSide(poly, f, 0);
      if (fragmentSide(poly, f) > 0) plus += l; else minus += l;
      continue;
    }
    plus += edgeLengthOnLongSide(poly, f, f.ba / 2);
    minus += edgeLengthOnLongSide(poly, f, -f.ba / 2);
  }
  if (plus <= minOverlap && minus <= minOverlap) return 0;
  return plus >= minus ? 1 : -1;
}

/** True when the point (s, d) is inside the zone strip, with the s range extended by `endTol`. */
export function insideStrip(p: Vec2, f: BendFrame, endTol = 0): boolean {
  const s = coordS(f, p), d = coordD(f, p);
  return s > -endTol && s < f.length + endTol && Math.abs(d) < f.ba / 2;
}
