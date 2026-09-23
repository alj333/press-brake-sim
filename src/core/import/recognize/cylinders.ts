/**
 * Cylinder fitting for curved faces (docs/specs/recognize-3d.md §1.4): axis direction from cross
 * products of well-separated normals, axis point + radius by an algebraic circle fit of the
 * vertices projected along the axis, inner/outer from the normals, angular extent from the
 * vertex angles.
 */
import type { Vec3 } from '../../types';
import { vec3, planeBasis } from '../../geom';
import type { Topology } from './topology';
import { angleBetween, triCentroid, triNormal, vertex } from './topology';

export interface CylinderFit {
  axisDir: Vec3;
  /** Point on the axis at the middle of the face's axial extent. */
  centre: Vec3;
  radius: number;
  rmsError: number;
  maxError: number;
  /** Normals point toward the axis (concave side of a bend). */
  inner: boolean;
  /** Angular extent of the vertices about the axis (deg), 360 − largest gap. */
  extentDeg: number;
  /** A hole / boss (closed cylinder), not a bend: extent ≥ 350°, or ≥ 300° with no gap larger than
   *  2.5× the facet step (coarse tessellations, e.g. 24 facets at 15°). */
  full: boolean;
  /** Axial range of the vertices relative to `centre` (sMin = −length/2). */
  sMin: number;
  sMax: number;
  length: number;
  /** Unique vertex ids of the face. */
  vertices: number[];
}

/** Unique vertex ids of a triangle set. */
export function uniqueVertices(topo: Topology, tris: number[]): number[] {
  const seen = new Set<number>();
  for (const t of tris) {
    seen.add(topo.indices[t * 3]!); seen.add(topo.indices[t * 3 + 1]!); seen.add(topo.indices[t * 3 + 2]!);
  }
  return [...seen];
}

/** Axis direction ⟂ to all normals: area-weighted, sign-consistent sum of n0 × n_i over well-separated normals. */
export function cylinderAxisDirection(topo: Topology, tris: number[]): Vec3 | null {
  let largest = -1, largestArea = -1;
  for (const t of tris) if (topo.areas[t]! > largestArea) { largestArea = topo.areas[t]!; largest = t; }
  if (largest < 0) return null;
  const n0 = triNormal(topo, largest);
  let maxAng = 0;
  for (const t of tris) { const a = angleBetween(n0, triNormal(topo, t)); if (a > maxAng) maxAng = a; }
  const threshold = Math.max(0.5, maxAng / 4);
  let sum: Vec3 = { x: 0, y: 0, z: 0 };
  let any = false;
  for (const t of tris) {
    const n = triNormal(topo, t);
    if (angleBetween(n0, n) < threshold) continue;
    let c = vec3.cross(n0, n);
    if (any && vec3.dot(c, sum) < 0) c = vec3.neg(c);
    sum = vec3.add(sum, vec3.scale(c, topo.areas[t]!));
    any = true;
  }
  if (!any || vec3.length(sum) < 1e-12) return null;
  return vec3.normalize(sum);
}

/** Algebraic (Kåsa) circle fit: minimise Σ(x² + y² + Dx + Ey + F)². Returns null when singular. */
export function fitCircle2d(xs: number[], ys: number[]): { cx: number; cy: number; r: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = ys[i]!, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z;
  }
  // [sxx sxy sx; sxy syy sy; sx sy n] · [D E F]ᵀ = −[sxz syz sz]ᵀ
  const det = sxx * (syy * n - sy * sy) - sxy * (sxy * n - sy * sx) + sx * (sxy * sy - syy * sx);
  if (Math.abs(det) < 1e-18) return null;
  const bx = -sxz, by = -syz, bz = -sz;
  const D = (bx * (syy * n - sy * sy) - sxy * (by * n - sy * bz) + sx * (by * sy - syy * bz)) / det;
  const E = (sxx * (by * n - sy * bz) - bx * (sxy * n - sy * sx) + sx * (sxy * bz - by * sx)) / det;
  const F = (sxx * (syy * bz - by * sy) - sxy * (sxy * bz - by * sx) + bx * (sxy * sy - syy * sx)) / det;
  const cx = -D / 2, cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!(r2 > 0)) return null;
  return { cx, cy, r: Math.sqrt(r2) };
}

/** Fit a cylinder to a set of triangles. Null when the axis or the circle cannot be determined. */
export function fitCylinder(topo: Topology, tris: number[]): CylinderFit | null {
  const axisDir = cylinderAxisDirection(topo, tris);
  if (!axisDir) return null;
  const verts = uniqueVertices(topo, tris);
  if (verts.length < 4) return null;
  const { e1, e2 } = planeBasis(axisDir);
  // centroid of the vertices
  let mx = 0, my = 0, mz = 0;
  for (const v of verts) { const p = vertex(topo, v); mx += p.x; my += p.y; mz += p.z; }
  const mean: Vec3 = { x: mx / verts.length, y: my / verts.length, z: mz / verts.length };
  const xs: number[] = [], ys: number[] = [], ss: number[] = [];
  for (const v of verts) {
    const d = vec3.sub(vertex(topo, v), mean);
    xs.push(vec3.dot(d, e1)); ys.push(vec3.dot(d, e2)); ss.push(vec3.dot(d, axisDir));
  }
  const circle = fitCircle2d(xs, ys);
  if (!circle) return null;
  // radius = mean distance, residuals
  let rSum = 0;
  const dists: number[] = [];
  for (let i = 0; i < xs.length; i++) { const d = Math.hypot(xs[i]! - circle.cx, ys[i]! - circle.cy); dists.push(d); rSum += d; }
  const radius = rSum / xs.length;
  let sq = 0, maxError = 0;
  for (const d of dists) { const e = Math.abs(d - radius); sq += e * e; if (e > maxError) maxError = e; }
  const rmsError = Math.sqrt(sq / dists.length);
  // axial range
  let sMin = Infinity, sMax = -Infinity;
  for (const s of ss) { if (s < sMin) sMin = s; if (s > sMax) sMax = s; }
  const sMid = (sMin + sMax) / 2;
  const centre = vec3.add(mean, vec3.add(vec3.add(vec3.scale(e1, circle.cx), vec3.scale(e2, circle.cy)), vec3.scale(axisDir, sMid)));
  // inner / outer from the normals
  let towards = 0;
  for (const t of tris) {
    const c = triCentroid(topo, t);
    const q = vec3.sub(centre, c);
    const qPerp = vec3.sub(q, vec3.scale(axisDir, vec3.dot(q, axisDir)));
    towards += topo.areas[t]! * vec3.dot(triNormal(topo, t), qPerp);
  }
  // angular extent = 360° − the largest gap between the sorted vertex angles
  const angles: number[] = [];
  for (let i = 0; i < xs.length; i++) angles.push(Math.atan2(ys[i]! - circle.cy, xs[i]! - circle.cx));
  angles.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < angles.length; i++) gaps.push(angles[i]! - angles[i - 1]!);
  gaps.push(angles[0]! + 2 * Math.PI - angles[angles.length - 1]!);
  let maxGap = 0;
  for (const g of gaps) if (g > maxGap) maxGap = g;
  const extentDeg = 360 - (maxGap * 180) / Math.PI;
  // a hole / boss (full cylinder) has no gap noticeably larger than its facet step: the largest gap is
  // at most 2.5× the second largest (coarse tessellations, e.g. 12 facets, count too); a bend's missing
  // arc is many facet steps wide
  const sortedGaps = gaps.slice().sort((a, b) => b - a);
  const second = sortedGaps.length > 1 ? sortedGaps[1]! : 0;
  const full = extentDeg >= 350 || (extentDeg >= 300 && maxGap <= 2.5 * second + 1e-9);
  return {
    axisDir, centre, radius, rmsError, maxError, inner: towards > 0, extentDeg, full,
    sMin: sMin - sMid, sMax: sMax - sMid, length: sMax - sMin, vertices: verts,
  };
}

/** A fit is usable as a cylinder when the residuals are tiny compared with the radius. */
export function cylinderFitOk(fit: CylinderFit): boolean {
  return fit.maxError <= Math.max(0.05, 0.01 * fit.radius) && fit.radius > 0.05 && fit.radius < 1e5;
}
