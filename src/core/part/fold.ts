/**
 * Fold kinematics — constant-arc-length model (ARCHITECTURE "Fold kinematics",
 * docs/specs/core-geometry.md §3.3).
 */
import type { BendLine, Flange, FoldState, FoldedGeometry, Mat4, PartModel, Polygon3, Vec2, Vec3 } from '../types';
import { mat4, vec2, vec3, centroid, transformPolygon, bounds3 } from '../geom';
import { bendFrame, coordD, regionsSideOfBend } from './frame';
import type { BendFrame } from './frame';
import { STRAIGHT_ANGLE, zoneSurfaceSamples } from './zone';

export interface DerivedLink {
  bendId: string;
  bend: BendLine;
  parentFlangeId: string;
  childFlangeId: string;
  frame: BendFrame;
  /** Unit direction across the bend line from the parent toward the child (FLAT). */
  dHat: Vec2;
  /** Zone start line (parent side) end points, FLAT. */
  s0: Vec2;
  s1: Vec2;
  /** +1 'up' / −1 'down'. */
  sigma: 1 | -1;
  /** k·t */
  kt: number;
  ba: number;
}

export interface DerivedPart {
  flangeById: Map<string, Flange>;
  /** Tree links (bends that join a parent to a child flange), in PartModel.links order. */
  links: DerivedLink[];
  linkByBend: Map<string, DerivedLink>;
  /** Bends that are not tree links but touch a flange: rendered as straight strips attached to it. */
  loose: DerivedLink[];
}

function makeLink(part: PartModel, bend: BendLine, parentFlangeId: string, childFlangeId: string, dHat: Vec2, frame: BendFrame, ba: number): DerivedLink {
  const back = vec2.scale(dHat, -ba / 2);
  return {
    bendId: bend.id, bend, parentFlangeId, childFlangeId, frame, dHat,
    s0: vec2.add(bend.p0, back), s1: vec2.add(bend.p1, back),
    sigma: bend.direction === 'up' ? 1 : -1, kt: bend.kFactor * part.flat.thickness, ba,
  };
}

/** Per-part data used by fold / pose / extent (cheap; recomputed on every call so edits are never stale). */
export function derivePart(part: PartModel): DerivedPart {
  const flangeById = new Map(part.flanges.map(f => [f.id, f]));
  const bendById = new Map(part.flat.bends.map(b => [b.id, b]));
  const links: DerivedLink[] = [];
  for (const l of part.links) {
    const bend = bendById.get(l.bendId);
    const child = flangeById.get(l.childFlangeId);
    if (!bend || !child) continue;
    const ba = part.bendAllowance[l.bendId] ?? 0;
    const frame = bendFrame(bend, ba);
    let side = regionsSideOfBend(child.regions.map(r => r.polygon), frame);
    if (side === 0) {
      // not adjacent by an edge (should not happen for a built model): fall back to the centroid side
      const c = centroid(child.regions[0]?.polygon ?? [bend.p0]);
      side = coordD(frame, c) >= 0 ? 1 : -1;
    }
    links.push(makeLink(part, bend, l.parentFlangeId, l.childFlangeId, vec2.scale(frame.n, side), frame, ba));
  }
  const linkByBend = new Map(links.map(l => [l.bendId, l]));
  // bends that are not links (no material on one side, cycle, self-loop): attach the zone strip to
  // the largest flange touching the bend, pointing away from it
  const loose: DerivedLink[] = [];
  for (const bend of part.flat.bends) {
    if (linkByBend.has(bend.id)) continue;
    const owner = part.flanges.find(f => f.bendIds.includes(bend.id));
    if (!owner) continue;
    const ba = part.bendAllowance[bend.id] ?? 0;
    const frame = bendFrame(bend, ba);
    let side = regionsSideOfBend(owner.regions.map(r => r.polygon), frame);
    if (side === 0) side = coordD(frame, centroid(owner.regions[0]?.polygon ?? [bend.p0])) >= 0 ? 1 : -1;
    loose.push(makeLink(part, bend, owner.id, owner.id, vec2.scale(frame.n, -side), frame, ba));
  }
  return { flangeById, links, linkByBend, loose };
}

export function flatState(part: PartModel): FoldState {
  const s: FoldState = {};
  for (const b of part.flat.bends) s[b.id] = 0;
  return s;
}

export function finishedState(part: PartModel): FoldState {
  const s: FoldState = {};
  for (const b of part.flat.bends) s[b.id] = 1;
  return s;
}

const Z: Vec3 = { x: 0, y: 0, z: 1 };
const lift = (p: Vec2): Vec3 => ({ x: p.x, y: p.y, z: 0 });

/** Bounds of the folded geometry including thickness, optionally mapped through `transform`. */
export function partBoundsFolded(folded: FoldedGeometry, thickness: number, transform?: Mat4): { min: Vec3; max: Vec3 } {
  const pts: Vec3[] = [];
  const map = (p: Vec3): Vec3 => (transform ? mat4.applyToPoint(transform, p) : p);
  for (const f of folded.flanges) {
    const off = vec3.scale(f.normal, thickness / 2);
    for (const r of f.regions) {
      for (const p of r.midSurface) { pts.push(map(vec3.add(p, off))); pts.push(map(vec3.sub(p, off))); }
    }
  }
  for (const b of folded.bends) {
    for (const lambda of [0, 1]) {
      const s = zoneSurfaceSamples(b, thickness, lambda, 12);
      for (const p of s.inner) pts.push(map(p));
      for (const p of s.outer) pts.push(map(p));
    }
  }
  if (pts.length === 0) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return bounds3(pts);
}

/** Straight-strip zone entry (θf < 0.01°) for a link carried by the parent transform `tp`. */
function straightZone(l: DerivedLink, tp: Mat4, thickness: number, theta: number): FoldedGeometry['bends'][number] {
  const tangentFlat = lift(l.dHat);
  const axisFlat = vec3.scale(vec3.cross(tangentFlat, Z), l.sigma);   // σ·(d̂ × w)
  const mid = vec3.midpoint(lift(l.bend.p0), lift(l.bend.p1));
  return {
    bendId: l.bendId, currentAngle: theta, zoneWidth: l.ba,
    axisPoint: mat4.applyToPoint(tp, mid), axisDir: vec3.normalize(mat4.applyToDir(tp, axisFlat)),
    midRadius: Number.POSITIVE_INFINITY, innerRadius: Number.POSITIVE_INFINITY,
    startEdge: [mat4.applyToPoint(tp, lift(l.s0)), mat4.applyToPoint(tp, lift(l.s1))],
    toCentre: vec3.normalize(mat4.applyToDir(tp, Z)), tangent: vec3.normalize(mat4.applyToDir(tp, tangentFlat)), thickness,
  };
}

/**
 * Geometry of the part in PART frame for a fold state (missing bend id ⇒ 0). The parent of each
 * link stays fixed; the child subtree is carried by the arc: child = R(C, a, θf)·T(−BA·d̂).
 */
export function foldGeometry(part: PartModel, state: FoldState): FoldedGeometry {
  const d = derivePart(part);
  const t = part.flat.thickness;
  const transforms = new Map<string, Mat4>();
  transforms.set(part.rootFlangeId, mat4.identity());
  const bends: FoldedGeometry['bends'] = [];

  // part.links is in BFS order (parents first); loop until every resolvable link is done anyway
  const pending = d.links.slice();
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const l = pending[i]!;
      const tp = transforms.get(l.parentFlangeId);
      if (!tp) continue;
      pending.splice(i, 1); i--; progress = true;

      const raw = state[l.bendId];
      const frac = Number.isFinite(raw) ? Math.max(0, raw as number) : 0;
      const theta = frac * l.bend.angle;
      if (theta < STRAIGHT_ANGLE) {
        transforms.set(l.childFlangeId, tp);
        bends.push(straightZone(l, tp, t, theta));
        continue;
      }
      const tangentFlat = lift(l.dHat);
      const axisFlat = vec3.scale(vec3.cross(tangentFlat, Z), l.sigma);   // σ·(d̂ × w)
      const S0 = lift(l.s0), S1 = lift(l.s1);
      const Smid = vec3.midpoint(S0, S1);
      const rn = l.ba / ((theta * Math.PI) / 180);
      const riF = rn - l.kt;
      const rm = riF + t / 2;
      const wSigned = vec3.scale(Z, l.sigma);
      const C = vec3.add(Smid, vec3.scale(wSigned, rm));
      const M = mat4.multiply(mat4.rotationAxisAngle(C, axisFlat, theta), mat4.translation(vec3.scale(tangentFlat, -l.ba)));
      transforms.set(l.childFlangeId, mat4.multiply(tp, M));
      bends.push({
        bendId: l.bendId, currentAngle: theta, zoneWidth: l.ba,
        axisPoint: mat4.applyToPoint(tp, C), axisDir: vec3.normalize(mat4.applyToDir(tp, axisFlat)),
        midRadius: rm, innerRadius: riF,
        startEdge: [mat4.applyToPoint(tp, S0), mat4.applyToPoint(tp, S1)],
        toCentre: vec3.normalize(mat4.applyToDir(tp, wSigned)), tangent: vec3.normalize(mat4.applyToDir(tp, tangentFlat)), thickness: t,
      });
    }
  }
  // loose bends: flat strips carried by the flange they touch (never fold)
  for (const l of d.loose) bends.push(straightZone(l, transforms.get(l.parentFlangeId) ?? mat4.identity(), t, 0));

  const flanges: FoldedGeometry['flanges'] = part.flanges.map(f => {
    const tf = transforms.get(f.id) ?? mat4.identity();
    const regions = f.regions.map(r => ({
      midSurface: transformPolygon(r.polygon.map(lift), tf) as Polygon3,
      holes: r.holes.map(h => transformPolygon(h.map(lift), tf) as Polygon3),
    }));
    return { flangeId: f.id, transform: tf, regions, normal: vec3.normalize(mat4.applyToDir(tf, Z)) };
  });

  const folded: FoldedGeometry = { flanges, bends, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } };
  folded.bounds = partBoundsFolded(folded, t);
  return folded;
}
