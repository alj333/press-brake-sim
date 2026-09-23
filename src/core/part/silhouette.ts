/**
 * partSilhouette — machine-XY polygons of the folded part with their Z extents, for the
 * section view and the planner's Z-sliced collision model. See docs/specs/core-geometry.md §3.5.
 */
import type { FoldedGeometry, Mat4, Polygon2, Polygon3, Vec2, Vec3 } from '../types';
import { mat4, vec3, clipToZ, convexHull, dedupe, ensureCCW, thickenSegment, transformPolygon, area } from '../geom';
import { isStraightZone, zoneStripPoint, zoneSurfaceSamples } from './zone';
import type { FoldedBend } from './zone';

export type SilhouetteSource =
  | { kind: 'flange'; flangeId: string; regionIndex: number }
  | { kind: 'bend'; bendId: string };

export interface SilhouettePiece {
  /** CCW polygon in the machine XY plane. */
  polygon: Polygon2;
  /** Z extent of the material this polygon represents. */
  zRange: [number, number];
  source: SilhouetteSource;
}

const Z: Vec3 = { x: 0, y: 0, z: 1 };

function zRangeOf(pts: Vec3[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p.z < lo) lo = p.z; if (p.z > hi) hi = p.z; }
  return [lo, hi];
}

/** Silhouette of a planar mid-surface polygon (machine frame) of thickness t with unit normal n. */
function planarPiece(poly: Polygon3, n: Vec3, thickness: number): Polygon2 | null {
  if (poly.length < 3) return null;
  if (Math.abs(n.z) < 1e-6) {
    // plane contains Z: the projection is a segment along u = Z × n
    const u = vec3.normalize(vec3.cross(Z, n));
    let lo = Infinity, hi = -Infinity, pA: Vec2 = { x: 0, y: 0 }, pB: Vec2 = { x: 0, y: 0 };
    for (const p of poly) {
      const tau = p.x * u.x + p.y * u.y;
      if (tau < lo) { lo = tau; pA = { x: p.x, y: p.y }; }
      if (tau > hi) { hi = tau; pB = { x: p.x, y: p.y }; }
    }
    return thickenSegment(pA, pB, thickness / 2);
  }
  const off = vec3.scale(n, thickness / 2);
  const pts: Vec2[] = [];
  for (const p of poly) {
    pts.push({ x: p.x + off.x, y: p.y + off.y });
    pts.push({ x: p.x - off.x, y: p.y - off.y });
  }
  const hull = convexHull(pts);
  return hull.length >= 3 ? hull : null;
}

export function partSilhouette(folded: FoldedGeometry, partToMachine: Mat4, thickness: number, zBand?: [number, number]): SilhouettePiece[] {
  const out: SilhouettePiece[] = [];
  const band: [number, number] | undefined = zBand ? [Math.min(zBand[0], zBand[1]), Math.max(zBand[0], zBand[1])] : undefined;

  const emitPlanar = (poly3: Polygon3, n: Vec3, source: SilhouetteSource): void => {
    // the material extends ±t/2·|n.z| in Z beyond the mid-surface
    const ez = (thickness / 2) * Math.abs(n.z);
    const pieces = band ? clipToZ(poly3, band[0] - ez, band[1] + ez) : [poly3];
    for (const piece of pieces) {
      const polygon = planarPiece(piece, n, thickness);
      if (!polygon || area(polygon) <= 0) continue;
      const zr = zRangeOf(piece);
      out.push({ polygon: ensureCCW(polygon), zRange: [zr[0] - ez, zr[1] + ez], source });
    }
  };

  // flange regions (holes ignored — conservative)
  for (const f of folded.flanges) {
    const n = vec3.normalize(mat4.applyToDir(partToMachine, f.normal));
    f.regions.forEach((r, regionIndex) => {
      emitPlanar(transformPolygon(r.midSurface, partToMachine), n, { kind: 'flange', flangeId: f.flangeId, regionIndex });
    });
  }

  // bend zones
  for (const b of folded.bends) {
    const bm: FoldedBend = {
      ...b,
      axisPoint: mat4.applyToPoint(partToMachine, b.axisPoint),
      axisDir: vec3.normalize(mat4.applyToDir(partToMachine, b.axisDir)),
      startEdge: [mat4.applyToPoint(partToMachine, b.startEdge[0]), mat4.applyToPoint(partToMachine, b.startEdge[1])],
      toCentre: vec3.normalize(mat4.applyToDir(partToMachine, b.toCentre)),
      tangent: vec3.normalize(mat4.applyToDir(partToMachine, b.tangent)),
    };
    const source: SilhouetteSource = { kind: 'bend', bendId: b.bendId };
    if (isStraightZone(bm)) {
      const strip: Polygon3 = [
        zoneStripPoint(bm, 0, 0, 0), zoneStripPoint(bm, bm.zoneWidth, 0, 0),
        zoneStripPoint(bm, bm.zoneWidth, 1, 0), zoneStripPoint(bm, 0, 1, 0),
      ];
      emitPlanar(strip, bm.toCentre, source);
      continue;
    }
    const s0 = zoneSurfaceSamples(bm, thickness, 0, 8);
    const s1 = zoneSurfaceSamples(bm, thickness, 1, 8);
    const all = [...s0.inner, ...s0.outer, ...s1.inner, ...s1.outer];
    const zr = zRangeOf(all);
    if (band && (zr[1] < band[0] || zr[0] > band[1])) continue;
    const zRange: [number, number] = band ? [Math.max(zr[0], band[0]), Math.min(zr[1], band[1])] : zr;
    let polygon: Polygon2;
    if (Math.abs(bm.axisDir.z) > 1 - 1e-9) {
      // axis ∥ Z: exact annular sector (the same at every axial position)
      const ring: Vec2[] = [...s0.inner.map(p => ({ x: p.x, y: p.y })), ...s0.outer.slice().reverse().map(p => ({ x: p.x, y: p.y }))];
      polygon = ensureCCW(dedupe(ring));
    } else if (band) {
      // oblique axis: for each sampled (φ, r) the axial curve λ ∈ [0, 1] is a straight segment whose
      // z is linear in λ — clip it to the band and hull the clipped end points (tight, conservative)
      const pts: Vec2[] = [];
      const pairs = [[s0.inner, s1.inner], [s0.outer, s1.outer]] as const;
      for (const [a, b] of pairs) {
        for (let i = 0; i < a.length; i++) {
          const pa = a[i]!, pb = b[i]!;
          const dz = pb.z - pa.z;
          let l0 = 0, l1 = 1;
          if (Math.abs(dz) > 1e-12) {
            const la = (band[0] - pa.z) / dz, lb = (band[1] - pa.z) / dz;
            l0 = Math.max(0, Math.min(la, lb)); l1 = Math.min(1, Math.max(la, lb));
          } else if (pa.z < band[0] || pa.z > band[1]) continue;
          if (l1 < l0) continue;
          pts.push({ x: pa.x + (pb.x - pa.x) * l0, y: pa.y + (pb.y - pa.y) * l0 });
          pts.push({ x: pa.x + (pb.x - pa.x) * l1, y: pa.y + (pb.y - pa.y) * l1 });
        }
      }
      polygon = convexHull(pts);
    } else {
      polygon = convexHull(all.map(p => ({ x: p.x, y: p.y })));
    }
    if (polygon.length >= 3 && area(polygon) > 0) out.push({ polygon, zRange, source });
  }
  return out;
}
