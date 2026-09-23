import { describe, it, expect } from 'vitest';
import type { Polygon2, Vec2 } from '../types';
import {
  signedArea, area, isCCW, ensureCCW, centroid, bounds, pointInPolygon, classifyPoint, segmentIntersect,
  polygonsIntersect, penetrationDepth, polygonDistance, splitPolygonByLine, clipPolygonByHalfPlane,
  sharedBoundaryLength, convexHull, thickenSegment, arcToPoints, bulgeArcToPoints, projectToXY, clipToZ,
  transformPolygon, mat4, simplifyCollinear, affineRotation, affineTranslation, affineMultiply, transformPolygon2,
  polygonNormal,
} from './index';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Polygon2 => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('basic polygon ops', () => {
  it('area / winding / centroid / bounds', () => {
    const r = rect(0, 0, 4, 2);
    expect(signedArea(r)).toBe(8);
    expect(isCCW(r)).toBe(true);
    const cw = r.slice().reverse();
    expect(isCCW(cw)).toBe(false);
    expect(area(cw)).toBe(8);
    expect(ensureCCW(cw)).toEqual(r);
    expect(ensureCCW(r)).toBe(r);
    expect(centroid(r)).toEqual({ x: 2, y: 1 });
    expect(bounds(r)).toEqual({ min: { x: 0, y: 0 }, max: { x: 4, y: 2 } });
  });

  it('point in polygon with on-edge tolerance', () => {
    const r = rect(0, 0, 4, 2);
    expect(pointInPolygon(P(1, 1), r)).toBe(true);
    expect(pointInPolygon(P(5, 1), r)).toBe(false);
    expect(classifyPoint(P(4, 1), r)).toBe('edge');
    expect(classifyPoint(P(4 + 5e-7, 1), r)).toBe('edge');
    expect(classifyPoint(P(4 + 5e-3, 1), r)).toBe('outside');
    expect(classifyPoint(P(0, 0), r)).toBe('edge');
    // concave
    const c: Polygon2 = [P(0, 0), P(4, 0), P(4, 4), P(2, 1), P(0, 4)];
    expect(classifyPoint(P(2, 3), c)).toBe('outside');
    expect(classifyPoint(P(1, 1), c)).toBe('inside');
  });

  it('segment intersection', () => {
    const h = segmentIntersect(P(0, 0), P(2, 2), P(0, 2), P(2, 0));
    expect(h).not.toBeNull();
    expect(h!.point).toEqual({ x: 1, y: 1 });
    expect(h!.ta).toBeCloseTo(0.5, 12);
    expect(segmentIntersect(P(0, 0), P(1, 1), P(2, 2), P(3, 3))).toBeNull();
    // collinear overlap
    const c = segmentIntersect(P(0, 0), P(2, 0), P(1, 0), P(3, 0));
    expect(c).not.toBeNull();
    expect(c!.point.x).toBeCloseTo(1.5, 12);
    // touching endpoint
    expect(segmentIntersect(P(0, 0), P(1, 0), P(1, 0), P(1, 1))).not.toBeNull();
    // parallel non-collinear
    expect(segmentIntersect(P(0, 0), P(1, 0), P(0, 1), P(1, 1))).toBeNull();
  });
});

describe('polygon relations', () => {
  it('polygonsIntersect: crossing, containment, disjoint, touching', () => {
    expect(polygonsIntersect(rect(0, 0, 2, 2), rect(1, 1, 3, 3))).toBe(true);
    expect(polygonsIntersect(rect(0, 0, 10, 10), rect(2, 2, 3, 3))).toBe(true);
    expect(polygonsIntersect(rect(2, 2, 3, 3), rect(0, 0, 10, 10))).toBe(true);
    expect(polygonsIntersect(rect(0, 0, 1, 1), rect(2, 2, 3, 3))).toBe(false);
    expect(polygonsIntersect(rect(0, 0, 1, 1), rect(1, 0, 2, 1))).toBe(true); // touching edge
  });

  it('penetrationDepth: 0 when touching, lower bound when overlapping, + shape', () => {
    expect(penetrationDepth(rect(0, 0, 1, 1), rect(1, 0, 2, 1))).toBe(0);
    expect(penetrationDepth(rect(0, 0, 1, 1), rect(3, 0, 4, 1))).toBe(0);
    const d = penetrationDepth(rect(0, 0, 10, 10), rect(9.5, 0, 20, 10));
    expect(d).toBeCloseTo(0.5, 9);
    // small square fully inside a big one: its centroid is 5 from the big boundary (true MTD is 6)
    expect(penetrationDepth(rect(0, 0, 10, 10), rect(4, 4, 6, 6))).toBeCloseTo(5, 9);
    expect(penetrationDepth(rect(0, 0, 10, 10), rect(1, 4, 3, 6))).toBeCloseTo(3, 9);
    // plus shape: no vertex inside, edges cross
    const plus = penetrationDepth(rect(-10, -1, 10, 1), rect(-1, -10, 1, 10));
    expect(plus).toBeCloseTo(1, 9);
    // tiny overlap below threshold still > 0
    expect(penetrationDepth(rect(0, 0, 10, 10), rect(9.9, 0, 20, 10))).toBeCloseTo(0.1, 9);
    // coincident polygons
    expect(penetrationDepth(rect(0, 0, 10, 4), rect(0, 0, 10, 4))).toBeCloseTo(2, 9);
    // rotated obstacle crossing a thin plate
    const plate = rect(-50, 0, 50, 2);
    const tilted = [P(0, -5), P(5, 0), P(0, 5), P(-5, 0)];
    expect(penetrationDepth(plate, tilted)).toBeGreaterThan(0.9);
  });

  it('polygonDistance', () => {
    expect(polygonDistance(rect(0, 0, 1, 1), rect(3, 0, 4, 1))).toBeCloseTo(2, 12);
    expect(polygonDistance(rect(0, 0, 1, 1), rect(0.5, 0.5, 4, 1))).toBe(0);
    expect(polygonDistance(rect(0, 0, 1, 1), rect(2, 2, 3, 3))).toBeCloseTo(Math.SQRT2, 12);
  });

  it('sharedBoundaryLength', () => {
    expect(sharedBoundaryLength(rect(0, 0, 2, 2), rect(2, 1, 4, 5))).toBeCloseTo(1, 12);
    expect(sharedBoundaryLength(rect(0, 0, 2, 2), rect(3, 0, 4, 1))).toBe(0);
    expect(sharedBoundaryLength(rect(0, 0, 2, 2), rect(2, 2, 4, 4))).toBe(0); // corner touch
    expect(sharedBoundaryLength(rect(0, 0, 2, 2), rect(0.5, 2, 1.5, 3))).toBeCloseTo(1, 12);
  });

  it('convexHull / thickenSegment', () => {
    const h = convexHull([P(0, 0), P(2, 0), P(1, 1), P(2, 2), P(0, 2), P(1, 0.5), P(1, 0)]);
    expect(h.length).toBe(4);
    expect(isCCW(h)).toBe(true);
    expect(area(h)).toBe(4);
    const t = thickenSegment(P(0, 0), P(4, 0), 1);
    expect(isCCW(t)).toBe(true);
    expect(area(t)).toBe(8);
    expect(bounds(t)).toEqual({ min: { x: 0, y: -1 }, max: { x: 4, y: 1 } });
    const te = thickenSegment(P(0, 0), P(4, 0), 1, 0.5);
    expect(bounds(te).min.x).toBe(-0.5);
  });
});

describe('splitPolygonByLine', () => {
  it('splits a rectangle', () => {
    const { left, right } = splitPolygonByLine(rect(0, 0, 4, 2), P(1, 0), P(0, 1));
    expect(left.length).toBe(1); expect(right.length).toBe(1);
    expect(area(left[0]!)).toBeCloseTo(2, 12);   // x < 1
    expect(area(right[0]!)).toBeCloseTo(6, 12);
    expect(isCCW(left[0]!) && isCCW(right[0]!)).toBe(true);
    expect(bounds(left[0]!).max.x).toBeCloseTo(1, 12);
  });

  it('whole polygon on one side, on-line edges', () => {
    const r = rect(0, 0, 4, 2);
    const a = splitPolygonByLine(r, P(0, 0), P(0, 1));  // line x = 0 along the left edge
    expect(a.left.length).toBe(0); expect(a.right.length).toBe(1);
    const b = splitPolygonByLine(r, P(9, 0), P(0, 1));
    expect(b.left.length).toBe(1); expect(b.right.length).toBe(0);
  });

  it('concave polygon → two pieces on one side (U shape)', () => {
    // U: outer 6×4 with a slot from the top 2..4 down to y=1
    const u: Polygon2 = [P(0, 0), P(6, 0), P(6, 4), P(4, 4), P(4, 1), P(2, 1), P(2, 4), P(0, 4)];
    const { left, right } = splitPolygonByLine(u, P(0, 2), P(1, 0)); // y = 2, left = y > 2
    expect(left.length).toBe(2);
    expect(right.length).toBe(1);
    expect(sum(left.map(area))).toBeCloseTo(8, 12);
    expect(area(right[0]!)).toBeCloseTo(12 - 2, 12);
    for (const p of [...left, ...right]) expect(isCCW(p)).toBe(true);
  });

  it('notch touching the line from one side (reflex pinch) → two separate pieces', () => {
    const p: Polygon2 = [P(-5, -5), P(5, -5), P(5, 5), P(0, 0), P(-5, 5)];
    const { left, right } = splitPolygonByLine(p, P(0, 0), P(1, 0));
    expect(left.length).toBe(2);
    expect(right.length).toBe(1);
    expect(sum(left.map(area))).toBeCloseTo(25, 12);
    expect(area(right[0]!)).toBeCloseTo(50, 12);
  });

  it('convex touch from one side keeps one piece', () => {
    // triangle above the line touching at the origin plus a base below via a stem
    const p: Polygon2 = [P(-1, 1), P(-1, -2), P(1, -2), P(1, 1), P(0.5, 1), P(0, 0), P(-0.5, 1)];
    // line y = 0: below = rectangle 2×2, above = two small triangles? No: the touch point is a
    // convex vertex of the upper region → the upper part is two pieces separated at the touch.
    const { left, right } = splitPolygonByLine(ensureCCW(p), P(0, 0), P(1, 0));
    expect(right.length).toBe(1);
    expect(area(right[0]!)).toBeCloseTo(4, 12);
    expect(sum(left.map(area))).toBeCloseTo(2 - 0.5, 12);
  });

  it('box cross-shape split by a line containing outline edges', () => {
    const c = 30.524, w = 253.048, h = 203.048;
    const cross: Polygon2 = [P(c, 0), P(w - c, 0), P(w - c, c), P(w, c), P(w, h - c), P(w - c, h - c), P(w - c, h), P(c, h), P(c, h - c), P(0, h - c), P(0, c), P(c, c)];
    const { left, right } = splitPolygonByLine(cross, P(c, 0), P(0, 1)); // vertical line x = c
    expect(left.length).toBe(1);
    expect(right.length).toBe(1);
    expect(area(left[0]!)).toBeCloseTo(c * (h - 2 * c), 9);
    expect(area(left[0]!) + area(right[0]!)).toBeCloseTo(area(cross), 9);
    for (const p of [...left, ...right]) expect(isCCW(p)).toBe(true);
  });

  it('vertices within 1e-6 of the line are treated as on the line', () => {
    const r: Polygon2 = [P(0, 0), P(4, 1e-8), P(4, 2), P(0, 2)];
    const { left, right } = splitPolygonByLine(r, P(0, 0), P(1, 0));
    expect(right.length).toBe(0);
    expect(left.length).toBe(1);
  });

  it('clipPolygonByHalfPlane keeps the normal side', () => {
    const out = clipPolygonByHalfPlane(rect(0, 0, 4, 2), P(1, 0), P(1, 0));
    expect(out.length).toBe(1);
    expect(bounds(out[0]!).min.x).toBeCloseTo(1, 12);
    expect(area(out[0]!)).toBeCloseTo(6, 12);
  });

  it('CW input is handled (output CCW)', () => {
    const cw = rect(0, 0, 4, 2).reverse();
    const { left, right } = splitPolygonByLine(cw, P(2, 0), P(0, 1));
    expect(left.length).toBe(1); expect(right.length).toBe(1);
    expect(isCCW(left[0]!) && isCCW(right[0]!)).toBe(true);
  });
});

describe('arcs', () => {
  it('arcToPoints respects chord tolerance and direction', () => {
    const pts = arcToPoints(P(0, 0), 10, 0, 90, true);
    expect(pts[0]!.x).toBeCloseTo(10, 12); expect(pts[0]!.y).toBeCloseTo(0, 12);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(0, 12); expect(pts[pts.length - 1]!.y).toBeCloseTo(10, 12);
    // chord error ≤ 0.05
    const step = (Math.PI / 2) / (pts.length - 1);
    expect(10 * (1 - Math.cos(step / 2))).toBeLessThanOrEqual(0.05 + 1e-9);
    const cw = arcToPoints(P(0, 0), 10, 0, 90, false);
    expect(cw[cw.length - 1]!.y).toBeCloseTo(10, 12);
    expect(cw.length).toBeGreaterThan(pts.length); // 270° sweep
    const full = arcToPoints(P(0, 0), 1, 0, 360, true);
    expect(full.length).toBeGreaterThanOrEqual(9);
    expect(arcToPoints(P(0, 0), 1, 30, 30, true).length).toBe(1);
  });

  it('bulgeArcToPoints: quarter circle CCW/CW and zero bulge', () => {
    const b = Math.tan(Math.PI / 8); // 90° arc
    const pts = bulgeArcToPoints(P(1, 0), P(0, 1), b);
    expect(pts[0]).toEqual(P(1, 0));
    expect(pts[pts.length - 1]).toEqual(P(0, 1));
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9); // centred at the origin
    const mid = pts[Math.floor(pts.length / 2)]!;
    expect(mid.x).toBeGreaterThan(0); expect(mid.y).toBeGreaterThan(0);
    const cw = bulgeArcToPoints(P(1, 0), P(0, 1), -b);
    const midCw = cw[Math.floor(cw.length / 2)]!;
    // CW arc from (1,0) to (0,1) bulges toward (1,1)
    expect(Math.hypot(midCw.x - 1, midCw.y - 1)).toBeCloseTo(1, 9);
    expect(bulgeArcToPoints(P(0, 0), P(1, 0), 0)).toEqual([P(0, 0), P(1, 0)]);
    // semicircle (bulge 1)
    const semi = bulgeArcToPoints(P(-1, 0), P(1, 0), 1);
    for (const p of semi) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 9);
    expect(Math.min(...semi.map(p => p.y))).toBeLessThan(-0.9); // CCW from (-1,0) to (1,0) goes through (0,-1)
    expect(Math.max(...semi.map(p => p.y))).toBeCloseTo(0, 9);
  });
});

describe('3D helpers', () => {
  it('projectToXY / transformPolygon / normal', () => {
    const sq = [P(0, 0), P(2, 0), P(2, 2), P(0, 2)].map(p => ({ x: p.x, y: p.y, z: 5 }));
    expect(projectToXY(sq)).toEqual([P(0, 0), P(2, 0), P(2, 2), P(0, 2)]);
    expect(polygonNormal(sq)).toEqual({ x: 0, y: 0, z: 1 });
    const m = mat4.rotationAxisAngle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 90);
    const t = transformPolygon(sq, m);
    expect(t[2]!.y).toBeCloseTo(-5, 12); expect(t[2]!.z).toBeCloseTo(2, 12);
    const n = polygonNormal(t);
    expect(n.y).toBeCloseTo(-1, 12);
  });

  it('clipToZ on a tilted polygon and a vertical wall', () => {
    // square in the XZ plane (normal ±Y), z from 0 to 10
    const wall = [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 4, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }];
    const parts = clipToZ(wall, 2, 5);
    expect(parts.length).toBe(1);
    const zs = parts[0]!.map(p => p.z);
    expect(Math.min(...zs)).toBeCloseTo(2, 9); expect(Math.max(...zs)).toBeCloseTo(5, 9);
    expect(polygonNormal(parts[0]!).y).toBeCloseTo(polygonNormal(wall).y, 9);
    expect(clipToZ(wall, 20, 30).length).toBe(0);
    expect(clipToZ(wall, -1, 11).length).toBe(1);
    // horizontal polygon
    const flat = [{ x: 0, y: 0, z: 3 }, { x: 4, y: 0, z: 3 }, { x: 4, y: 4, z: 3 }, { x: 0, y: 4, z: 3 }];
    expect(clipToZ(flat, 0, 5).length).toBe(1);
    expect(clipToZ(flat, 4, 5).length).toBe(0);
    // tilted plane, concave polygon → two pieces
    const u = [P(0, 0), P(6, 0), P(6, 4), P(4, 4), P(4, 1), P(2, 1), P(2, 4), P(0, 4)];
    const tilted = u.map(p => ({ x: p.x, y: p.y * 0.5, z: p.y })); // z = y
    const pieces = clipToZ(tilted, 2, 4);
    expect(pieces.length).toBe(2);
  });

  it('affine 2D transforms', () => {
    const m = affineMultiply(affineTranslation(1, 0), affineRotation(90));
    const p = transformPolygon2([P(1, 0)], m)[0]!;
    expect(p.x).toBeCloseTo(1, 12); expect(p.y).toBeCloseTo(1, 12);
  });

  it('simplifyCollinear', () => {
    const p = simplifyCollinear([P(0, 0), P(1, 0), P(2, 0), P(2, 2), P(0, 2)]);
    expect(p.length).toBe(4);
  });
});
