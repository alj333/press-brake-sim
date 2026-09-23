/**
 * Face grouping (STEP face groups or normal-continuity region growing + facet chains) and planar
 * face fitting with boundary loops. See docs/specs/recognize-3d.md §1.2–1.3.
 */
import type { Polygon2, Polygon3, Vec3 } from '../../types';
import { vec3, planeBasis, signedArea } from '../../geom';
import type { Topology } from './topology';
import { angleBetween, triNormal, vertex } from './topology';
import { cylinderFitOk, fitCylinder } from './cylinders';

/** Planar faces: triangles within this angle of the running mean normal (CAD faces are exact; STL
 *  facets are ≥ 0.5° apart, their tangent dihedral half that — see docs/specs/recognize-3d.md §1.2). */
export const PLANAR_TOL_DEG = 0.2;
export const CURVED_MAX_DEG = 20;
export const FACET_WIDTH_RATIO = 4;
const COPLANAR_OFFSET = 0.02;

export interface FaceSet {
  tris: number[];
  kind: 'planar' | 'curved';
}

export interface Grouping {
  faces: FaceSet[];
  /** faceOf[t] = index into faces. */
  faceOf: Int32Array;
}

interface RawGroup { tris: number[]; normal: Vec3; area: number; sumN: Vec3 }

function meanNormal(topo: Topology, tris: number[]): { normal: Vec3; area: number; sumN: Vec3; degenerate: boolean } {
  let sx = 0, sy = 0, sz = 0, area = 0;
  for (const t of tris) {
    const a = topo.areas[t]!;
    sx += topo.normals[t * 3]! * a; sy += topo.normals[t * 3 + 1]! * a; sz += topo.normals[t * 3 + 2]! * a;
    area += a;
  }
  const l = Math.hypot(sx, sy, sz);
  const degenerate = !(l > 0.5 * area);
  return { normal: degenerate ? { x: 0, y: 0, z: 0 } : { x: sx / l, y: sy / l, z: sz / l }, area, sumN: { x: sx, y: sy, z: sz }, degenerate };
}

/** Planar when every triangle with a trustworthy normal (no sliver) is within PLANAR_TOL_DEG of the mean. */
function isPlanarSet(topo: Topology, tris: number[]): boolean {
  const m = meanNormal(topo, tris);
  if (m.degenerate) return false;
  for (const t of tris) {
    if (topo.sliver[t]) continue;
    if (angleBetween(m.normal, triNormal(topo, t)) > PLANAR_TOL_DEG) return false;
  }
  return true;
}

/** A group made of slivers only has no trustworthy normal. */
function allSlivers(topo: Topology, tris: number[]): boolean {
  for (const t of tris) if (!topo.sliver[t]) return false;
  return true;
}

function faceCentroid(topo: Topology, tris: number[]): Vec3 {
  let x = 0, y = 0, z = 0, a = 0;
  for (const t of tris) {
    const w = topo.areas[t]!;
    x += topo.centroids[t * 3]! * w; y += topo.centroids[t * 3 + 1]! * w; z += topo.centroids[t * 3 + 2]! * w; a += w;
  }
  return a > 0 ? { x: x / a, y: y / a, z: z / a } : { x: 0, y: 0, z: 0 };
}

/** Union-find helper. */
function find(parent: Int32Array, i: number): number {
  while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
  return i;
}

/** Adjacent group pairs with their shared triangle edges (as vertex pairs). */
function groupAdjacency(topo: Topology, groupOf: Int32Array, groupCount: number): Map<number, Array<[number, number]>> {
  const adjMap = new Map<number, Array<[number, number]>>();
  const G = groupCount + 1;
  for (let t = 0; t < topo.triCount; t++) {
    const gi = groupOf[t]!;
    for (let k = 0; k < 3; k++) {
      const u = topo.adj[t * 3 + k]!;
      if (u < 0) continue;
      const gj = groupOf[u]!;
      if (gi >= gj) continue;                         // each pair once, from the lower group id
      const key = gi * G + gj;
      const a = topo.indices[t * 3 + k]!, b = topo.indices[t * 3 + ((k + 1) % 3)]!;
      const list = adjMap.get(key);
      if (list) list.push([a, b]); else adjMap.set(key, [[a, b]]);
    }
  }
  return adjMap;
}

/** Merge adjacent coplanar planar groups (B-rep faces split by seams). */
function mergeCoplanar(topo: Topology, groups: RawGroup[], kinds: Array<'planar' | 'curved'>, groupOf: Int32Array): { groups: RawGroup[]; kinds: Array<'planar' | 'curved'>; groupOf: Int32Array } {
  const parent = new Int32Array(groups.length);
  for (let i = 0; i < groups.length; i++) parent[i] = i;
  const centroids = groups.map(g => faceCentroid(topo, g.tris));
  const adjMap = groupAdjacency(topo, groupOf, groups.length);
  const G = groups.length + 1;
  for (const key of adjMap.keys()) {
    const gi = Math.floor(key / G), gj = key % G;
    if (kinds[gi] !== 'planar' || kinds[gj] !== 'planar') continue;
    const ni = groups[gi]!.normal, nj = groups[gj]!.normal;
    // a group of slivers (float32 normal noise) merges into a neighbour by coplanarity alone
    const si = allSlivers(topo, groups[gi]!.tris), sj = allSlivers(topo, groups[gj]!.tris);
    if (si && sj) continue;
    if (!si && !sj && angleBetween(ni, nj) > PLANAR_TOL_DEG) continue;
    const nRef = si ? nj : ni;
    if (Math.abs(vec3.dot(nRef, vec3.sub(centroids[gj]!, centroids[gi]!))) > COPLANAR_OFFSET) continue;
    parent[find(parent, gi)] = find(parent, gj);
  }
  return relabel(topo, groups, kinds, parent);
}

function relabel(topo: Topology, groups: RawGroup[], kinds: Array<'planar' | 'curved'>, parent: Int32Array): { groups: RawGroup[]; kinds: Array<'planar' | 'curved'>; groupOf: Int32Array } {
  const rootIndex = new Map<number, number>();
  const outTris: number[][] = [], outKinds: Array<'planar' | 'curved'> = [];
  for (let i = 0; i < groups.length; i++) {
    const r = find(parent, i);
    let idx = rootIndex.get(r);
    if (idx === undefined) { idx = outTris.length; rootIndex.set(r, idx); outTris.push([]); outKinds.push(kinds[i]!); }
    for (const t of groups[i]!.tris) outTris[idx]!.push(t);
    if (kinds[i] === 'curved') outKinds[idx] = 'curved';
  }
  const groupOf = new Int32Array(topo.triCount).fill(-1);
  const outGroups: RawGroup[] = outTris.map((tris, gi) => {
    for (const t of tris) groupOf[t] = gi;
    const m = meanNormal(topo, tris);
    return { tris, normal: m.normal, area: m.area, sumN: m.sumN };
  });
  return { groups: outGroups, kinds: outKinds, groupOf };
}

/** STEP: one face per faceGroup, classified planar / curved, coplanar planar neighbours merged. */
function groupByFaceGroups(topo: Topology): Grouping {
  const groups: RawGroup[] = [], kinds: Array<'planar' | 'curved'> = [];
  const groupOf = new Int32Array(topo.triCount).fill(-1);
  for (const g of topo.faceGroups!) {
    const tris: number[] = [];
    for (let t = g.first; t <= g.last; t++) { tris.push(t); groupOf[t] = groups.length; }
    if (tris.length === 0) continue;
    const m = meanNormal(topo, tris);
    groups.push({ tris, normal: m.normal, area: m.area, sumN: m.sumN });
    kinds.push(isPlanarSet(topo, tris) ? 'planar' : 'curved');
  }
  // triangles outside every group (should not happen): each becomes its own planar face
  for (let t = 0; t < topo.triCount; t++) {
    if (groupOf[t] >= 0) continue;
    groupOf[t] = groups.length;
    const m = meanNormal(topo, [t]);
    groups.push({ tris: [t], normal: m.normal, area: m.area, sumN: m.sumN });
    kinds.push('planar');
  }
  const merged = mergeCoplanar(topo, groups, kinds, groupOf);
  return { faces: merged.groups.map((g, i) => ({ tris: g.tris, kind: merged.kinds[i]! })), faceOf: merged.groupOf };
}

/** Region growing: planar groups (≤ PLANAR_TOL_DEG from the running mean normal), largest triangles seeded first. */
function growPlanarGroups(topo: Topology): { groups: RawGroup[]; groupOf: Int32Array } {
  const order = Array.from({ length: topo.triCount }, (_, i) => i).sort((a, b) => topo.areas[b]! - topo.areas[a]!);
  const groupOf = new Int32Array(topo.triCount).fill(-1);
  const groups: RawGroup[] = [];
  const cosTol = Math.cos((PLANAR_TOL_DEG * Math.PI) / 180);
  for (const seed of order) {
    if (groupOf[seed] >= 0) continue;
    const gi = groups.length;
    const tris: number[] = [seed];
    groupOf[seed] = gi;
    let sx = topo.normals[seed * 3]! * topo.areas[seed]!, sy = topo.normals[seed * 3 + 1]! * topo.areas[seed]!, sz = topo.normals[seed * 3 + 2]! * topo.areas[seed]!;
    const queue = [seed];
    while (queue.length) {
      const t = queue.pop()!;
      for (let k = 0; k < 3; k++) {
        const u = topo.adj[t * 3 + k]!;
        if (u < 0 || groupOf[u] >= 0) continue;
        if (topo.sliver[u]) {
          // unreliable normal: joins the group it is reached from without voting (a sliver is a piece of
          // the face it is tessellated into; neighbours beyond it still have to pass the normal test)
          if (topo.sliver[seed]) continue;
          groupOf[u] = gi; tris.push(u); queue.push(u);
          continue;
        }
        const l = Math.hypot(sx, sy, sz);
        const d = l > 0 ? (topo.normals[u * 3]! * sx + topo.normals[u * 3 + 1]! * sy + topo.normals[u * 3 + 2]! * sz) / l : 1;
        if (d < cosTol) continue;
        groupOf[u] = gi; tris.push(u); queue.push(u);
        const a = topo.areas[u]!;
        sx += topo.normals[u * 3]! * a; sy += topo.normals[u * 3 + 1]! * a; sz += topo.normals[u * 3 + 2]! * a;
      }
    }
    const m = meanNormal(topo, tris);
    groups.push({ tris, normal: m.normal, area: m.area, sumN: m.sumN });
  }
  return { groups, groupOf };
}

/** Extent of a group's vertices along a direction. */
function widthAlong(topo: Topology, tris: number[], dir: Vec3): number {
  let lo = Infinity, hi = -Infinity;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = topo.indices[t * 3 + k]!;
      const d = topo.positions[v * 3]! * dir.x + topo.positions[v * 3 + 1]! * dir.y + topo.positions[v * 3 + 2]! * dir.z;
      if (d < lo) lo = d; if (d > hi) hi = d;
    }
  }
  return hi - lo;
}

/**
 * Mesh without face groups: planar region growing, then facets of tessellated cylinders are
 * recognised through the curvature graph and merged into curved faces.
 */
function groupByContinuity(topo: Topology): Grouping {
  const { groups, groupOf } = growPlanarGroups(topo);
  const n = groups.length;
  const adjMap = groupAdjacency(topo, groupOf, n);
  const G = n + 1;
  const isFacet = new Uint8Array(n);
  const facetParent = new Int32Array(n);
  for (let i = 0; i < n; i++) facetParent[i] = i;
  for (const [key, edges] of adjMap) {
    const gi = Math.floor(key / G), gj = key % G;
    if (allSlivers(topo, groups[gi]!.tris) || allSlivers(topo, groups[gj]!.tris)) continue;   // no trustworthy normal
    const ni = groups[gi]!.normal, nj = groups[gj]!.normal;
    const delta = angleBetween(ni, nj);
    if (delta > CURVED_MAX_DEG) continue;
    let axis = vec3.cross(ni, nj);
    if (vec3.length(axis) < 1e-3) {
      const [a, b] = edges[0]!;
      axis = vec3.sub(vertex(topo, b), vertex(topo, a));
    }
    axis = vec3.normalize(axis);
    if (vec3.length(axis) === 0) continue;
    const wi = widthAlong(topo, groups[gi]!.tris, vec3.normalize(vec3.cross(ni, axis)));
    const wj = widthAlong(topo, groups[gj]!.tris, vec3.normalize(vec3.cross(nj, axis)));
    const lo = Math.min(wi, wj), hi = Math.max(wi, wj);
    if (hi > FACET_WIDTH_RATIO * lo) {
      // tangent edge: the narrow side is a facet
      isFacet[wi < wj ? gi : gj] = 1;
    } else {
      isFacet[gi] = 1; isFacet[gj] = 1;
      facetParent[find(facetParent, gi)] = find(facetParent, gj);
    }
  }
  // curved faces = components of facets; validate each with a cylinder fit, else dissolve
  const compTris = new Map<number, number[]>();
  const compMembers = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (!isFacet[i]) continue;
    const r = find(facetParent, i);
    const list = compTris.get(r);
    if (list) { list.push(...groups[i]!.tris); compMembers.get(r)!.push(i); }
    else { compTris.set(r, groups[i]!.tris.slice()); compMembers.set(r, [i]); }
  }
  const faces: FaceSet[] = [];
  const faceOf = new Int32Array(topo.triCount).fill(-1);
  const consumed = new Uint8Array(n);
  for (const [r, tris] of compTris) {
    const fit = fitCylinder(topo, tris);
    if (!fit || !cylinderFitOk(fit) || fit.extentDeg < 1.5) continue;       // dissolve: members stay planar
    for (const m of compMembers.get(r)!) consumed[m] = 1;
    const id = faces.length;
    faces.push({ tris, kind: 'curved' });
    for (const t of tris) faceOf[t] = id;
  }
  // remaining planar groups (including dissolved facets), coplanar-merged
  const rest: RawGroup[] = [], restKinds: Array<'planar' | 'curved'> = [];
  const restOf = new Int32Array(topo.triCount).fill(-1);
  for (let i = 0; i < n; i++) {
    if (consumed[i]) continue;
    for (const t of groups[i]!.tris) restOf[t] = rest.length;
    rest.push(groups[i]!); restKinds.push('planar');
  }
  const merged = mergeCoplanar(topo, rest, restKinds, restOf);
  for (const [i, g] of merged.groups.entries()) {
    const id = faces.length;
    faces.push({ tris: g.tris, kind: merged.kinds[i]! });
    for (const t of g.tris) faceOf[t] = id;
  }
  return { faces, faceOf };
}

/** Group the triangles into faces (STEP face groups when present, else normal continuity). */
export function groupFaces(topo: Topology): Grouping {
  if (topo.faceGroups && topo.faceGroups.length > 0) return groupByFaceGroups(topo);
  return groupByContinuity(topo);
}

// ─── Planar faces ────────────────────────────────────────────────────────────

export interface PlanarFace {
  /** Index in the grouping's face list. */
  id: number;
  tris: number[];
  normal: Vec3;
  origin: Vec3;
  /** n · origin */
  offset: number;
  /** Plane basis, e1 × e2 = normal. */
  e1: Vec3;
  e2: Vec3;
  /** Boundary loops in 3D (outline CCW about the normal, holes CW). */
  outline3: Polygon3;
  holes3: Polygon3[];
  /** The same loops in plane coordinates. */
  outline2: Polygon2;
  holes2: Polygon2[];
  /** Area of the outline minus the holes (mm²). */
  area: number;
}

const COLLINEAR_TOL = 1e-3;

/** Distance of b from the segment a–c (3D). */
function segmentDistance3(b: Vec3, a: Vec3, c: Vec3): number {
  const ab = vec3.sub(b, a), ac = vec3.sub(c, a);
  const l2 = vec3.lengthSq(ac);
  if (l2 < 1e-24) return vec3.length(ab);
  const s = Math.max(0, Math.min(1, vec3.dot(ab, ac) / l2));
  return vec3.dist(b, vec3.add(a, vec3.scale(ac, s)));
}

/**
 * Remove vertices lying (within tol) on the straight line between the LAST KEPT vertex and the next
 * one (3D). Anchoring on the last kept vertex bounds the accumulated error — testing each vertex
 * against its original neighbours would erase a finely tessellated arc entirely.
 */
export function simplifyLoop3(loop: Vec3[], tol = COLLINEAR_TOL): Vec3[] {
  const cur = loop.filter((p, i, arr) => i === 0 || vec3.dist(p, arr[i - 1]!) > 1e-12);
  while (cur.length > 1 && vec3.dist(cur[0]!, cur[cur.length - 1]!) <= 1e-12) cur.pop();
  if (cur.length <= 3) return cur;
  // start from a vertex that is certainly kept: the one farthest from the centroid
  let cx = 0, cy = 0, cz = 0;
  for (const p of cur) { cx += p.x; cy += p.y; cz += p.z; }
  const c: Vec3 = { x: cx / cur.length, y: cy / cur.length, z: cz / cur.length };
  let start = 0, far = -1;
  cur.forEach((p, i) => { const d = vec3.dist(p, c); if (d > far) { far = d; start = i; } });
  const n = cur.length;
  const out: Vec3[] = [cur[start]!];
  let run: Vec3[] = [];                                   // vertices dropped since the last kept one
  for (let k = 1; k < n; k++) {
    const b = cur[(start + k) % n]!, next = cur[(start + k + 1) % n]!;
    const a = out[out.length - 1]!;
    // b (and every vertex dropped before it) within tol of the chord a → next, no backtracking
    const straight = vec3.dot(vec3.sub(b, a), vec3.sub(next, b)) >= 0
      && segmentDistance3(b, a, next) <= tol && run.every(p => segmentDistance3(p, a, next) <= tol);
    if (straight) run.push(b); else { out.push(b); run = []; }
  }
  return out;
}

/** Boundary loops of a face (vertex index loops) following the triangle winding. */
export function boundaryLoops(topo: Topology, tris: number[], faceOf: Int32Array, id: number): number[][] {
  const outgoing = new Map<number, number[]>();     // start vertex → end vertices
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const u = topo.adj[t * 3 + k]!;
      if (u >= 0 && faceOf[u] === id) continue;
      const a = topo.indices[t * 3 + k]!, b = topo.indices[t * 3 + ((k + 1) % 3)]!;
      const list = outgoing.get(a);
      if (list) list.push(b); else outgoing.set(a, [b]);
    }
  }
  const loops: number[][] = [];
  for (const [start, ends] of outgoing) {
    while (ends.length) {
      const loop = [start];
      let cur = ends.pop()!;
      let guard = 0;
      while (cur !== start && guard++ < 1e6) {
        loop.push(cur);
        const next = outgoing.get(cur);
        if (!next || next.length === 0) break;
        cur = next.pop()!;
      }
      if (cur === start && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Fit the plane of a face and extract its outline and holes. */
export function buildPlanarFace(topo: Topology, id: number, tris: number[], faceOf: Int32Array): PlanarFace {
  const m = meanNormal(topo, tris);
  const normal = m.normal;
  const origin = faceCentroid(topo, tris);
  const { e1, e2 } = planeBasis(normal);
  const to2 = (p: Vec3) => { const d = vec3.sub(p, origin); return { x: vec3.dot(d, e1), y: vec3.dot(d, e2) }; };
  const loops = boundaryLoops(topo, tris, faceOf, id)
    .map(l => simplifyLoop3(l.map(v => vertex(topo, v))))
    .filter(l => l.length >= 3);
  const with2 = loops.map(l3 => ({ l3, l2: l3.map(to2) })).map(x => ({ ...x, a: signedArea(x.l2) }));
  with2.sort((p, q) => Math.abs(q.a) - Math.abs(p.a));
  let outline3: Polygon3 = [], outline2: Polygon2 = [];
  const holes3: Polygon3[] = [], holes2: Polygon2[] = [];
  let area = 0;
  for (const [i, x] of with2.entries()) {
    if (Math.abs(x.a) < 1e-9) continue;
    if (i === 0) {
      const rev = x.a < 0;
      outline3 = rev ? x.l3.slice().reverse() : x.l3;
      outline2 = rev ? x.l2.slice().reverse() : x.l2;
      area += Math.abs(x.a);
    } else {
      const rev = x.a > 0;
      holes3.push(rev ? x.l3.slice().reverse() : x.l3);
      holes2.push(rev ? x.l2.slice().reverse() : x.l2);
      area -= Math.abs(x.a);
    }
  }
  return { id, tris, normal, origin, offset: vec3.dot(normal, origin), e1, e2, outline3, holes3, outline2, holes2, area };
}
