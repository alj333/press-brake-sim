/**
 * matchToDxf: align the recognised bends with a DXF flat pattern (2D Kabsch on bend-line
 * midpoints, brute force for ≤ 4 bends / RANSAC above, both reflections) and copy angle / radius
 * / direction onto the DXF bends. See docs/specs/recognize-3d.md §2.
 */
import type { BendLine, FlatPattern, MatchResult, Message, RecognizedSheet, Vec2 } from '../../types';
import { vec2, distanceToBoundary, centroid } from '../../geom';
import { issue } from './messages';

export interface FlatTransform { rotationDeg: number; translation: Vec2; mirrored: boolean }

/** Map a point of the recognised flat into the DXF flat: mirror (x → −x) first, then rotate, then translate. */
export function applyFlatTransform(p: Vec2, t: FlatTransform): Vec2 {
  const q = t.mirrored ? { x: -p.x, y: p.y } : p;
  return vec2.add(vec2.rotate(q, t.rotationDeg), t.translation);
}

interface Line { id: string; p0: Vec2; p1: Vec2; mid: Vec2; dir: Vec2; len: number }

function toLine(b: BendLine, mirror: boolean): Line {
  const p0 = mirror ? { x: -b.p0.x, y: b.p0.y } : b.p0;
  const p1 = mirror ? { x: -b.p1.x, y: b.p1.y } : b.p1;
  const d = vec2.sub(p1, p0);
  const len = vec2.length(d);
  return { id: b.id, p0, p1, mid: vec2.midpoint(p0, p1), dir: len > 0 ? vec2.scale(d, 1 / len) : { x: 1, y: 0 }, len };
}

/** Optimal proper rotation + translation mapping a_i onto b_i (2D Kabsch). */
export function kabsch2d(a: Vec2[], b: Vec2[]): { rotationDeg: number; translation: Vec2 } {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { rotationDeg: 0, translation: { x: 0, y: 0 } };
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) { ax += a[i]!.x; ay += a[i]!.y; bx += b[i]!.x; by += b[i]!.y; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let sDot = 0, sCross = 0;
  for (let i = 0; i < n; i++) {
    const px = a[i]!.x - ax, py = a[i]!.y - ay, qx = b[i]!.x - bx, qy = b[i]!.y - by;
    sDot += px * qx + py * qy; sCross += px * qy - py * qx;
  }
  const rotationDeg = sDot === 0 && sCross === 0 ? 0 : (Math.atan2(sCross, sDot) * 180) / Math.PI;
  const ra = vec2.rotate({ x: ax, y: ay }, rotationDeg);
  return { rotationDeg, translation: { x: bx - ra.x, y: by - ra.y } };
}

const PARALLEL_DEG = 2;
const PERP_TOL = 1;
const OVERLAP_MIN = 0.5;

interface Candidate { i: number; j: number; dist: number }

/** Pair rule for a mapped rec line (q0, q1) against a DXF line: parallel, close and overlapping. */
function pairDistance(q0: Vec2, q1: Vec2, dxf: Line): number | null {
  const d = vec2.sub(q1, q0), len = vec2.length(d);
  if (len === 0 || dxf.len === 0) return null;
  const dir = vec2.scale(d, 1 / len);
  if (Math.abs(vec2.dot(dir, dxf.dir)) < Math.cos((PARALLEL_DEG * Math.PI) / 180)) return null;
  const n = vec2.perp(dxf.dir);
  const d0 = Math.abs(vec2.dot(vec2.sub(q0, dxf.p0), n)), d1 = Math.abs(vec2.dot(vec2.sub(q1, dxf.p0), n));
  if (d0 > PERP_TOL || d1 > PERP_TOL) return null;
  const s0 = vec2.dot(vec2.sub(q0, dxf.p0), dxf.dir), s1 = vec2.dot(vec2.sub(q1, dxf.p0), dxf.dir);
  const overlap = Math.min(Math.max(s0, s1), dxf.len) - Math.max(Math.min(s0, s1), 0);
  if (overlap < OVERLAP_MIN * Math.min(len, dxf.len)) return null;
  return Math.max(d0, d1);
}

interface Scored { pairs: Candidate[]; totalDist: number }

function scoreTransform(rot: number, tr: Vec2, rec: Line[], dxf: Line[]): Scored {
  const cands: Candidate[] = [];
  for (let i = 0; i < rec.length; i++) {
    const q0 = vec2.add(vec2.rotate(rec[i]!.p0, rot), tr), q1 = vec2.add(vec2.rotate(rec[i]!.p1, rot), tr);
    for (let j = 0; j < dxf.length; j++) {
      const dist = pairDistance(q0, q1, dxf[j]!);
      if (dist !== null) cands.push({ i, j, dist });
    }
  }
  cands.sort((a, b) => a.dist - b.dist);
  const usedI = new Set<number>(), usedJ = new Set<number>();
  const pairs: Candidate[] = [];
  let totalDist = 0;
  for (const c of cands) {
    if (usedI.has(c.i) || usedJ.has(c.j)) continue;
    usedI.add(c.i); usedJ.add(c.j); pairs.push(c); totalDist += c.dist;
  }
  return { pairs, totalDist };
}

/** Enumerate injective maps of k elements into m (as index arrays), at most `cap` of them. */
function injections(k: number, m: number, cap: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(m).fill(false);
  const rec = (): void => {
    if (out.length >= cap) return;
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      used[j] = true; cur.push(j); rec(); cur.pop(); used[j] = false;
    }
  };
  rec();
  return out;
}

function countInjections(k: number, m: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c *= m - i;
  return c;
}

/** Deterministic LCG for RANSAC sampling. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface Hypothesis { rot: number; tr: Vec2 }

function hypotheses(rec: Line[], dxf: Line[]): Hypothesis[] {
  const hs: Hypothesis[] = [];
  const nr = rec.length, nd = dxf.length;
  if (nr === 0 || nd === 0) return hs;
  const k = Math.min(nr, nd);
  const m = Math.max(nr, nd);
  if (k === 1) {
    for (const r of rec) for (const d of dxf) {
      const base = vec2.angleDeg(d.dir) - vec2.angleDeg(r.dir);
      for (const rot of [base, base + 180]) {
        const rm = vec2.rotate(r.mid, rot);
        hs.push({ rot, tr: vec2.sub(d.mid, rm) });
      }
    }
    return hs;
  }
  // brute force: Kabsch over every injective assignment of the smaller set (k ≤ 4)
  if (k <= 4 && countInjections(k, m) <= 20000) {
    const maps = injections(k, m, 20000);
    for (const map of maps) {
      const a: Vec2[] = [], b: Vec2[] = [];
      for (let s = 0; s < k; s++) {
        if (nr <= nd) { a.push(rec[s]!.mid); b.push(dxf[map[s]!]!.mid); }
        else { a.push(rec[map[s]!]!.mid); b.push(dxf[s]!.mid); }
      }
      const kb = kabsch2d(a, b);
      hs.push({ rot: kb.rotationDeg, tr: kb.translation });
    }
  }
  // two-correspondence samples (exhaustive when cheap, else RANSAC): immune to a midpoint shifted
  // along its line (a DXF line drawn across reliefs) and to extra / missing bends
  const samples: Array<[number, number, number, number]> = [];
  const total = (nr * (nr - 1) / 2) * nd * (nd - 1);
  if (total <= 20000) {
    for (let i1 = 0; i1 < nr; i1++) for (let i2 = i1 + 1; i2 < nr; i2++)
      for (let j1 = 0; j1 < nd; j1++) for (let j2 = 0; j2 < nd; j2++) if (j1 !== j2) samples.push([i1, i2, j1, j2]);
  } else {
    const rnd = lcg(12345);
    for (let s = 0; s < 20000; s++) {
      const i1 = Math.floor(rnd() * nr); let i2 = Math.floor(rnd() * nr); if (i2 === i1) i2 = (i1 + 1) % nr;
      const j1 = Math.floor(rnd() * nd); let j2 = Math.floor(rnd() * nd); if (j2 === j1) j2 = (j1 + 1) % nd;
      samples.push([i1, i2, j1, j2]);
    }
  }
  for (const [i1, i2, j1, j2] of samples) {
    const dr = vec2.dist(rec[i1]!.mid, rec[i2]!.mid), dd = vec2.dist(dxf[j1]!.mid, dxf[j2]!.mid);
    if (dr < 1 || Math.abs(dr - dd) > 20) continue;
    const kb = kabsch2d([rec[i1]!.mid, rec[i2]!.mid], [dxf[j1]!.mid, dxf[j2]!.mid]);
    hs.push({ rot: kb.rotationDeg, tr: kb.translation });
  }
  return hs;
}

/** Gauss–Newton refinement of (φ, tx, ty) on the perpendicular distances of matched end points. */
function refine(h: Hypothesis, pairs: Candidate[], rec: Line[], dxf: Line[]): Hypothesis {
  let rot = h.rot, tr = h.tr;
  for (let iter = 0; iter < 3; iter++) {
    let a00 = 1e-6, a01 = 0, a02 = 0, a11 = 1e-6, a12 = 0, a22 = 1e-6, g0 = 0, g1 = 0, g2 = 0;
    for (const c of pairs) {
      const d = dxf[c.j]!, n = vec2.perp(d.dir);
      for (const p of [rec[c.i]!.p0, rec[c.i]!.p1]) {
        const rp = vec2.rotate(p, rot);
        const r = vec2.dot(vec2.sub(vec2.add(rp, tr), d.p0), n);
        const jphi = vec2.dot(vec2.perp(rp), n) * (Math.PI / 180);
        const J = [jphi, n.x, n.y];
        a00 += J[0]! * J[0]!; a01 += J[0]! * J[1]!; a02 += J[0]! * J[2]!; a11 += J[1]! * J[1]!; a12 += J[1]! * J[2]!; a22 += J[2]! * J[2]!;
        g0 += J[0]! * r; g1 += J[1]! * r; g2 += J[2]! * r;
      }
    }
    // solve A δ = −g (symmetric 3×3, Cramer)
    const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
    if (Math.abs(det) < 1e-18) break;
    const b0 = -g0, b1 = -g1, b2 = -g2;
    const d0 = (b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a12 - a11 * b2)) / det;
    const d1 = (a00 * (b1 * a22 - a12 * b2) - b0 * (a01 * a22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)) / det;
    const d2 = (a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - a11 * a02)) / det;
    if (![d0, d1, d2].every(Number.isFinite)) break;
    rot += d0; tr = { x: tr.x + d1, y: tr.y + d2 };
  }
  return { rot, tr };
}

function normDeg(a: number): number {
  let r = a % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}

/**
 * Mismatch of the mapped rec outline / holes against the DXF outline / holes (mm): mean distance
 * of the mapped outline vertices to the DXF outline plus the mean hole-centroid distance. Breaks
 * the mirror ambiguity of symmetric bend-line patterns.
 */
function outlineMismatch(rec: FlatPattern, flat: FlatPattern, t: FlatTransform): number {
  if (rec.outline.length < 3 || flat.outline.length < 3) return 0;
  const step = Math.max(1, Math.floor(rec.outline.length / 200));
  let sum = 0, n = 0;
  for (let i = 0; i < rec.outline.length; i += step) {
    sum += distanceToBoundary(applyFlatTransform(rec.outline[i]!, t), flat.outline); n++;
  }
  let holeSum = 0;
  if (rec.holes.length > 0 && flat.holes.length > 0) {
    const dxfCentres = flat.holes.map(h => centroid(h));
    for (const h of rec.holes) {
      const c = applyFlatTransform(centroid(h), t);
      holeSum += Math.min(...dxfCentres.map(d => vec2.dist(c, d)));
    }
    holeSum /= rec.holes.length;
  }
  return (n ? sum / n : 0) + holeSum;
}

interface Best { h: Hypothesis; mirrored: boolean; scored: Scored; mismatch: number; dirAgree: number }

/** Align the recognised bends with a DXF flat pattern and copy their attributes onto it. */
export function matchToDxf(rec: RecognizedSheet, flat: FlatPattern): MatchResult {
  const warnings: Message[] = [];
  const dxfLines = flat.bends.map(b => toLine(b, false));
  let best: Best | null = null;
  let evaluated = 0;
  if (rec.flat.bends.length === 0 || flat.bends.length === 0) {
    warnings.push(issue('noBendsToMatch', undefined, 'info'));
  } else {
    for (const mirrored of [false, true]) {
      const recLines = rec.flat.bends.map(b => toLine(b, mirrored));
      const seen = new Set<string>();
      for (const h of hypotheses(recLines, dxfLines)) {
        let scored = scoreTransform(h.rot, h.tr, recLines, dxfLines);
        if (scored.pairs.length === 0) continue;
        const hr = refine(h, scored.pairs, recLines, dxfLines);
        const rescored = scoreTransform(hr.rot, hr.tr, recLines, dxfLines);
        let use = h;
        if (rescored.pairs.length > scored.pairs.length || (rescored.pairs.length === scored.pairs.length && rescored.totalDist <= scored.totalDist)) { use = hr; scored = rescored; }
        // skip hypotheses equivalent to one already evaluated
        const key = `${Math.round(normDeg(use.rot) * 100)}|${Math.round(use.tr.x * 20)}|${Math.round(use.tr.y * 20)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (best && (scored.pairs.length < best.scored.pairs.length || (scored.pairs.length === best.scored.pairs.length && scored.totalDist > best.scored.totalDist + 0.05))) continue;
        // the outline comparison is the expensive part: after many ties only strictly better hypotheses get it
        if (best && evaluated > 500 && scored.pairs.length === best.scored.pairs.length && scored.totalDist >= best.scored.totalDist - 0.05) continue;
        evaluated++;
        const t: FlatTransform = { rotationDeg: use.rot, translation: use.tr, mirrored };
        const mismatch = outlineMismatch(rec.flat, flat, t);
        let dirAgree = 0;
        for (const c of scored.pairs) {
          const rd = rec.flat.bends[c.i]!.direction, dd = flat.bends[c.j]!.direction;
          if ((mirrored ? rd !== dd : rd === dd)) dirAgree++;
        }
        const better = !best
          || scored.pairs.length > best.scored.pairs.length
          || scored.totalDist < best.scored.totalDist - 0.05
          || mismatch < best.mismatch - 0.1
          || (Math.abs(mismatch - best.mismatch) <= 0.1 && dirAgree > best.dirAgree)
          || (Math.abs(mismatch - best.mismatch) <= 0.1 && dirAgree === best.dirAgree && best.mirrored && !mirrored);
        if (better) best = { h: use, mirrored, scored, mismatch, dirAgree };
      }
    }
  }

  const mirrored = best?.mirrored ?? false;
  const transform: FlatTransform = {
    rotationDeg: best ? Math.round(normDeg(best.h.rot) * 1e6) / 1e6 : 0,
    translation: best ? { x: Math.round(best.h.tr.x * 1e6) / 1e6, y: Math.round(best.h.tr.y * 1e6) / 1e6 } : { x: 0, y: 0 },
    mirrored,
  };
  const pairs: MatchResult['pairs'] = [];
  const matchedDxf = new Set<string>(), matchedRec = new Set<string>();
  const bends = flat.bends.map(b => ({ ...b, sources: { ...b.sources } }));
  if (best) {
    for (const c of best.scored.pairs) {
      const rb = rec.flat.bends[c.i]!, db = bends[c.j]!;
      pairs.push({ dxfBendId: db.id, recBendId: rb.id });
      matchedDxf.add(db.id); matchedRec.add(rb.id);
      const src = rb.sources.angle === 'step' ? 'step' : 'mesh';
      db.angle = rb.angle;
      db.innerRadius = rb.innerRadius;
      db.direction = mirrored ? (rb.direction === 'up' ? 'down' : 'up') : rb.direction;
      db.sources = { ...db.sources, angle: src, radius: src, direction: src };
      if (rb.hem) { db.hem = rb.hem; if (rb.hemGap !== undefined) db.hemGap = rb.hemGap; }
    }
  }
  const unmatchedDxf = flat.bends.filter(b => !matchedDxf.has(b.id)).map(b => b.id);
  const unmatchedRec = rec.flat.bends.filter(b => !matchedRec.has(b.id)).map(b => b.id);
  if (flat.bends.length !== rec.flat.bends.length && flat.bends.length > 0 && rec.flat.bends.length > 0) {
    warnings.push(issue('bendCountMismatch', { dxf: flat.bends.length, rec: rec.flat.bends.length }));
  }
  for (const id of unmatchedDxf) warnings.push(issue('unmatchedDxfBend', { bendId: id }));
  for (const id of unmatchedRec) warnings.push(issue('unmatchedRecBend', { bendId: id }));
  if (mirrored) warnings.push(issue('matchMirrored', undefined, 'info'));

  const out: FlatPattern = { ...flat, bends, warnings: [...(flat.warnings ?? []), ...warnings] };
  return { flat: out, pairs, unmatchedDxf, unmatchedRec, mirrored, transform, warnings };
}
