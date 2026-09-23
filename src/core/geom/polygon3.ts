/** Planar 3D polygon helpers (pure). Polygon3 is CCW about its normal. */
import type { Mat4, Polygon2, Polygon3, Vec2, Vec3 } from '../types';
import * as vec3 from './vec3';
import { applyToPoint } from './mat4';
import { ensureCCW, splitPolygonByLine } from './polygon';

export function transformPolygon(poly: Polygon3, m: Mat4): Polygon3 {
  return poly.map(p => applyToPoint(m, p));
}

/** Newell normal (unit). Zero vector for degenerate polygons. */
export function polygonNormal(poly: Polygon3): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!;
    x += (a.y - b.y) * (a.z + b.z);
    y += (a.z - b.z) * (a.x + b.x);
    z += (a.x - b.x) * (a.y + b.y);
  }
  return vec3.normalize({ x, y, z });
}

/** Right-handed in-plane basis: e1 × e2 = normal (normal assumed unit). */
export function planeBasis(normal: Vec3): { e1: Vec3; e2: Vec3 } {
  const n = vec3.normalize(normal);
  const helper = Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const e1 = vec3.normalize(vec3.cross(helper, n));
  const e2 = vec3.cross(n, e1);
  return { e1, e2 };
}

/** Drop z, then make CCW. */
export function projectToXY(poly: Polygon3): Polygon2 {
  return ensureCCW(poly.map(p => ({ x: p.x, y: p.y })));
}

export function bounds3(points: Vec3[]): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    if (p.x < min.x) min.x = p.x; if (p.x > max.x) max.x = p.x;
    if (p.y < min.y) min.y = p.y; if (p.y > max.y) max.y = p.y;
    if (p.z < min.z) min.z = p.z; if (p.z > max.z) max.z = p.z;
  }
  return { min, max };
}

/**
 * Clip a planar 3D polygon to the band z0 ≤ z ≤ z1. The polygon is mapped into its plane's
 * (e1, e2) coordinates, split by the two lines z = z0 / z = z1, and mapped back. Winding about
 * the polygon normal is preserved (CCW). Horizontal polygons come back whole or not at all.
 */
export function clipToZ(poly: Polygon3, z0: number, z1: number, tol = 1e-6): Polygon3[] {
  if (poly.length < 3) return [];
  if (z0 > z1) [z0, z1] = [z1, z0];
  const n = polygonNormal(poly);
  if (vec3.lengthSq(n) === 0) return [];
  const { e1, e2 } = planeBasis(n);
  const origin = poly[0]!;
  const gz = { x: e1.z, y: e2.z };                       // gradient of z in (u, v)
  const g2 = gz.x * gz.x + gz.y * gz.y;
  const zMin = Math.min(...poly.map(p => p.z)), zMax = Math.max(...poly.map(p => p.z));
  if (zMax < z0 - tol || zMin > z1 + tol) return [];
  if (g2 < 1e-18 || (zMin >= z0 - tol && zMax <= z1 + tol)) return [poly];

  const to2 = (p: Vec3): Vec2 => { const r = vec3.sub(p, origin); return { x: vec3.dot(r, e1), y: vec3.dot(r, e2) }; };
  const to3 = (q: Vec2): Vec3 => vec3.add(origin, vec3.add(vec3.scale(e1, q.x), vec3.scale(e2, q.y)));
  // line z = zc in (u,v): gz·q = zc − origin.z; dir = gz rotated −90° so that "left" = +gz (increasing z)
  const lineFor = (zc: number) => {
    const k = (zc - origin.z) / g2;
    return { point: { x: gz.x * k, y: gz.y * k }, dir: { x: gz.y, y: -gz.x } };
  };
  let pieces: Polygon2[] = [ensureCCW(poly.map(to2))];
  if (zMin < z0 - tol) {
    const l0 = lineFor(z0);
    pieces = pieces.flatMap(p => splitPolygonByLine(p, l0.point, l0.dir, tol).left);
  }
  if (zMax > z1 + tol) {
    const l1 = lineFor(z1);
    pieces = pieces.flatMap(p => splitPolygonByLine(p, l1.point, l1.dir, tol).right);
  }
  return pieces.map(p => p.map(to3));
}
