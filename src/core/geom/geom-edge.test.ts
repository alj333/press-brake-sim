import { describe, it, expect } from 'vitest';
import type { Polygon2, Vec2 } from '../types';
import {
  area, isCCW, ensureCCW, splitPolygonByLine, unionAdjacentPolygons, simplifyCollinear, dedupe, segmentIntersect,
  penetrationDepth, polygonsIntersect, polygonDistance, clipToZ, polygonNormal, arcToPoints, convexHull, mat4, vec3,
  classifyPoint, affineMirrorX, affineMultiply, affineRotation, affineApply, thickenSegment, sharedBoundaryLength,
} from './index';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Polygon2 => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];

let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function starPolygon(n: number): Polygon2 {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n + rnd() * 0.5 / n;
    const r = 2 + rnd() * 8;
    pts.push(P(r * Math.cos(a), r * Math.sin(a)));
  }
  return pts;
}
function sameCyclic(a: Polygon2, b: Polygon2, tol = 1e-6): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  for (let off = 0; off < n; off++) {
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const p = a[i]!, q = b[(i + off) % n]!;
      if (Math.abs(p.x - q.x) > tol || Math.abs(p.y - q.y) > tol) ok = false;
    }
    if (ok) return true;
  }
  return false;
}
const splitAll = (pieces: Polygon2[], pt: Vec2, dir: Vec2) =>
  pieces.flatMap(p => { const { left, right } = splitPolygonByLine(p, pt, dir); return [...left, ...right]; });

describe('unionAdjacentPolygons', () => {
  it('reassembles random polygons after up to 4 line splits, vertex for vertex', () => {
    let runs = 0;
    for (let k = 0; k < 400; k++) {
      const poly = k % 3 === 0 ? rect(0, 0, 2 + Math.floor(rnd() * 6), 2 + Math.floor(rnd() * 6)) : starPolygon(5 + Math.floor(rnd() * 9));
      if (area(poly) < 1e-6) continue;
      let pieces: Polygon2[] = [ensureCCW(poly)];
      for (let c = 0, n = 1 + Math.floor(rnd() * 4); c < n; c++) {
        const ang = k % 3 === 0 ? [0, Math.PI / 2, Math.PI / 4][Math.floor(rnd() * 3)]! : rnd() * Math.PI;
        const pt = k % 3 === 0 ? P(Math.floor(rnd() * 6), Math.floor(rnd() * 6)) : P((rnd() - 0.5) * 10, (rnd() - 0.5) * 10);
        pieces = splitAll(pieces, pt, P(Math.cos(ang), Math.sin(ang)));
      }
      const merged = unionAdjacentPolygons(pieces);
      expect(merged, `run ${k}`).not.toBeNull();
      expect(merged!.length, `run ${k}: regions`).toBe(1);
      expect(merged![0]!.holes.length).toBe(0);
      expect(isCCW(merged![0]!.polygon)).toBe(true);
      const ref = simplifyCollinear(dedupe(ensureCCW(poly), 1e-6), 1e-6);
      expect(sameCyclic(ref, merged![0]!.polygon), `run ${k}: vertices`).toBe(true);
      runs++;
    }
    expect(runs).toBeGreaterThan(350);
  });

  it('an island removed by four splits becomes a hole of the merged region', () => {
    let pieces: Polygon2[] = [rect(0, 0, 10, 10)];
    pieces = splitAll(pieces, P(3, 0), P(0, 1));
    pieces = splitAll(pieces, P(7, 0), P(0, 1));
    pieces = splitAll(pieces, P(0, 3), P(1, 0));
    pieces = splitAll(pieces, P(0, 7), P(1, 0));
    expect(pieces.length).toBe(9);
    pieces = pieces.filter(p => Math.abs(area(p) - 16) > 1e-9);
    const merged = unionAdjacentPolygons(pieces)!;
    expect(merged.length).toBe(1);
    expect(merged[0]!.polygon.length).toBe(4);
    expect(area(merged[0]!.polygon)).toBeCloseTo(100, 9);
    expect(merged[0]!.holes.length).toBe(1);
    expect(area(merged[0]!.holes[0]!)).toBeCloseTo(16, 9);
    expect(isCCW(merged[0]!.holes[0]!)).toBe(false); // holes are CW
  });

  it('corner touch stays separate, partial edge contact (T) merges, disjoint stays as is', () => {
    const corner = unionAdjacentPolygons([rect(0, 0, 1, 1), rect(1, 1, 2, 2)])!;
    expect(corner.length).toBe(2);
    const t = unionAdjacentPolygons([rect(0, 0, 2, 2), rect(2, 0.5, 3, 1.5)])!;
    expect(t.length).toBe(1);
    expect(area(t[0]!.polygon)).toBeCloseTo(5, 12);
    expect(t[0]!.polygon.length).toBe(8);
    const far = unionAdjacentPolygons([rect(0, 0, 1, 1), rect(5, 5, 6, 6)])!;
    expect(far.length).toBe(2);
    // three in a row sharing full edges → one rectangle with 4 vertices
    const row = unionAdjacentPolygons([rect(0, 0, 1, 1), rect(1, 0, 2, 1), rect(2, 0, 3, 1)])!;
    expect(row.length).toBe(1);
    expect(row[0]!.polygon.length).toBe(4);
    expect(area(row[0]!.polygon)).toBeCloseTo(3, 12);
  });

  it('two pieces pinched at a vertex on the seam line are merged into one simple polygon', () => {
    // bow-tie-ish: a square split by a diagonal through a notch vertex touches the line from one side
    const p: Polygon2 = [P(-5, -5), P(5, -5), P(5, 5), P(0, 0), P(-5, 5)];
    const pieces = splitAll([p], P(0, 0), P(1, 0));
    expect(pieces.length).toBe(3);
    const merged = unionAdjacentPolygons(pieces)!;
    expect(merged.length).toBe(1);
    expect(area(merged[0]!.polygon)).toBeCloseTo(75, 9);
    expect(sameCyclic(merged[0]!.polygon, p)).toBe(true);
  });
});

describe('splitPolygonByLine edge cases', () => {
  it('line through two opposite vertices of a diamond → two triangles', () => {
    const d: Polygon2 = [P(0, -1), P(1, 0), P(0, 1), P(-1, 0)];
    const { left, right } = splitPolygonByLine(d, P(0, 0), P(1, 0));
    expect(left.length).toBe(1); expect(right.length).toBe(1);
    expect(area(left[0]!)).toBeCloseTo(1, 12); expect(area(right[0]!)).toBeCloseTo(1, 12);
    expect(left[0]!.length).toBe(3); expect(right[0]!.length).toBe(3);
  });

  it('line touching a convex vertex from outside keeps the polygon whole on one side', () => {
    const tri: Polygon2 = [P(0, 0), P(4, 0), P(2, 3)];
    const a = splitPolygonByLine(tri, P(2, 3), P(1, 0));   // through the apex
    expect(a.left.length).toBe(0); expect(a.right.length).toBe(1);
    expect(area(a.right[0]!)).toBeCloseTo(6, 12);
    const b = splitPolygonByLine(tri, P(0, 0), P(1, 1));   // through the corner, other vertices on both sides
    expect(area(b.left[0]!) + area(b.right[0]!)).toBeCloseTo(6, 12);
  });

  it('degenerate inputs: < 3 vertices, zero-area, zero direction', () => {
    expect(splitPolygonByLine([P(0, 0), P(1, 1)], P(0, 0), P(1, 0))).toEqual({ left: [], right: [] });
    expect(splitPolygonByLine([P(0, 0), P(1, 0), P(2, 0)], P(0, 1), P(1, 0)).right.length).toBe(0);
    const r = rect(0, 0, 2, 2);
    const z = splitPolygonByLine(r, P(1, 0), P(0, 0));
    expect(z.left.length + z.right.length).toBe(1);
  });

  it('area is conserved for a comb polygon split by many lines through its vertices', () => {
    // comb: 5 teeth of width 1, gap 1
    const comb: Polygon2 = [P(0, 0), P(9, 0), P(9, 2)];
    for (let i = 4; i >= 0; i--) comb.push(P(2 * i + 1, 2), P(2 * i + 1, 5), P(2 * i, 5), P(2 * i, 2));
    const a0 = area(comb);
    let pieces: Polygon2[] = [comb];
    for (const x of [1, 2, 3, 4.5, 8]) pieces = splitAll(pieces, P(x, 0), P(0, 1));
    for (const y of [2, 3.5]) pieces = splitAll(pieces, P(0, y), P(1, 0));
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(a0, 9);
    for (const p of pieces) expect(isCCW(p)).toBe(true);
    const merged = unionAdjacentPolygons(pieces)!;
    expect(merged.length).toBe(1);
    expect(area(merged[0]!.polygon)).toBeCloseTo(a0, 9);
  });
});

describe('segment / polygon relations edge cases', () => {
  it('segmentIntersect tolerance is a distance, not a parameter', () => {
    // long segment, near miss at 5e-7 → hit; at 5e-6 → miss
    expect(segmentIntersect(P(0, 0), P(1000, 0), P(1000 + 5e-7, -1), P(1000 + 5e-7, 1))).not.toBeNull();
    expect(segmentIntersect(P(0, 0), P(1000, 0), P(1000 + 5e-6, -1), P(1000 + 5e-6, 1))).toBeNull();
    // zero-length segments
    expect(segmentIntersect(P(1, 1), P(1, 1), P(0, 0), P(2, 2))).not.toBeNull();
    expect(segmentIntersect(P(1, 1), P(1, 1), P(1, 1), P(1, 1))).not.toBeNull();
    expect(segmentIntersect(P(1, 1.1), P(1, 1.1), P(0, 0), P(2, 2))).toBeNull();
    // collinear, disjoint
    expect(segmentIntersect(P(0, 0), P(1, 0), P(2, 0), P(3, 0))).toBeNull();
    // collinear, touching at an end
    const c = segmentIntersect(P(0, 0), P(1, 0), P(1, 0), P(3, 0))!;
    expect(c.point.x).toBeCloseTo(1, 12);
  });

  it('penetrationDepth is symmetric, 0 for edge contact, positive for containment and crossings', () => {
    const a = rect(0, 0, 10, 10), b = rect(5, -3, 20, 3);
    expect(penetrationDepth(a, b)).toBeCloseTo(penetrationDepth(b, a), 12);
    expect(penetrationDepth(a, b)).toBeCloseTo(3, 9);
    // sheet crossing fully through a finger (no vertex inside): the larger of the two crossing half-widths
    expect(penetrationDepth(rect(-100, 0, 100, 2), rect(-3, -30, 3, 30))).toBeCloseTo(3, 9);
    expect(penetrationDepth(rect(-3, -30, 3, 30), rect(-100, 0, 100, 2))).toBeCloseTo(3, 9);
    // point contact only
    expect(penetrationDepth(rect(0, 0, 1, 1), rect(1, 1, 2, 2))).toBe(0);
    // concave obstacle (U) around a thin bar: contact along the inner walls only ⇒ 0; pushed in ⇒ > 0
    const u: Polygon2 = [P(0, 0), P(6, 0), P(6, 4), P(4, 4), P(4, 1), P(2, 1), P(2, 4), P(0, 4)];
    expect(penetrationDepth(u, rect(2, 1, 4, 4))).toBe(0);
    expect(penetrationDepth(u, rect(2, 0.5, 4, 4))).toBeCloseTo(0.5, 9);
    expect(polygonDistance(u, rect(2.5, 1.5, 3.5, 3.5))).toBeCloseTo(0.5, 9);
  });

  it('polygonsIntersect handles a vertex exactly on an edge and identical polygons', () => {
    expect(polygonsIntersect(rect(0, 0, 2, 2), [P(2, 1), P(4, 0), P(4, 2)])).toBe(true);
    expect(polygonsIntersect(rect(0, 0, 2, 2), rect(0, 0, 2, 2))).toBe(true);
    expect(polygonsIntersect([], rect(0, 0, 2, 2))).toBe(false);
  });

  it('sharedBoundaryLength ignores non-collinear near edges and sums several overlaps', () => {
    expect(sharedBoundaryLength(rect(0, 0, 4, 1), [P(1, 1), P(3, 1), P(3, 2), P(2, 1.5), P(1, 2)])).toBeCloseTo(2, 12);
    expect(sharedBoundaryLength(rect(0, 0, 4, 1), rect(0, 1.001, 4, 2))).toBe(0);
    expect(sharedBoundaryLength(rect(0, 0, 4, 1), rect(0, 1.001, 4, 2), 0.01)).toBeCloseTo(4, 9);
  });

  it('classifyPoint on a concave polygon and thickenSegment orientation', () => {
    const u: Polygon2 = [P(0, 0), P(6, 0), P(6, 4), P(4, 4), P(4, 1), P(2, 1), P(2, 4), P(0, 4)];
    expect(classifyPoint(P(3, 2), u)).toBe('outside');
    expect(classifyPoint(P(3, 0.5), u)).toBe('inside');
    expect(classifyPoint(P(2, 2), u)).toBe('edge');
    const t = thickenSegment(P(0, 0), P(0, 5), 1);
    expect(isCCW(t)).toBe(true);
    expect(thickenSegment(P(1, 1), P(1, 1), 1).length).toBe(4); // zero-length segment: a 2 × 0 sliver, no NaN
    for (const p of thickenSegment(P(1, 1), P(1, 1), 1)) expect(Number.isFinite(p.x + p.y)).toBe(true);
  });
});

describe('3D / arcs / transforms edge cases', () => {
  it('clipToZ: band equal to the extent, band touching, thin band inside a tilted polygon, degenerate polygon', () => {
    const wall = [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }];
    expect(clipToZ(wall, 0, 10).length).toBe(1);
    expect(clipToZ(wall, 0, 10)[0]!.length).toBe(4);
    expect(clipToZ(wall, 10, 12).length).toBe(0);          // touching only
    const thin = clipToZ(wall, 4.999, 5.001);
    expect(thin.length).toBe(1);
    expect(Math.abs(area(thin[0]!.map(p => ({ x: p.x, y: p.z }))))).toBeCloseTo(4 * 0.002, 9);
    expect(clipToZ([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], -1, 1)).toEqual([]);
    // reversed band arguments are accepted
    expect(clipToZ(wall, 5, 2).length).toBe(1);
    // winding about the normal is kept for a polygon whose normal points toward −y
    const back = wall.slice().reverse();
    expect(polygonNormal(clipToZ(back, 2, 5)[0]!).y).toBeCloseTo(polygonNormal(back).y, 9);
  });

  it('arcToPoints: wrap-around, clockwise, tiny radius, chord tolerance', () => {
    const wrap = arcToPoints(P(0, 0), 5, 350, 10, true);   // 20° sweep through 0°
    expect(wrap.length).toBe(3);                            // step at r = 5 is 16.2° → 2 segments
    expect(wrap[wrap.length - 1]!.y).toBeCloseTo(5 * Math.sin(Math.PI / 18), 9);
    expect(wrap[1]!.x).toBeCloseTo(5, 9); expect(wrap[1]!.y).toBeCloseTo(0, 9);
    const cw = arcToPoints(P(0, 0), 5, 10, 350, false);     // 20° clockwise through 0°
    expect(cw.length).toBe(3);
    expect(cw[cw.length - 1]!.y).toBeCloseTo(-5 * Math.sin(Math.PI / 18), 9);
    const tiny = arcToPoints(P(0, 0), 0.01, 0, 360, true);
    expect(tiny.length).toBe(9);
    const big = arcToPoints(P(0, 0), 1000, 0, 90, true, 0.05);
    const step = (Math.PI / 2) / (big.length - 1);
    expect(1000 * (1 - Math.cos(step / 2))).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(1000 * (1 - Math.cos(step))).toBeGreaterThan(0.05); // not wastefully fine
  });

  it('convexHull drops duplicates and collinear points; degenerate sets pass through', () => {
    const h = convexHull([P(0, 0), P(0, 0), P(1, 0), P(2, 0), P(2, 2), P(1, 1), P(0, 2), P(1, 2)]);
    expect(h.length).toBe(4);
    expect(convexHull([P(0, 0), P(1, 1)]).length).toBe(2);
    expect(convexHull([P(0, 0), P(1, 1), P(2, 2)]).length).toBe(2); // collinear
  });

  it('mat4: placement-like transforms decompose/compose/invert exactly', () => {
    const pl = mat4.multiply(mat4.translationXYZ(-58, 1, 0), mat4.multiply(mat4.fromAxisAngle({ x: 0, y: 1, z: 0 }, 180), mat4.fromAxisAngle({ x: 1, y: 0, z: 0 }, -90)));
    const d = mat4.decompose(pl);
    expect(mat4.equals(mat4.compose(d.position, d.quaternion, d.scale), pl, 1e-12)).toBe(true);
    expect(Math.hypot(...d.quaternion)).toBeCloseTo(1, 12);
    const inv = mat4.invert(pl);
    const p = { x: 12.5, y: -3, z: 7 };
    expect(vec3.equals(mat4.applyToPoint(inv, mat4.applyToPoint(pl, p)), p, 1e-9)).toBe(true);
    // applyToDir ignores translation; rotation preserves length
    expect(vec3.length(mat4.applyToDir(pl, { x: 3, y: 4, z: 12 }))).toBeCloseTo(13, 12);
    // rotationAxisAngle about an off-origin axis leaves the axis fixed
    const r = mat4.rotationAxisAngle({ x: 5, y: 6, z: 7 }, { x: 1, y: 1, z: 1 }, 123);
    expect(vec3.equals(mat4.applyToPoint(r, { x: 6, y: 7, z: 8 }), { x: 6, y: 7, z: 8 }, 1e-12)).toBe(true);
    expect(mat4.determinant(r)).toBeCloseTo(1, 12);
  });

  it('affine mirror + rotation composition', () => {
    const m = affineMultiply(affineRotation(90), affineMirrorX());
    const p = affineApply(m, P(1, 0)); // mirror → (−1, 0), rotate 90 → (0, −1)
    expect(p.x).toBeCloseTo(0, 12); expect(p.y).toBeCloseTo(-1, 12);
  });
});
