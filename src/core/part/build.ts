/**
 * buildPartModel — split the flat outline by the bend zones into flanges and build the tree.
 * See docs/specs/core-geometry.md §3.2.
 */
import type { Flange, FlangeLink, FlatPattern, Message, PartModel, Polygon2, Region2, Vec2 } from '../types';
import {
  area, bounds, centroid, classifyPoint, dedupe, distanceToBoundary, ensureCCW, ensureCW, pointInPolygon,
  segmentIntersect, splitPolygonByLine, unionAdjacentPolygons, vec2,
} from '../geom';
import { bendAllowance } from '../bend';
import { bendFrame, coordD, coordS, insideStrip, polygonBendSides, LINE_TOL, CHAIN_TOL, END_TOL } from './frame';
import type { BendFrame } from './frame';

export interface BuildOptions {
  /** Minimum shared boundary length to join fragments into one flange (mm). Default 0.01. */
  tol?: number;
  /** Material within this distance beyond a bend line's ends (inside the zone band) is treated as
   *  zone material, so a bend line that stops slightly short of the outline behaves as if it reached
   *  it (mm). Default 0.1. */
  endTol?: number;
}

interface Fragment {
  poly: Polygon2;
  /** bendId → sides (+1/−1) this fragment is adjacent to. */
  adjacency: Map<string, Set<1 | -1>>;
}

/** Split every piece by the four lines of a bend zone; keep fragments outside the strip. */
function splitByZone(pieces: Polygon2[], f: BendFrame, endTol: number): Polygon2[] {
  const half = f.ba / 2;
  const lines: Array<{ point: Vec2; dir: Vec2 }> = [
    { point: f.p0, dir: f.n },                                        // s = 0
    { point: vec2.add(f.p0, vec2.scale(f.e, f.length)), dir: f.n },   // s = length
    { point: vec2.add(f.p0, vec2.scale(f.n, half)), dir: f.e },       // d = +BA/2
    { point: vec2.sub(f.p0, vec2.scale(f.n, half)), dir: f.e },       // d = −BA/2
  ];
  let cur = pieces;
  for (const l of lines) {
    cur = cur.flatMap(p => {
      const { left, right } = splitPolygonByLine(p, l.point, l.dir);
      return [...left, ...right];
    });
  }
  return cur.filter(p => area(p) > 1e-6 && !insideStrip(centroid(p), f, endTol));
}

/**
 * Shared boundary length between two fragments, ignoring overlaps that lie on a strip long side
 * inside its slab range (never join across a strip — only matters for degenerate zero-width zones).
 */
function sharedLengthExcludingStrips(a: Polygon2, b: Polygon2, frames: BendFrame[], lineTol: number): number {
  let total = 0;
  const n = a.length, m = b.length;
  for (let i = 0; i < n; i++) {
    const a0 = a[i]!, a1 = a[(i + 1) % n]!;
    const ra = vec2.sub(a1, a0), la = vec2.length(ra);
    if (la <= lineTol) continue;
    const ua = vec2.scale(ra, 1 / la);
    for (let j = 0; j < m; j++) {
      const b0 = b[j]!, b1 = b[(j + 1) % m]!;
      const lb = vec2.dist(b0, b1);
      if (lb <= lineTol) continue;
      if (Math.abs(vec2.cross(ua, vec2.sub(b0, a0))) > lineTol || Math.abs(vec2.cross(ua, vec2.sub(b1, a0))) > lineTol) continue;
      const ub = vec2.scale(vec2.sub(b1, b0), 1 / lb);
      if (Math.abs(vec2.cross(ub, vec2.sub(a0, b0))) > lineTol || Math.abs(vec2.cross(ub, vec2.sub(a1, b0))) > lineTol) continue;
      const t0 = vec2.dot(vec2.sub(b0, a0), ua), t1 = vec2.dot(vec2.sub(b1, a0), ua);
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(la, Math.max(t0, t1));
      if (hi <= lo) continue;
      const mid = vec2.add(a0, vec2.scale(ua, (lo + hi) / 2));
      let onStrip = false;
      for (const f of frames) {
        const s = coordS(f, mid), d = coordD(f, mid);
        if (s >= -lineTol && s <= f.length + lineTol && Math.abs(Math.abs(d) - f.ba / 2) <= lineTol) { onStrip = true; break; }
      }
      if (!onStrip) total += hi - lo;
    }
  }
  return total;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number {
    while (this.parent[i] !== i) { this.parent[i] = this.parent[this.parent[i]!]!; i = this.parent[i]!; }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/** True when an edge of `a` properly crosses an edge of `b` (strictly, not just touching within tol). */
function boundariesCross(a: Polygon2, b: Polygon2): boolean {
  for (let i = 0, n = a.length; i < n; i++) {
    const a0 = a[i]!, a1 = a[(i + 1) % n]!;
    for (let j = 0, m = b.length; j < m; j++) {
      const hit = segmentIntersect(a0, a1, b[j]!, b[(j + 1) % m]!, 0);
      if (hit && hit.ta > 1e-9 && hit.ta < 1 - 1e-9 && hit.tb > 1e-9 && hit.tb < 1 - 1e-9) return true;
    }
  }
  return false;
}

/** Distance from a point strictly inside the material (outline minus holes) to the nearest boundary, or −1. */
function depthInMaterial(p: Vec2, outline: Polygon2, holes: Polygon2[], tol: number): number {
  if (classifyPoint(p, outline, tol) !== 'inside') return -1;
  let gap = distanceToBoundary(p, outline);
  for (const h of holes) {
    if (classifyPoint(p, h, tol) === 'inside') return -1;
    gap = Math.min(gap, distanceToBoundary(p, h));
  }
  return gap;
}

export function buildPartModel(flat: FlatPattern, opts: BuildOptions = {}): PartModel {
  const tol = opts.tol ?? CHAIN_TOL;
  const endTol = opts.endTol ?? END_TOL;
  const warnings: Message[] = [];
  const t = flat.thickness;

  const ba: Record<string, number> = {};
  for (const b of flat.bends) {
    const v = bendAllowance(b.angle, b.innerRadius, b.kFactor, t);
    ba[b.id] = Number.isFinite(v) ? Math.max(0, v) : NaN;
  }
  // bends with non-finite geometry or allowance are skipped: they get no zone and are reported as
  // having no material on either side (the UI validates the inputs)
  const frames = flat.bends
    .filter(b => Number.isFinite(b.p0.x + b.p0.y + b.p1.x + b.p1.y) && Number.isFinite(ba[b.id]!))
    .map(b => bendFrame(b, ba[b.id]!));

  const outline = dedupe(ensureCCW(flat.outline));
  const flatBounds = outline.length ? bounds(outline) : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  if (outline.length < 3 || area(outline) <= 0) {
    warnings.push({ key: 'warnings.part.noOutline', severity: 'error' });
    return { flat, flanges: [], rootFlangeId: '', links: [], bendAllowance: ba, flatBounds, warnings };
  }
  const holes = flat.holes.map(h => dedupe(ensureCW(h)));

  // bend line ends that stop inside the material (need a relief or a longer line)
  const endInMaterial = new Set<string>();
  for (const f of frames) {
    const b = f.bend;
    ([b.p0, b.p1] as const).forEach((p, end) => {
      const gap = depthInMaterial(p, outline, holes, endTol);
      if (gap > endTol) {
        endInMaterial.add(b.id);
        warnings.push({ key: 'warnings.part.bendEndInMaterial', params: { bendId: b.id, end, gap: Math.round(gap * 1000) / 1000 }, severity: 'warning' });
      }
    });
  }

  // 1. split by every zone
  let pieces: Polygon2[] = [outline];
  for (const f of frames) pieces = splitByZone(pieces, f, endTol);

  // 2. fragments + adjacency (a fragment may touch a bend on either side, regardless of its centroid)
  const fragments: Fragment[] = pieces.map(poly => ({ poly, adjacency: new Map() }));
  for (const frag of fragments) {
    for (const f of frames) {
      const sides = polygonBendSides(frag.poly, f, tol);
      if (sides.length) frag.adjacency.set(f.bend.id, new Set(sides));
    }
  }

  // 3. union-find along artificial split lines
  const uf = new UnionFind(fragments.length);
  for (let i = 0; i < fragments.length; i++) {
    for (let j = i + 1; j < fragments.length; j++) {
      if (sharedLengthExcludingStrips(fragments[i]!.poly, fragments[j]!.poly, frames, LINE_TOL) > tol) uf.union(i, j);
    }
  }
  const groups = new Map<number, Fragment[]>();
  fragments.forEach((fr, i) => {
    const r = uf.find(i);
    const g = groups.get(r);
    if (g) g.push(fr); else groups.set(r, [fr]);
  });

  // 4. regions: merge each group's fragments along the artificial seams (fallback: keep fragments)
  const built = [...groups.values()].map(frs => {
    const merged = unionAdjacentPolygons(frs.map(fr => fr.poly), LINE_TOL);
    const regions: Region2[] = merged
      ? merged.map(r => ({ polygon: r.polygon, holes: r.holes.map(h => ensureCW(h)) }))
      : frs.map(fr => ({ polygon: fr.poly, holes: [] }));
    const bendIds = new Set<string>();
    const sides = new Map<string, Set<1 | -1>>();
    for (const fr of frs) {
      for (const [bid, ss] of fr.adjacency) {
        bendIds.add(bid);
        let s = sides.get(bid);
        if (!s) { s = new Set(); sides.set(bid, s); }
        for (const side of ss) s.add(side);
      }
    }
    return { regions, area: 0, bendIds: [...bendIds], sides };
  });

  // 5. holes: attached to the region containing every vertex without crossing its boundary (and not
  //    lying inside one of the region's own holes)
  holes.forEach((h, index) => {
    if (h.length < 3) { warnings.push({ key: 'warnings.part.holeDropped', params: { index }, severity: 'warning' }); return; }
    let owner: Region2 | undefined;
    for (const b of built) {
      for (const r of b.regions) {
        if (!h.every(p => pointInPolygon(p, r.polygon, LINE_TOL))) continue;
        if (boundariesCross(h, r.polygon)) continue;
        if (r.holes.some(rh => h.some(p => classifyPoint(p, rh, LINE_TOL) === 'inside'))) continue;
        owner = r;
        break;
      }
      if (owner) break;
    }
    if (owner) owner.holes.push(h);
    else warnings.push({ key: 'warnings.part.holeDropped', params: { index }, severity: 'warning' });
  });

  // 6. flanges sorted by area (regions minus holes) descending
  const regionArea = (r: Region2): number => area(r.polygon) - r.holes.reduce((s, h) => s + area(h), 0);
  for (const b of built) b.area = b.regions.reduce((s, r) => s + regionArea(r), 0);
  built.sort((a, b) => b.area - a.area);
  const flanges: Flange[] = built.map((f, i) => ({ id: `F${i + 1}`, regions: f.regions, area: f.area, bendIds: f.bendIds }));
  if (flanges.length === 0) {
    warnings.push({ key: 'warnings.part.noOutline', severity: 'error' });
    return { flat, flanges, rootFlangeId: '', links: [], bendAllowance: ba, flatBounds, warnings };
  }

  // 7. per bend: the flange on each side (largest when several)
  const bendSides = new Map<string, { minus: string | null; plus: string | null }>();
  for (const f of frames) {
    const bid = f.bend.id;
    const pick = (side: 1 | -1): string | null => {
      const cands = built.map((b, i) => ({ b, i })).filter(({ b }) => b.sides.get(bid)?.has(side));
      if (cands.length === 0) {
        warnings.push({ key: 'warnings.part.bendNoMaterial', params: { bendId: bid, side: side > 0 ? '+' : '-' }, severity: 'warning' });
        return null;
      }
      if (cands.length > 1) {
        warnings.push({ key: 'warnings.part.multipleFlangesOnSide', params: { bendId: bid, side: side > 0 ? '+' : '-', count: cands.length }, severity: 'warning' });
      }
      return flanges[cands[0]!.i]!.id; // `built` is sorted by area desc, so the first candidate is the largest
    };
    bendSides.set(bid, { minus: pick(-1), plus: pick(1) });
  }

  // 8. BFS from the root
  const rootFlangeId = flanges[0]!.id;
  const links: FlangeLink[] = [];
  const visited = new Set<string>([rootFlangeId]);
  const linkedBends = new Set<string>();
  const queue = [rootFlangeId];
  const byId = new Map(flanges.map(f => [f.id, f]));
  const cycle = (bid: string): void => {
    if (!endInMaterial.has(bid)) warnings.push({ key: 'warnings.part.bendCycle', params: { bendId: bid }, severity: 'warning' });
  };
  while (queue.length) {
    const u = queue.shift()!;
    const flange = byId.get(u)!;
    for (const bid of flange.bendIds) {
      if (linkedBends.has(bid)) continue;
      const sides = bendSides.get(bid)!;
      if (!sides.minus || !sides.plus) continue;
      if (sides.minus === sides.plus) {
        linkedBends.add(bid);
        cycle(bid);
        continue;
      }
      let v: string;
      if (sides.minus === u) v = sides.plus;
      else if (sides.plus === u) v = sides.minus;
      else continue; // u touches the bend but is not the chosen flange on either side
      linkedBends.add(bid);
      if (visited.has(v)) { cycle(bid); continue; }
      visited.add(v);
      links.push({ bendId: bid, parentFlangeId: u, childFlangeId: v });
      queue.push(v);
    }
  }
  for (const f of flanges) {
    if (!visited.has(f.id)) warnings.push({ key: 'warnings.part.flangeDisconnected', params: { flangeId: f.id }, severity: 'warning' });
  }
  for (const f of frames) {
    const sides = bendSides.get(f.bend.id)!;
    if (!linkedBends.has(f.bend.id) && sides.minus && sides.plus) {
      // both sides exist but never reached from the root (only possible when those flanges are disconnected)
      cycle(f.bend.id);
    }
  }
  for (const b of flat.bends) {
    if (!bendSides.has(b.id)) {
      warnings.push({ key: 'warnings.part.bendNoMaterial', params: { bendId: b.id, side: '-' }, severity: 'warning' });
      warnings.push({ key: 'warnings.part.bendNoMaterial', params: { bendId: b.id, side: '+' }, severity: 'warning' });
    }
  }

  return { flat, flanges, rootFlangeId, links, bendAllowance: ba, flatBounds, warnings };
}
