/**
 * Union of NON-OVERLAPPING polygons that touch along collinear boundary segments — e.g. the
 * fragments of one polygon after a series of line splits. Shared boundary portions (an edge of
 * one polygon running anti-parallel over an edge of another) are removed and the remaining edge
 * pieces are chained into loops. CCW loops are outer boundaries, CW loops are holes enclosed by
 * the union (assigned to the outer loop that contains them).
 */
import type { Polygon2, Vec2 } from '../types';
import { EPS, add, cross, dist, dot, scale, sub } from './vec2';
import { dedupe, ensureCCW, pointInPolygon, signedArea, simplifyCollinear } from './polygon';

export interface MergedRegion { polygon: Polygon2; holes: Polygon2[] }

interface Edge { a: Vec2; b: Vec2; u: Vec2; len: number; poly: number; cuts: Array<{ t0: number; t1: number; p0: Vec2; p1: Vec2 }> }
interface Piece { a: Vec2; b: Vec2; u: Vec2 }

/**
 * Merge edge-adjacent polygons into regions. Polygons that do not touch any other stay as they
 * are (one region each, no holes). Returns null when the chaining fails (inconsistent input:
 * overlapping polygons, gaps along seams larger than `tol`) so callers can fall back.
 */
export function unionAdjacentPolygons(polys: Polygon2[], tol = EPS): MergedRegion[] | null {
  const edges: Edge[] = [];
  polys.forEach((raw, pi) => {
    const p = dedupe(ensureCCW(raw), tol);
    for (let i = 0, n = p.length; i < n; i++) {
      const a = p[i]!, b = p[(i + 1) % n]!;
      const d = sub(b, a), len = Math.hypot(d.x, d.y);
      if (len <= tol) continue;
      edges.push({ a, b, u: scale(d, 1 / len), len, poly: pi, cuts: [] });
    }
  });

  // shared portions between anti-parallel collinear edges of different polygons
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j]!;
      if (f.poly === e.poly) continue;
      if (dot(e.u, f.u) > -0.5) continue;                                   // not anti-parallel
      if (Math.abs(cross(e.u, sub(f.a, e.a))) > tol || Math.abs(cross(e.u, sub(f.b, e.a))) > tol) continue;
      const tb = dot(sub(f.b, e.a), e.u), ta = dot(sub(f.a, e.a), e.u);     // f runs from ta down to tb on e
      const lo = Math.max(0, tb), hi = Math.min(e.len, ta);
      if (hi - lo <= tol) continue;
      const p0 = lo <= tol ? e.a : add(e.a, scale(e.u, lo));
      const p1 = hi >= e.len - tol ? e.b : add(e.a, scale(e.u, hi));
      e.cuts.push({ t0: lo, t1: hi, p0, p1 });
      // the same points on f (f.u = −e.u): param of p on f = dot(p − f.a, f.u)
      f.cuts.push({ t0: dot(sub(p1, f.a), f.u), t1: dot(sub(p0, f.a), f.u), p0: p1, p1: p0 });
    }
  }

  // remaining pieces of every edge
  const pieces: Piece[] = [];
  for (const e of edges) {
    if (e.cuts.length === 0) { pieces.push({ a: e.a, b: e.b, u: e.u }); continue; }
    e.cuts.sort((x, y) => x.t0 - y.t0);
    let t = 0, from: Vec2 = e.a;
    for (const c of e.cuts) {
      if (c.t0 - t > tol) pieces.push({ a: from, b: c.p0, u: e.u });
      if (c.t1 > t) { t = c.t1; from = c.p1; }
    }
    if (e.len - t > tol) pieces.push({ a: from, b: e.b, u: e.u });
  }

  // chain pieces into loops; at a multi-way vertex take the leftmost turn (keeps loops simple)
  const used = new Array<boolean>(pieces.length).fill(false);
  const loops: Polygon2[] = [];
  for (let s = 0; s < pieces.length; s++) {
    if (used[s]) continue;
    const start = pieces[s]!;
    const loop: Vec2[] = [start.a];
    let cur = start;
    used[s] = true;
    let guard = 0;
    for (;;) {
      if (guard++ > pieces.length + 1) return null;
      const end = cur.b;
      if (dist(end, start.a) <= tol) break;
      let best = -1, bestTurn = -Infinity;
      for (let k = 0; k < pieces.length; k++) {
        if (used[k]) continue;
        const cand = pieces[k]!;
        if (dist(cand.a, end) > tol) continue;
        const turn = Math.atan2(cross(cur.u, cand.u), dot(cur.u, cand.u));
        if (turn > bestTurn) { bestTurn = turn; best = k; }
      }
      if (best < 0) return null;
      used[best] = true;
      loop.push(end);
      cur = pieces[best]!;
    }
    const clean = simplifyCollinear(dedupe(loop, tol), tol);
    if (clean.length >= 3 && Math.abs(signedArea(clean)) > 1e-12) loops.push(clean);
  }

  const regions: MergedRegion[] = [];
  const inners: Polygon2[] = [];
  for (const l of loops) {
    if (signedArea(l) > 0) regions.push({ polygon: l, holes: [] });
    else inners.push(l);
  }
  for (const h of inners) {
    const probe = h[0]!;
    let owner: MergedRegion | undefined;
    for (const r of regions) {
      if (!pointInPolygon(probe, r.polygon, tol)) continue;
      if (!owner || Math.abs(signedArea(r.polygon)) < Math.abs(signedArea(owner.polygon))) owner = r;
    }
    if (!owner) return null;
    owner.holes.push(h);
  }
  return regions;
}
