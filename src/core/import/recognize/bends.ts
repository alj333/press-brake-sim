/**
 * Bend detection: pair inner / outer cylinders and find the tangent flange faces of each.
 * See docs/specs/recognize-3d.md §1.6.
 */
import type { Vec3 } from '../../types';
import { vec3 } from '../../geom';
import type { Topology } from './topology';
import { angleBetween, vertex } from './topology';
import type { Grouping, PlanarFace } from './faces';
import type { CylinderFit } from './cylinders';

export interface CylFace { id: number; tris: number[]; fit: CylinderFit }

export interface BendCandidate {
  inner: CylFace;
  outer: CylFace;
  /** Bend angle from flat (deg) = angular extent of the inner cylinder. */
  angle: number;
  innerRadius: number;
  length: number;
  axisDir: Vec3;
  axisPoint: Vec3;
  /** Planar face ids tangent to the inner / outer cylinder (exactly two each). */
  innerFlanges: [number, number];
  outerFlanges: [number, number];
}

/** Planar faces adjacent to a face, with the shared triangle edges (vertex pairs, oriented as the face winds). */
export function faceNeighbours(topo: Topology, grouping: Grouping, faceId: number): Map<number, Array<[number, number]>> {
  const out = new Map<number, Array<[number, number]>>();
  for (const t of grouping.faces[faceId]!.tris) {
    for (let k = 0; k < 3; k++) {
      const u = topo.adj[t * 3 + k]!;
      if (u < 0) continue;
      const other = grouping.faceOf[u]!;
      if (other === faceId) continue;
      const e: [number, number] = [topo.indices[t * 3 + k]!, topo.indices[t * 3 + ((k + 1) % 3)]!];
      const list = out.get(other);
      if (list) list.push(e); else out.set(other, [e]);
    }
  }
  return out;
}

const FLANGE_PERP_DEG = 10;
const TANGENT_DEG = 3;
/** A cylinder no longer (along its axis) than this × t is an outline rounding, never a bend. */
const ROUNDING_LENGTH_FACTOR = 1.2;

/** Planar faces tangent to a cylinder along its long edges (normal ⟂ axis and matching the cylinder normal there). */
export function tangentFlanges(topo: Topology, grouping: Grouping, planarById: Map<number, PlanarFace>, cyl: CylFace): number[] {
  const res: number[] = [];
  const a = cyl.fit.axisDir, c = cyl.fit.centre, s = cyl.fit.inner ? -1 : 1;
  for (const [other, edges] of faceNeighbours(topo, grouping, cyl.id)) {
    const pf = planarById.get(other);
    if (!pf) continue;
    if (Math.abs(vec3.dot(pf.normal, a)) > Math.sin((FLANGE_PERP_DEG * Math.PI) / 180)) continue;
    // cylinder normal at the shared edge midpoint
    const [va, vb] = edges[0]!;
    const q = vec3.midpoint(vertex(topo, va), vertex(topo, vb));
    const d = vec3.sub(q, c);
    const radial = vec3.sub(d, vec3.scale(a, vec3.dot(d, a)));
    const cylNormal = vec3.scale(vec3.normalize(radial), s);
    if (angleBetween(cylNormal, pf.normal) > TANGENT_DEG) continue;
    res.push(other);
  }
  return res;
}

export interface PairingResult {
  bends: BendCandidate[];
  /** Partial cylinders that found no partner. */
  unpaired: CylFace[];
  /** Pairs dropped because a cylinder did not have exactly two tangent flanges. */
  flangesMissing: number;
  /** Partial cylinders that are not bend surfaces at all — corner roundings / edge fillets of the sheet
   *  outline: the axis is parallel to an adjacent planar face's normal (the sheet face) and the cylinder
   *  either touches no tangent flange or spans only the sheet thickness; or a convex cylinder smaller
   *  than the thickness (a bend's outer radius is ri + t ≥ t). Ignored silently. */
  roundings: CylFace[];
}

/** True when the cylinder's axis is parallel (within 10°) to the normal of a planar face it touches. */
function axisAlongNeighbourNormal(topo: Topology, grouping: Grouping, planarById: Map<number, PlanarFace>, cyl: CylFace): boolean {
  const cosTol = Math.cos((10 * Math.PI) / 180);
  for (const other of faceNeighbours(topo, grouping, cyl.id).keys()) {
    const pf = planarById.get(other);
    if (pf && Math.abs(vec3.dot(pf.normal, cyl.fit.axisDir)) >= cosTol) return true;
  }
  return false;
}

/** Axial interval of a cylinder's vertices projected on the direction `axis` (either sign of its own axis). */
function axialInterval(c: CylFace, axis: Vec3): [number, number] {
  const mid = vec3.dot(c.fit.centre, axis);
  const same = vec3.dot(c.fit.axisDir, axis) >= 0;
  return same ? [mid + c.fit.sMin, mid + c.fit.sMax] : [mid - c.fit.sMax, mid - c.fit.sMin];
}

/** Pair inner and outer partial cylinders into bends. */
export function pairCylinders(topo: Topology, grouping: Grouping, planarById: Map<number, PlanarFace>, cylinders: CylFace[], thickness: number): PairingResult {
  const partial = cylinders.filter(c => !c.fit.full);
  const inners = partial.filter(c => c.fit.inner), outers = partial.filter(c => !c.fit.inner);
  const usedOuter = new Set<number>();
  const bends: BendCandidate[] = [];
  const unpaired: CylFace[] = [];
  const roundings: CylFace[] = [];
  const radiusTol = Math.max(0.1, 0.05 * thickness);
  let flangesMissing = 0;
  const flangesOf = new Map<number, number[]>();
  const flanges = (c: CylFace): number[] => {
    let f = flangesOf.get(c.id);
    if (!f) { f = tangentFlanges(topo, grouping, planarById, c); flangesOf.set(c.id, f); }
    return f;
  };
  const isRounding = (c: CylFace): boolean =>
    // a convex cylinder smaller than the sheet thickness cannot be a bend's outer surface (ro = ri + t):
    // an edge fillet along a cut edge
    (!c.fit.inner && thickness > 0 && c.fit.radius < thickness - radiusTol)
    || (axisAlongNeighbourNormal(topo, grouping, planarById, c)
      && (flanges(c).length === 0 || (thickness > 0 && c.fit.length <= ROUNDING_LENGTH_FACTOR * thickness)));
  for (const inner of inners) {
    if (isRounding(inner)) { roundings.push(inner); continue; }
    let best: CylFace | null = null, bestScore = Infinity;
    const [i0, i1] = axialInterval(inner, inner.fit.axisDir);
    for (const outer of outers) {
      if (usedOuter.has(outer.id)) continue;
      const ai = inner.fit.axisDir, ao = outer.fit.axisDir;
      const ang = Math.min(angleBetween(ai, ao), angleBetween(ai, vec3.neg(ao)));
      if (ang > 1) continue;
      const dc = vec3.sub(outer.fit.centre, inner.fit.centre);
      const axisDist = vec3.length(vec3.cross(dc, ai));
      if (axisDist > 0.1) continue;
      const dr = Math.abs(outer.fit.radius - inner.fit.radius - thickness);
      if (dr > radiusTol) continue;
      // the two surfaces of one bend overlap along the axis (coaxial bends of separate tabs do not)
      const [o0, o1] = axialInterval(outer, ai);
      const shorter = Math.max(1e-9, Math.min(i1 - i0, o1 - o0));
      const overlap = (Math.min(i1, o1) - Math.max(i0, o0)) / shorter;
      if (overlap < 0.5) continue;
      const score = dr + axisDist + (1 - overlap);
      if (score < bestScore) { bestScore = score; best = outer; }
    }
    if (!best) { unpaired.push(inner); continue; }
    const innerFlanges = flanges(inner);
    const outerFlanges = flanges(best);
    if (innerFlanges.length !== 2 || outerFlanges.length !== 2) { flangesMissing++; usedOuter.add(best.id); continue; }
    usedOuter.add(best.id);
    bends.push({
      inner, outer: best,
      angle: inner.fit.extentDeg, innerRadius: inner.fit.radius, length: inner.fit.length,
      axisDir: inner.fit.axisDir, axisPoint: inner.fit.centre,
      innerFlanges: [innerFlanges[0]!, innerFlanges[1]!], outerFlanges: [outerFlanges[0]!, outerFlanges[1]!],
    });
  }
  for (const outer of outers) {
    if (usedOuter.has(outer.id)) continue;
    if (isRounding(outer)) roundings.push(outer); else unpaired.push(outer);
  }
  return { bends, unpaired, flangesMissing, roundings };
}
