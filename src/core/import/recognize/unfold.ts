/**
 * Reference side, flange tree and unfolding into a flat pattern.
 * See docs/specs/recognize-3d.md §1.7–1.8.
 */
import type { BendDirection, BendLine, BendSource, Mat4, Message, Polygon2, Vec2, Vec3 } from '../../types';
import { vec2, vec3, mat4, ensureCCW, ensureCW, signedArea, bounds, centroid, unionAdjacentPolygons, penetrationDepth, pointSegmentDistance, dedupe, area } from '../../geom';
import { bendAllowance } from '../../bend';
import type { Topology } from './topology';
import { angleBetween, vertex } from './topology';
import type { Grouping, PlanarFace } from './faces';
import type { BendCandidate } from './bends';
import { faceNeighbours } from './bends';
import { issue, round3, roundAngle } from './messages';

export type Side = 'ref' | 'other';

/** Propagate the reference side from the root face over every bend. */
export function propagateSides(rootId: number, bends: BendCandidate[], planarById: Map<number, PlanarFace>): Map<number, Side> {
  const side = new Map<number, Side>();
  side.set(rootId, 'ref');
  const bendsOf = new Map<number, BendCandidate[]>();
  const add = (f: number, b: BendCandidate) => { const l = bendsOf.get(f); if (l) l.push(b); else bendsOf.set(f, [b]); };
  for (const b of bends) { for (const f of b.innerFlanges) add(f, b); for (const f of b.outerFlanges) add(f, b); }
  const queue = [rootId];
  const flip = (s: Side): Side => (s === 'ref' ? 'other' : 'ref');
  while (queue.length) {
    const f = queue.shift()!;
    const s = side.get(f)!;
    for (const b of bendsOf.get(f) ?? []) {
      const onInner = b.innerFlanges.includes(f);
      const same = onInner ? b.innerFlanges : b.outerFlanges;
      const opposite = onInner ? b.outerFlanges : b.innerFlanges;
      for (const g of same) if (!side.has(g)) { side.set(g, s); queue.push(g); }
      for (const g of opposite) if (!side.has(g)) { side.set(g, flip(s)); queue.push(g); }
    }
  }
  for (const id of [...side.keys()]) if (!planarById.has(id)) side.delete(id);
  return side;
}

export interface TreeBend {
  bend: BendCandidate;
  parent: number;
  child: number;
  direction: BendDirection;
}

/** BFS tree over the reference-side flanges; bends closing a cycle are reported and skipped. */
export function buildTree(rootId: number, bends: BendCandidate[], side: Map<number, Side>, issues: Message[]): { order: TreeBend[]; faces: number[] } {
  const refFaces = new Set<number>([rootId]);
  const order: TreeBend[] = [];
  const byFace = new Map<number, BendCandidate[]>();
  const add = (f: number, b: BendCandidate) => { const l = byFace.get(f); if (l) l.push(b); else byFace.set(f, [b]); };
  const refPair = (b: BendCandidate): [number, number] | null => {
    const inner = b.innerFlanges.every(f => side.get(f) === 'ref');
    const outer = b.outerFlanges.every(f => side.get(f) === 'ref');
    if (inner) return b.innerFlanges;
    if (outer) return b.outerFlanges;
    return null;
  };
  for (const b of bends) { const p = refPair(b); if (p) { add(p[0], b); add(p[1], b); } }
  const visitedBends = new Set<BendCandidate>();
  const queue = [rootId];
  const faces = [rootId];
  while (queue.length) {
    const f = queue.shift()!;
    for (const b of byFace.get(f) ?? []) {
      if (visitedBends.has(b)) continue;
      visitedBends.add(b);
      const p = refPair(b)!;
      const other = p[0] === f ? p[1] : p[0];
      if (refFaces.has(other)) { issues.push(issue('bendCycle', { bendId: `B${order.length + 1}` })); continue; }
      refFaces.add(other);
      faces.push(other);
      queue.push(other);
      const onInner = b.innerFlanges.includes(f);
      order.push({ bend: b, parent: f, child: other, direction: onInner ? 'up' : 'down' });
    }
  }
  return { order, faces };
}

export interface UnfoldResult {
  outline: Polygon2;
  holes: Polygon2[];
  bends: BendLine[];
  /** For each bend of `bends`, the index of the tree bend it came from. */
  treeIndexOf: number[];
  /** Transform mesh → root plane (3D, mesh frame) per face id. */
  unfoldOf: Map<number, Mat4>;
  /** Flat frame: (u, v) = ((U p − origin)·e1, (U p − origin)·e2) + shift. */
  e1: Vec3; e2: Vec3; normal: Vec3; origin: Vec3;
  shift: Vec2;
  /** Flange pieces (2D, final frame) per face id. */
  pieces: Map<number, Polygon2>;
  confidencePenalty: number;
}

/** Chaining tolerance of the outline union: seams are vertex-exact after snapping, so 1e-4 suffices and
 *  keeps finely tessellated outline arcs (the union's collinear clean-up at 0.01 would erase arcs whose
 *  two-chord sagitta is below 0.01 mm, corner and all). CHAIN_TOL is the fallback for noisy meshes. */
const SEAM_TOL = 1e-4;
const CHAIN_TOL = 0.01;
/** Bends at least this steep are hems (angle 180 in the BendLine); the gap between the flanges is 2·ri. */
const HEM_MIN_DEG = 179.5;

/**
 * Remove vertices within `tol` of the segment from the LAST KEPT vertex to the next one. Anchoring on
 * the kept vertex bounds the accumulated deviation, so a finely tessellated arc is thinned to chords
 * within `tol` instead of being erased (geom's simplifyCollinear tests against the original
 * neighbours and drops every vertex of such an arc in one pass).
 */
export function simplifyCollinearSafe(poly: Polygon2, tol: number): Polygon2 {
  const cur = dedupe(poly, tol);
  if (cur.length <= 3) return cur;
  const c = centroid(cur);
  let start = 0, far = -1;
  cur.forEach((p, i) => { const d = vec2.dist(p, c); if (d > far) { far = d; start = i; } });
  const n = cur.length;
  const out: Polygon2 = [cur[start]!];
  let run: Polygon2 = [];                                 // vertices dropped since the last kept one
  for (let k = 1; k < n; k++) {
    const b = cur[(start + k) % n]!, next = cur[(start + k + 1) % n]!;
    const a = out[out.length - 1]!;
    const straight = vec2.dot(vec2.sub(b, a), vec2.sub(next, b)) >= 0
      && pointSegmentDistance(b, a, next) <= tol && run.every(p => pointSegmentDistance(p, a, next) <= tol);
    if (straight) run.push(b); else { out.push(b); run = []; }
  }
  return out;
}
/** Mesh vertices within this distance of a structure line are considered to lie on it and are projected
 *  onto it (mesh noise ≈ 1e-5; STL files quantised to 0.01 mm carry ±0.005). No two distinct structure
 *  lines of a sheet-metal part are this close. */
const STRUCT_TOL = 0.01;
/** Collinear thinning tolerance of the final outline / holes. */
const THIN_TOL = 1e-3;
/** Bend directions within this angle of parallel / perpendicular are aligned exactly. */
const ALIGN_DEG = 0.02;

/** Direction in P's plane, ⟂ axis, pointing from P's material toward the cylinder (from a P triangle at a shared edge). */
function towardZone(topo: Topology, grouping: Grouping, P: PlanarFace, cylId: number, axis: Vec3, tangentPoint: Vec3): Vec3 {
  const edges = faceNeighbours(topo, grouping, P.id).get(cylId);
  let d: Vec3 | null = null;
  if (edges && edges.length) {
    const [va, vb] = edges[0]!;
    for (const t of P.tris) {
      for (let k = 0; k < 3; k++) {
        if (topo.indices[t * 3 + k] === va && topo.indices[t * 3 + ((k + 1) % 3)] === vb) {
          const third = vertex(topo, topo.indices[t * 3 + ((k + 2) % 3)]!);
          d = vec3.sub(vec3.midpoint(vertex(topo, va), vertex(topo, vb)), third);
          break;
        }
      }
      if (d) break;
    }
  }
  if (!d) d = vec3.sub(tangentPoint, P.origin);
  d = vec3.sub(d, vec3.scale(axis, vec3.dot(d, axis)));
  d = vec3.sub(d, vec3.scale(P.normal, vec3.dot(d, P.normal)));
  return vec3.normalize(d);
}

/** Direction of the longest outline edge (undirected; the sign is fixed later by the canonical frame). */
function longestEdgeDir(poly: Vec3[]): Vec3 | null {
  let best: Vec3 | null = null, bestLen = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = vec3.sub(poly[(i + 1) % n]!, poly[i]!);
    const l = vec3.length(d);
    if (l > bestLen) { bestLen = l; best = d; }
  }
  return best ? vec3.normalize(best) : null;
}

// ─── Structure lines and regularisation ──────────────────────────────────────

interface Line2 { q: Vec2; u: Vec2 }

/** A bend line with its zone half width (BA/2): the four structure lines are the two slab lines and the two zone boundaries. */
interface ZoneLine { p0: Vec2; p1: Vec2; half: number }

function structureLines(z: ZoneLine): Line2[] {
  const e = vec2.normalize(vec2.sub(z.p1, z.p0));
  if (e.x === 0 && e.y === 0) return [];
  const n = vec2.perp(e);
  return [{ q: z.p0, u: n }, { q: z.p1, u: n }, { q: vec2.add(z.p0, vec2.scale(n, z.half)), u: e }, { q: vec2.sub(z.p0, vec2.scale(n, z.half)), u: e }];
}

function lineDistance(p: Vec2, l: Line2): number { return Math.abs(vec2.cross(l.u, vec2.sub(p, l.q))); }

function lineIntersection(a: Line2, b: Line2): Vec2 | null {
  const den = vec2.cross(a.u, b.u);
  if (Math.abs(den) < 1e-3) return null;
  const t = vec2.cross(vec2.sub(b.q, a.q), b.u) / den;
  return vec2.add(a.q, vec2.scale(a.u, t));
}

/** Project a point onto the nearby structure lines (their intersection when two cross there). */
function snapPoint(p: Vec2, lines: Line2[], tol = STRUCT_TOL): Vec2 {
  const near = lines.filter(l => lineDistance(p, l) <= tol).sort((a, b) => lineDistance(p, a) - lineDistance(p, b));
  if (near.length === 0) return p;
  const a = near[0]!;
  for (let i = 1; i < near.length; i++) {
    const x = lineIntersection(a, near[i]!);
    // the corner the point belongs to — never a far-away intersection of two nearly parallel lines
    if (x && vec2.dist(x, p) <= 3 * tol) return x;
  }
  const t = vec2.dot(vec2.sub(p, a.q), a.u);
  return vec2.add(a.q, vec2.scale(a.u, t));
}

/**
 * Align bend directions that are parallel / perpendicular within ALIGN_DEG exactly (rotating each
 * line about its midpoint), then move bend ends ALONG their line onto other bends' structure lines
 * that pass within STRUCT_TOL — so nearly coincident split lines of buildPartModel coincide exactly.
 */
function regularizeZones(zones: ZoneLine[]): ZoneLine[] {
  const out = zones.map(z => ({ ...z }));
  // direction clusters modulo 90°
  const angles = out.map(z => { const d = vec2.sub(z.p1, z.p0); return ((Math.atan2(d.y, d.x) * 180) / Math.PI + 360) % 90; });
  const assigned = new Array<number>(out.length).fill(-1);
  const clusters: number[][] = [];
  for (let i = 0; i < out.length; i++) {
    if (assigned[i]! >= 0) continue;
    const members = [i];
    assigned[i] = clusters.length;
    for (let j = i + 1; j < out.length; j++) {
      if (assigned[j]! >= 0) continue;
      let d = Math.abs(angles[j]! - angles[i]!);
      d = Math.min(d, 90 - d);
      if (d <= ALIGN_DEG) { members.push(j); assigned[j] = clusters.length; }
    }
    clusters.push(members);
  }
  for (const members of clusters) {
    if (members.length < 2) continue;
    // mean angle modulo 90 (weighted by length), unwrapped around the first member
    const a0 = angles[members[0]!]!;
    let sum = 0, w = 0;
    for (const m of members) {
      let a = angles[m]!;
      if (a - a0 > 45) a -= 90; else if (a0 - a > 45) a += 90;
      const len = vec2.dist(out[m]!.p0, out[m]!.p1);
      sum += a * len; w += len;
    }
    const mean = sum / w;
    for (const m of members) {
      const z = out[m]!;
      const d = vec2.sub(z.p1, z.p0);
      const len = vec2.length(d);
      const cur = (Math.atan2(d.y, d.x) * 180) / Math.PI;
      let target = mean;
      while (target - cur > 45) target -= 90;
      while (cur - target > 45) target += 90;
      const mid = vec2.midpoint(z.p0, z.p1);
      const u = { x: Math.cos((target * Math.PI) / 180), y: Math.sin((target * Math.PI) / 180) };
      z.p0 = vec2.sub(mid, vec2.scale(u, len / 2));
      z.p1 = vec2.add(mid, vec2.scale(u, len / 2));
    }
  }
  // ends onto other bends' structure lines (moving along the bend line only)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < out.length; i++) {
      const z = out[i]!;
      const e = vec2.normalize(vec2.sub(z.p1, z.p0));
      if (e.x === 0 && e.y === 0) continue;
      // accurate zone boundaries first, noisy slab lines (through mesh-vertex ends) last
      const others: Line2[] = [];
      for (let j = 0; j < out.length; j++) if (j !== i) others.push(...structureLines(out[j]!).slice(2));
      for (let j = 0; j < out.length; j++) if (j !== i) others.push(...structureLines(out[j]!).slice(0, 2));
      const along: Line2 = { q: z.p0, u: e };
      for (const end of ['p0', 'p1'] as const) {
        const p = z[end];
        for (const l of others) {
          if (lineDistance(p, l) > STRUCT_TOL) continue;
          const x = lineIntersection(along, l);
          if (x && vec2.dist(x, p) <= STRUCT_TOL) { z[end] = x; break; }
        }
      }
    }
  }
  return out;
}

/**
 * Rotation (deg, multiple of 90) making the flat canonical: landscape bounding box, then the 180°
 * ambiguity resolved so that the flat's material (then its 'up' bends, then all bends) lies toward
 * +y / +x of the root piece. Fully symmetric flats are unaffected by it.
 */
function canonicalRotation(outline: Polygon2, rootPiece: Polygon2, bends: BendLine[]): number {
  if (outline.length < 3) return 0;
  let rot = 0;
  const b = bounds(outline);
  const w = b.max.x - b.min.x, h = b.max.y - b.min.y;
  if (h - w > 1e-3) rot = 90;
  const R = (p: Vec2): Vec2 => vec2.rotate(p, rot);
  const c = centroid(outline.map(R));
  const r = rootPiece.length >= 3 ? centroid(rootPiece.map(R)) : c;
  const mids = (list: BendLine[]): Vec2 | null => {
    if (list.length === 0) return null;
    let x = 0, y = 0;
    for (const bl of list) { const m = R(vec2.midpoint(bl.p0, bl.p1)); x += m.x; y += m.y; }
    return vec2.sub({ x: x / list.length, y: y / list.length }, r);
  };
  for (const v of [vec2.sub(c, r), mids(bends.filter(x => x.direction === 'up')), mids(bends)]) {
    if (!v || vec2.length(v) < 0.01) continue;
    if (Math.abs(v.y) > 0.01) return v.y < 0 ? rot + 180 : rot;
    if (Math.abs(v.x) > 0.01) return v.x < 0 ? rot + 180 : rot;
  }
  return rot;
}

/**
 * Unfold the tree into 2D: root outline + zone rectangles + child outlines, chained into one
 * outline; holes carried along. The result is in a canonical frame with bounds starting at (0, 0).
 */
export function unfold(
  topo: Topology, grouping: Grouping, planarById: Map<number, PlanarFace>, rootId: number, tree: TreeBend[],
  thickness: number, kFactor: number, source: BendSource, issues: Message[],
): UnfoldResult {
  const root = planarById.get(rootId)!;
  const normal = root.normal;
  let e1 = longestEdgeDir(root.outline3) ?? root.e1;
  e1 = vec3.normalize(vec3.sub(e1, vec3.scale(normal, vec3.dot(e1, normal))));
  let e2 = vec3.cross(normal, e1);
  const origin = root.origin;
  const unfoldOf = new Map<number, Mat4>();
  unfoldOf.set(rootId, mat4.identity());
  const proj = (m: Mat4, p: Vec3): Vec2 => {
    const q = vec3.sub(mat4.applyToPoint(m, p), origin);
    return { x: vec3.dot(q, e1), y: vec3.dot(q, e2) };
  };
  const projDir = (m: Mat4, d: Vec3): Vec2 => {
    const q = mat4.applyToDir(m, d);
    return vec2.normalize({ x: vec3.dot(q, e1), y: vec3.dot(q, e2) });
  };

  const facePieces = new Map<number, Polygon2>();
  const holes: Polygon2[] = [];
  interface ZoneInfo { direction: BendDirection; angle: number; ri: number; treeIndex: number }
  const zoneInfo: ZoneInfo[] = [];
  let zones: ZoneLine[] = [];
  let penalty = 0;

  facePieces.set(rootId, ensureCCW(root.outline3.map(p => proj(unfoldOf.get(rootId)!, p))));
  for (const h of root.holes3) holes.push(ensureCW(h.map(p => proj(unfoldOf.get(rootId)!, p))));

  for (const [i, tb] of tree.entries()) {
    const P = planarById.get(tb.parent)!, C = planarById.get(tb.child)!;
    const UP = unfoldOf.get(tb.parent)!;
    const cyl = tb.direction === 'up' ? tb.bend.inner : tb.bend.outer;
    const s = cyl.fit.inner ? -1 : 1;
    const a = cyl.fit.axisDir, c = cyl.fit.centre, r = cyl.fit.radius;
    const theta = tb.bend.angle, ri = tb.bend.innerRadius;
    // BA from the rounded values that are emitted in the BendLine, so buildPartModel's zone lines coincide exactly
    const ba = bendAllowance(roundAngle(theta), round3(ri), kFactor, thickness);
    // tangent line on P (mesh frame)
    const tangentAt = (sv: number): Vec3 => {
      const q = vec3.add(vec3.add(c, vec3.scale(a, sv)), vec3.scale(P.normal, s * r));
      return vec3.add(q, vec3.scale(P.normal, vec3.dot(vec3.sub(P.origin, q), P.normal)));
    };
    const q0 = tangentAt(cyl.fit.sMin), q1 = tangentAt(cyl.fit.sMax);
    const dHat = towardZone(topo, grouping, P, cyl.id, a, vec3.midpoint(q0, q1));
    // rotation that brings C's plane onto P's plane
    let R = mat4.rotationAxisAngle(c, a, theta);
    if (angleBetween(mat4.applyToDir(R, C.normal), P.normal) > angleBetween(mat4.applyToDir(mat4.rotationAxisAngle(c, a, -theta), C.normal), P.normal)) {
      R = mat4.rotationAxisAngle(c, a, -theta);
    }
    const UC = mat4.multiply(UP, mat4.multiply(mat4.translation(vec3.scale(dHat, ba)), R));
    unfoldOf.set(tb.child, UC);
    // bend line (2D) = mid-line of the zone rectangle
    const Q0 = proj(UP, q0), Q1 = proj(UP, q1);
    const half = vec2.scale(projDir(UP, dHat), ba / 2);
    zones.push({ p0: vec2.add(Q0, half), p1: vec2.add(Q1, half), half: ba / 2 });
    zoneInfo.push({ direction: tb.direction, angle: theta, ri, treeIndex: i });
    facePieces.set(tb.child, ensureCCW(C.outline3.map(p => proj(UC, p))));
    for (const h of C.holes3) holes.push(ensureCW(h.map(p => proj(UC, p))));
  }

  // overlap check between flange pieces
  const faceIds = [...facePieces.keys()];
  let overlapReported = false;
  for (let i = 0; i < faceIds.length && !overlapReported; i++) {
    for (let j = i + 1; j < faceIds.length; j++) {
      const pa = facePieces.get(faceIds[i]!)!, pb = facePieces.get(faceIds[j]!)!;
      if (pa.length < 3 || pb.length < 3) continue;
      if (penetrationDepth(pa, pb) > 0.05) {
        issues.push(issue('flangeOverlap', { faceA: `F${i + 1}`, faceB: `F${j + 1}` }));
        penalty += 0.3; overlapReported = true; break;
      }
    }
  }

  // the fitted structure (bend lines, zone boundaries) is accurate; mesh vertices are noisy and
  // are snapped onto it so that seams and the later line splits are vertex-exact
  zones = regularizeZones(zones);
  const lines = zones.flatMap(structureLines);
  for (const id of faceIds) facePieces.set(id, facePieces.get(id)!.map(p => snapPoint(p, lines)));
  const rects: Polygon2[] = zones.map(z => {
    const e = vec2.normalize(vec2.sub(z.p1, z.p0));
    const n = vec2.scale(vec2.perp(e), z.half);
    return ensureCCW([vec2.sub(z.p0, n), vec2.sub(z.p1, n), vec2.add(z.p1, n), vec2.add(z.p0, n)]);
  });
  let bends: BendLine[] = zones.map((z, k) => {
    const info = zoneInfo[k]!;
    const bl: BendLine = {
      id: `B${k + 1}`, p0: z.p0, p1: z.p1, direction: info.direction,
      angle: roundAngle(info.angle), innerRadius: round3(info.ri), kFactor,
      sources: { geometry: source, angle: source, radius: source, direction: source },
    };
    if (bl.angle >= HEM_MIN_DEG) {
      // a hem: the finished gap between the flanges is the inner diameter of the 180° arc
      const gap = round3(2 * bl.innerRadius);
      bl.hem = gap >= 0.25 * thickness ? 'open' : 'closed';
      bl.hemGap = bl.hem === 'open' ? gap : 0;
    }
    return bl;
  });
  let treeIndexOf = zoneInfo.map(z => z.treeIndex);

  // assemble the outline
  const pieces = [...faceIds.map(id => facePieces.get(id)!), ...rects].filter(p => p.length >= 3 && area(p) > 1e-6);
  let outline: Polygon2 = [];
  let extraHoles: Polygon2[] = [];
  let merged = pieces.length ? unionAdjacentPolygons(pieces, SEAM_TOL) : null;
  if (pieces.length && (!merged || merged.length !== 1)) {
    const loose = unionAdjacentPolygons(pieces, CHAIN_TOL);
    if (loose && (loose.length === 1 || !merged)) merged = loose;
  }
  if (merged && merged.length === 1) {
    outline = merged[0]!.polygon;
    extraHoles = merged[0]!.holes;
  } else {
    issues.push(issue('outlineFailed'));
    penalty += 0.4;
    if (merged && merged.length > 1) {
      const largest = merged.slice().sort((p, q) => area(q.polygon) - area(p.polygon))[0]!;
      outline = largest.polygon; extraHoles = largest.holes;
    } else {
      outline = facePieces.get(rootId) ?? [];
    }
  }
  // the pieces do not overlap, so the union must have (almost) their summed area: a smaller region means
  // the union's collinear clean-up erased outline vertices (fine arcs on a noisy mesh) — report it
  if (merged && merged.length === 1 && pieces.length) {
    const expected = pieces.reduce((sum, p) => sum + area(p), 0);
    const got = area(merged[0]!.polygon) - merged[0]!.holes.reduce((sum, h) => sum + area(h), 0);
    if (Math.abs(got - expected) > 1e-3 * expected + 1e-6 && !issues.some(m => m.key === 'warnings.recognize.outlineFailed')) {
      issues.push(issue('outlineFailed'));
      penalty += 0.4;
    }
  }
  outline = simplifyCollinearSafe(ensureCCW(outline), THIN_TOL);
  let allHoles = [...holes, ...extraHoles].map(h => ensureCW(simplifyCollinearSafe(h, THIN_TOL))).filter(h => h.length >= 3 && Math.abs(signedArea(h)) > 1e-6);

  // canonical 2D frame (rotations by multiples of 90° keep the vertex-exact structure)
  const rot = canonicalRotation(outline, facePieces.get(rootId) ?? [], bends);
  if (rot !== 0) {
    const rotP = (p: Vec2): Vec2 => vec2.rotate(p, rot);
    outline = outline.map(rotP);
    allHoles = allHoles.map(h => h.map(rotP));
    bends = bends.map(bl => ({ ...bl, p0: rotP(bl.p0), p1: rotP(bl.p1) }));
    for (const id of faceIds) facePieces.set(id, facePieces.get(id)!.map(rotP));
    const cr = Math.cos((rot * Math.PI) / 180), sr = Math.sin((rot * Math.PI) / 180);
    const ne1 = vec3.add(vec3.scale(e1, cr), vec3.scale(e2, -sr));
    const ne2 = vec3.add(vec3.scale(e1, sr), vec3.scale(e2, cr));
    e1 = ne1; e2 = ne2;
  }

  // shift so the bounds start at (0, 0)
  const b = bounds(outline.length ? outline : [{ x: 0, y: 0 }]);
  const shift = { x: -b.min.x, y: -b.min.y };
  const sh = (p: Vec2): Vec2 => vec2.add(p, shift);
  const shiftedPieces = new Map<number, Polygon2>();
  for (const [id, poly] of facePieces) shiftedPieces.set(id, poly.map(sh));
  bends = bends.map(bl => ({ ...bl, p0: sh(bl.p0), p1: sh(bl.p1) }));

  // deterministic bend order (by midpoint) and orientation (p0 → p1 along +x, else +y)
  const keyed = bends.map((bl, k) => {
    const mid = vec2.midpoint(bl.p0, bl.p1);
    return { bl, k, kx: Math.round(mid.x * 100), ky: Math.round(mid.y * 100) };
  });
  keyed.sort((p, q) => (p.kx - q.kx) || (p.ky - q.ky));
  treeIndexOf = keyed.map(x => treeIndexOf[x.k]!);
  bends = keyed.map((x, k) => {
    const d = vec2.sub(x.bl.p1, x.bl.p0);
    const flip = d.x < -1e-3 || (Math.abs(d.x) <= 1e-3 && d.y < 0);
    return { ...x.bl, id: `B${k + 1}`, p0: flip ? x.bl.p1 : x.bl.p0, p1: flip ? x.bl.p0 : x.bl.p1 };
  });

  return {
    outline: outline.map(sh), holes: allHoles.map(h => h.map(sh)), bends, treeIndexOf,
    unfoldOf, e1, e2, normal, origin, shift, pieces: shiftedPieces, confidencePenalty: penalty,
  };
}
