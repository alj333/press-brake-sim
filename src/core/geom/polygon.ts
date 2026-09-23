/**
 * 2D polygon utilities (pure, mm). Polygons are closed vertex lists with an implicit closing
 * edge; outer boundaries CCW (positive signed area). See docs/specs/core-geometry.md §1.4.
 */
import type { Polygon2, Vec2 } from '../types';
import { EPS, cross, dot, sub, add, scale, perp, normalize, dist, length, midpoint } from './vec2';

export type PointClass = 'inside' | 'outside' | 'edge';

export function signedArea(p: Polygon2): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[i]!, r = p[(i + 1) % n]!;
    a += q.x * r.y - r.x * q.y;
  }
  return a / 2;
}

export function area(p: Polygon2): number { return Math.abs(signedArea(p)); }
export function isCCW(p: Polygon2): boolean { return signedArea(p) > 0; }

/** Returns `p` itself when already CCW (or degenerate), otherwise a reversed copy. */
export function ensureCCW(p: Polygon2): Polygon2 { return signedArea(p) < 0 ? p.slice().reverse() : p; }
/** Returns `p` itself when already CW (or degenerate), otherwise a reversed copy. */
export function ensureCW(p: Polygon2): Polygon2 { return signedArea(p) > 0 ? p.slice().reverse() : p; }

export function centroid(p: Polygon2): Vec2 {
  const n = p.length;
  if (n === 0) return { x: 0, y: 0 };
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const q = p[i]!, r = p[(i + 1) % n]!;
    const w = q.x * r.y - r.x * q.y;
    a += w; cx += (q.x + r.x) * w; cy += (q.y + r.y) * w;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (const q of p) { sx += q.x; sy += q.y; }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function bounds(p: Polygon2): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of p) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** Distance from a point to a closed segment. */
export function pointSegmentDistance(pt: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a), ap = sub(pt, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return length(ap);
  let t = dot(ap, ab) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist(pt, add(a, scale(ab, t)));
}

/** Min distance from a point to the polygon boundary. */
export function distanceToBoundary(pt: Vec2, poly: Polygon2): number {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = pointSegmentDistance(pt, poly[i]!, poly[(i + 1) % n]!);
    if (d < best) best = d;
  }
  return best;
}

/** Ray casting with an on-edge band of `tol`. */
export function classifyPoint(pt: Vec2, poly: Polygon2, tol = EPS): PointClass {
  const n = poly.length;
  if (n < 3) return 'outside';
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (pointSegmentDistance(pt, a, b) <= tol) return 'edge';
    if ((a.y > pt.y) !== (b.y > pt.y)) {
      const x = ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
      if (pt.x < x) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

/** True when inside or on the boundary (within tol). */
export function pointInPolygon(pt: Vec2, poly: Polygon2, tol = EPS): boolean {
  return classifyPoint(pt, poly, tol) !== 'outside';
}

export interface SegmentHit { point: Vec2; ta: number; tb: number }

/**
 * Closed-segment intersection. Endpoint touches count (within tol). Collinear overlapping
 * segments return the midpoint of the overlap. Returns null when disjoint.
 */
export function segmentIntersect(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2, tol = EPS): SegmentHit | null {
  const r = sub(a1, a0), s = sub(b1, b0);
  const denom = cross(r, s);
  const qp = sub(b0, a0);
  const la = length(r), lb = length(s);
  if (Math.abs(denom) > 1e-12 * Math.max(1, la * lb)) {
    const ta = cross(qp, s) / denom;
    const tb = cross(qp, r) / denom;
    const ea = la > 0 ? tol / la : 0, eb = lb > 0 ? tol / lb : 0;
    if (ta >= -ea && ta <= 1 + ea && tb >= -eb && tb <= 1 + eb) {
      const ca = Math.min(1, Math.max(0, ta)), cb = Math.min(1, Math.max(0, tb));
      return { point: add(a0, scale(r, ca)), ta: ca, tb: cb };
    }
    return null;
  }
  // parallel: collinear?
  if (la === 0 && lb === 0) return dist(a0, b0) <= tol ? { point: a0, ta: 0, tb: 0 } : null;
  if (la === 0) return pointSegmentDistance(a0, b0, b1) <= tol ? { point: a0, ta: 0, tb: paramOn(b0, s, a0) } : null;
  if (lb === 0) return pointSegmentDistance(b0, a0, a1) <= tol ? { point: b0, ta: paramOn(a0, r, b0), tb: 0 } : null;
  if (Math.abs(cross(qp, r)) / la > tol) return null; // parallel, not collinear
  const t0 = dot(qp, r) / (la * la), t1 = dot(sub(b1, a0), r) / (la * la);
  const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
  if (lo > hi + tol / la) return null;
  const tm = (Math.max(0, Math.min(lo, 1)) + Math.max(0, Math.min(hi, 1))) / 2;
  const point = add(a0, scale(r, tm));
  return { point, ta: tm, tb: paramOn(b0, s, point) };
}

function paramOn(origin: Vec2, dir: Vec2, p: Vec2): number {
  const l2 = dot(dir, dir);
  if (l2 === 0) return 0;
  const t = dot(sub(p, origin), dir) / l2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function segmentDistance(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): number {
  if (segmentIntersect(a0, a1, b0, b1, 0)) return 0;
  return Math.min(
    pointSegmentDistance(a0, b0, b1), pointSegmentDistance(a1, b0, b1),
    pointSegmentDistance(b0, a0, a1), pointSegmentDistance(b1, a0, a1),
  );
}

/** Edge crossing OR containment either way (closed-set semantics: touching ⇒ true). */
export function polygonsIntersect(a: Polygon2, b: Polygon2, tol = EPS): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const ba = bounds(a), bb = bounds(b);
  if (ba.max.x < bb.min.x - tol || bb.max.x < ba.min.x - tol || ba.max.y < bb.min.y - tol || bb.max.y < ba.min.y - tol) return false;
  for (let i = 0, n = a.length; i < n; i++) {
    const a0 = a[i]!, a1 = a[(i + 1) % n]!;
    for (let j = 0, m = b.length; j < m; j++) {
      if (segmentIntersect(a0, a1, b[j]!, b[(j + 1) % m]!, tol)) return true;
    }
  }
  if (pointInPolygon(a[0]!, b, tol)) return true;
  if (pointInPolygon(b[0]!, a, tol)) return true;
  return false;
}

/** Candidates of `a` inside `b`: vertices strictly inside + midpoints of edge sub-segments inside. */
function penetrationOneWay(a: Polygon2, b: Polygon2): number {
  let best = 0;
  const n = a.length, m = b.length;
  // centroid candidate: covers coincident polygons whose vertices all lie on each other's boundary
  const c = centroid(a);
  if (classifyPoint(c, a) === 'inside' && classifyPoint(c, b) === 'inside') best = distanceToBoundary(c, b);
  for (let i = 0; i < n; i++) {
    const p = a[i]!, q = a[(i + 1) % n]!;
    if (classifyPoint(p, b) === 'inside') best = Math.max(best, distanceToBoundary(p, b));
    const ts: number[] = [0, 1];
    for (let j = 0; j < m; j++) {
      const hit = segmentIntersect(p, q, b[j]!, b[(j + 1) % m]!);
      if (hit) ts.push(hit.ta);
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1]! - ts[k]! < 1e-9) continue;
      const mid = add(p, scale(sub(q, p), (ts[k]! + ts[k + 1]!) / 2));
      if (classifyPoint(mid, b) === 'inside') best = Math.max(best, distanceToBoundary(mid, b));
    }
  }
  return best;
}

/**
 * 0 when disjoint or touching; otherwise a cheap lower bound on the minimum translation
 * distance (max distance of an interior point of one polygon to the other's boundary).
 */
export function penetrationDepth(a: Polygon2, b: Polygon2): number {
  if (!polygonsIntersect(a, b)) return 0;
  return Math.max(penetrationOneWay(a, b), penetrationOneWay(b, a));
}

/** 0 when intersecting, else the minimum edge-to-edge distance. */
export function polygonDistance(a: Polygon2, b: Polygon2): number {
  if (polygonsIntersect(a, b)) return 0;
  let best = Infinity;
  for (let i = 0, n = a.length; i < n; i++) {
    const a0 = a[i]!, a1 = a[(i + 1) % n]!;
    for (let j = 0, m = b.length; j < m; j++) {
      const d = segmentDistance(a0, a1, b[j]!, b[(j + 1) % m]!);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Remove consecutive duplicates (within tol) including the closing pair. */
export function dedupe(p: Polygon2, tol = EPS): Polygon2 {
  const out: Vec2[] = [];
  for (const q of p) {
    const last = out[out.length - 1];
    if (!last || dist(last, q) > tol) out.push(q);
  }
  while (out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= tol) out.pop();
  return out;
}

/** Remove vertices lying on the straight line between their neighbours. */
export function simplifyCollinear(p: Polygon2, tol = EPS): Polygon2 {
  const q = dedupe(p, tol);
  if (q.length < 4) return q;
  let changed = true;
  let cur = q;
  while (changed && cur.length > 3) {
    changed = false;
    const out: Vec2[] = [];
    for (let i = 0, n = cur.length; i < n; i++) {
      const a = cur[(i + n - 1) % n]!, b = cur[i]!, c = cur[(i + 1) % n]!;
      if (pointSegmentDistance(b, a, c) <= tol && dot(sub(b, a), sub(c, b)) >= 0) { changed = true; continue; }
      out.push(b);
    }
    cur = out;
  }
  return cur;
}

// ─── Splitting by a line ───────────────────────────────────────────────────────

interface SplitVertex { p: Vec2; s: number; t: number }

/**
 * Split a simple polygon by the infinite line through `point` along `dir`.
 * `left` = side where cross(dir, p − point) > 0. Output pieces are simple CCW polygons; pieces
 * that only touch each other at a point are returned separately. See the spec for the tracing.
 */
export function splitPolygonByLine(poly: Polygon2, point: Vec2, dir: Vec2, tol = EPS): { left: Polygon2[]; right: Polygon2[] } {
  const src = dedupe(ensureCCW(poly), tol);
  if (src.length < 3 || area(src) < 1e-9) return { left: [], right: [] };
  const d = normalize(dir);
  if (d.x === 0 && d.y === 0) return { left: [src], right: [] };
  const n = perp(d);

  // 1. signed distances, snapped; insert intersections on strictly crossing edges
  const verts: SplitVertex[] = [];
  const raw = src.map(p => {
    const rel = sub(p, point);
    let s = dot(rel, n);
    if (Math.abs(s) < tol) s = 0;
    return { p, s, t: dot(rel, d) };
  });
  let anyPos = false, anyNeg = false;
  for (const v of raw) { if (v.s > 0) anyPos = true; else if (v.s < 0) anyNeg = true; }
  if (!anyPos && !anyNeg) return { left: [], right: [] };
  if (!anyNeg) return { left: [src], right: [] };
  if (!anyPos) return { left: [], right: [src] };

  for (let i = 0, m = raw.length; i < m; i++) {
    const a = raw[i]!, b = raw[(i + 1) % m]!;
    verts.push(a);
    if ((a.s > 0 && b.s < 0) || (a.s < 0 && b.s > 0)) {
      const f = a.s / (a.s - b.s);
      const p = add(a.p, scale(sub(b.p, a.p), f));
      verts.push({ p, s: 0, t: dot(sub(p, point), d) });
    }
  }

  const N = verts.length;
  // 2. on-line vertices sorted along dir; intervals classified
  const onLine: number[] = [];
  for (let i = 0; i < N; i++) if (verts[i]!.s === 0) onLine.push(i);
  onLine.sort((i, j) => verts[i]!.t - verts[j]!.t);
  const M = onLine.length;
  type Interval = { from: number; to: number; kind: 'inside' | 'outside' | 'colPlus' | 'colMinus' };
  const intervals: Interval[] = [];
  for (let k = 0; k + 1 < M; k++) {
    const i = onLine[k]!, j = onLine[k + 1]!;
    const vi = verts[i]!, vj = verts[j]!;
    if (vj.t - vi.t <= tol) { intervals.push({ from: i, to: j, kind: 'outside' }); continue; }
    if ((i + 1) % N === j) { intervals.push({ from: i, to: j, kind: 'colPlus' }); continue; }   // edge i→j runs +dir
    if ((j + 1) % N === i) { intervals.push({ from: i, to: j, kind: 'colMinus' }); continue; }  // edge j→i runs −dir
    const mid = midpoint(vi.p, vj.p);
    const c = classifyPoint(mid, src, tol);
    intervals.push({ from: i, to: j, kind: c === 'inside' ? 'inside' : 'outside' });
  }

  const traceSide = (sigma: 1 | -1): Polygon2[] => {
    // chains: maximal runs of sigma-side vertices bounded by on-line vertices (CCW order)
    const chainStartAt = new Map<number, number[]>(); // on-line vertex index -> vertex indices of the chain (start..end inclusive)
    const chains: number[][] = [];
    for (let i = 0; i < N; i++) {
      if (verts[i]!.s !== 0) continue;
      const nxt = verts[(i + 1) % N]!;
      if (Math.sign(nxt.s) !== sigma) continue;
      const chain = [i];
      let j = (i + 1) % N;
      while (verts[j]!.s !== 0) { chain.push(j); j = (j + 1) % N; }
      chain.push(j);
      chains.push(chain);
      chainStartAt.set(i, chain);
    }
    if (chains.length === 0) return [];
    // bridges keyed by their start vertex
    const bridgeFrom = new Map<number, number>();
    for (const iv of intervals) {
      if (iv.kind === 'outside') continue;
      if (sigma === 1) {
        if (iv.kind === 'inside' || iv.kind === 'colPlus') bridgeFrom.set(iv.from, iv.to);
      } else {
        if (iv.kind === 'inside' || iv.kind === 'colMinus') bridgeFrom.set(iv.to, iv.from);
      }
    }
    const usedChain = new Set<number[]>();
    const usedBridge = new Set<number>();
    const pieces: Polygon2[] = [];
    for (const start of chains) {
      if (usedChain.has(start)) continue;
      const out: Vec2[] = [];
      let chain: number[] | undefined = start;
      let guard = 0;
      while (chain && guard++ < 4 * N + 8) {
        usedChain.add(chain);
        for (const idx of chain) out.push(verts[idx]!.p);
        let at = chain[chain.length - 1]!;
        // at a chain end: take the bridge starting here, else the chain starting here
        let next: number[] | undefined;
        let steps = 0;
        while (steps++ < M + 2) {
          const b = bridgeFrom.get(at);
          if (b !== undefined && !usedBridge.has(at)) {
            usedBridge.add(at);
            at = b;
            out.push(verts[at]!.p);
            const c = chainStartAt.get(at);
            if (c) { next = c; break; }
            continue; // pass through a touching point: next bridge
          }
          next = chainStartAt.get(at);
          break;
        }
        if (!next || next === start || usedChain.has(next)) break;
        chain = next;
      }
      const piece = dedupe(out, tol);
      if (piece.length >= 3 && area(piece) > 1e-9) pieces.push(ensureCCW(piece));
    }
    return pieces;
  };

  return { left: traceSide(1), right: traceSide(-1) };
}

/** Keep the part of the polygon where dot(p − point, insideNormal) ≥ 0. */
export function clipPolygonByHalfPlane(poly: Polygon2, point: Vec2, insideNormal: Vec2, tol = EPS): Polygon2[] {
  // left of dir is +insideNormal when dir = insideNormal rotated −90°
  const dir = { x: insideNormal.y, y: -insideNormal.x };
  return splitPolygonByLine(poly, point, dir, tol).left;
}

/** Total length of collinear overlapping boundary between two polygons. */
export function sharedBoundaryLength(a: Polygon2, b: Polygon2, lineTol = EPS): number {
  let total = 0;
  const n = a.length, m = b.length;
  for (let i = 0; i < n; i++) {
    const a0 = a[i]!, a1 = a[(i + 1) % n]!;
    const ra = sub(a1, a0), la = length(ra);
    if (la <= lineTol) continue;
    const ua = scale(ra, 1 / la);
    for (let j = 0; j < m; j++) {
      const b0 = b[j]!, b1 = b[(j + 1) % m]!;
      const lb = dist(b0, b1);
      if (lb <= lineTol) continue;
      // both endpoints of b within lineTol of a's supporting line, and vice versa
      if (Math.abs(cross(ua, sub(b0, a0))) > lineTol || Math.abs(cross(ua, sub(b1, a0))) > lineTol) continue;
      const ub = scale(sub(b1, b0), 1 / lb);
      if (Math.abs(cross(ub, sub(a0, b0))) > lineTol || Math.abs(cross(ub, sub(a1, b0))) > lineTol) continue;
      const t0 = dot(sub(b0, a0), ua), t1 = dot(sub(b1, a0), ua);
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(la, Math.max(t0, t1));
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

/** Andrew monotone chain; CCW; collinear points dropped. Fewer than 3 distinct points are returned as-is. */
export function convexHull(points: Vec2[]): Polygon2 {
  const pts = points.slice().sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
  const uniq: Vec2[] = [];
  for (const p of pts) { const l = uniq[uniq.length - 1]; if (!l || l.x !== p.x || l.y !== p.y) uniq.push(p); }
  if (uniq.length < 3) return uniq;
  const lower: Vec2[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1]!, lower[lower.length - 2]!), sub(p, lower[lower.length - 2]!)) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i]!;
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1]!, upper[upper.length - 2]!), sub(p, upper[upper.length - 2]!)) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** CCW rectangle around a segment (half width each side, optional extension at both ends). */
export function thickenSegment(p0: Vec2, p1: Vec2, halfWidth: number, endExtension = 0): Polygon2 {
  let d = sub(p1, p0);
  const l = length(d);
  d = l > 0 ? scale(d, 1 / l) : { x: 1, y: 0 };
  const a = sub(p0, scale(d, endExtension)), b = add(p1, scale(d, endExtension));
  const n = scale(perp(d), halfWidth);
  return [sub(a, n), sub(b, n), add(b, n), add(a, n)];
}

// ─── 2D affine transforms ──────────────────────────────────────────────────────

/** [a, b, c, d, e, f]: (x, y) → (a·x + c·y + e, b·x + d·y + f) (canvas order). */
export type Affine2 = readonly [number, number, number, number, number, number];

export function affineIdentity(): Affine2 { return [1, 0, 0, 1, 0, 0]; }
export function affineTranslation(tx: number, ty: number): Affine2 { return [1, 0, 0, 1, tx, ty]; }
export function affineRotation(deg: number): Affine2 {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}
export function affineMirrorX(): Affine2 { return [-1, 0, 0, 1, 0, 0]; }
/** m·n — apply n first, then m. */
export function affineMultiply(m: Affine2, n: Affine2): Affine2 {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export function affineApply(m: Affine2, p: Vec2): Vec2 {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}
export function transformPolygon2(poly: Polygon2, m: Affine2): Polygon2 { return poly.map(p => affineApply(m, p)); }
