/**
 * Sheet thickness = the most common distance between anti-parallel planar faces that overlap in
 * projection with the material between them. See docs/specs/recognize-3d.md §1.5.
 */
import { vec3, pointInPolygon } from '../../geom';
import type { PlanarFace } from './faces';
import { angleBetween } from './topology';

export interface ThicknessResult {
  thickness: number;
  /** Total weight (mm²) of the pairs that voted for the chosen bin. */
  weight: number;
  /** Candidate bins (distance, weight) sorted by weight, for diagnostics. */
  candidates: Array<{ distance: number; weight: number }>;
  /** Planar face ids that belong to a winning pair (sheet faces). */
  sheetFaces: Set<number>;
  /** The winning pairs (planar face ids): the two sides of one flange. */
  sheetPairs: Array<[number, number]>;
  /** True when no anti-parallel pair was found at all. */
  none: boolean;
}

const BIN = 0.02;
const ANTI_PARALLEL_DEG = 1;

/** Fraction of `b`'s outline vertices whose projection lies inside `a`'s outline (in a's plane). */
function overlapFraction(a: PlanarFace, b: PlanarFace): number {
  if (b.outline3.length === 0 || a.outline2.length < 3) return 0;
  let inside = 0;
  for (const p of b.outline3) {
    const d = vec3.sub(p, a.origin);
    if (pointInPolygon({ x: vec3.dot(d, a.e1), y: vec3.dot(d, a.e2) }, a.outline2, 1e-3)) inside++;
  }
  return inside / b.outline3.length;
}

export function detectThickness(faces: PlanarFace[], hint?: number): ThicknessResult {
  const cosAnti = -Math.cos((ANTI_PARALLEL_DEG * Math.PI) / 180);
  interface Pair { i: number; j: number; distance: number; weight: number }
  const pairs: Pair[] = [];
  for (let i = 0; i < faces.length; i++) {
    const fi = faces[i]!;
    if (fi.area <= 0) continue;
    for (let j = 0; j < faces.length; j++) {
      if (j === i) continue;
      const fj = faces[j]!;
      if (fj.area < fi.area || (fj.area === fi.area && j < i)) continue;   // count each pair once, from the smaller face
      if (vec3.dot(fi.normal, fj.normal) > cosAnti) continue;
      const along = vec3.dot(vec3.sub(fj.origin, fi.origin), fi.normal);
      if (along >= 0) continue;                                            // j must lie behind i (material between)
      if (angleBetween(fi.normal, vec3.neg(fj.normal)) > ANTI_PARALLEL_DEG) continue;
      if (overlapFraction(fj, fi) < 0.5) continue;
      pairs.push({ i, j, distance: -along, weight: fi.area });
    }
  }
  if (pairs.length === 0) {
    return { thickness: hint ?? 0, weight: 0, candidates: [], sheetFaces: new Set(), sheetPairs: [], none: true };
  }
  const bins = new Map<number, number>();
  for (const p of pairs) {
    const b = Math.round(p.distance / BIN);
    bins.set(b, (bins.get(b) ?? 0) + p.weight);
  }
  // weight of a bin including its neighbours
  const scored = [...bins.keys()].map(b => ({ bin: b, weight: (bins.get(b - 1) ?? 0) + (bins.get(b) ?? 0) + (bins.get(b + 1) ?? 0) }));
  scored.sort((a, b) => b.weight - a.weight);
  let chosen = scored[0]!;
  if (hint !== undefined && hint > 0) {
    const near = scored.find(s => Math.abs(s.bin * BIN - hint) <= 0.1 * hint);
    if (near) chosen = near;
  }
  const lo = (chosen.bin - 1.5) * BIN, hi = (chosen.bin + 1.5) * BIN;
  let sum = 0, w = 0;
  const sheetFaces = new Set<number>();
  const sheetPairs: Array<[number, number]> = [];
  for (const p of pairs) {
    if (p.distance < lo || p.distance > hi) continue;
    sum += p.distance * p.weight; w += p.weight;
    sheetFaces.add(faces[p.i]!.id); sheetFaces.add(faces[p.j]!.id);
    sheetPairs.push([faces[p.i]!.id, faces[p.j]!.id]);
  }
  const candidates = scored.map(s => ({ distance: Math.round(s.bin * BIN * 1000) / 1000, weight: s.weight }));
  return { thickness: w > 0 ? Math.round((sum / w) * 1e4) / 1e4 : chosen.bin * BIN, weight: w, candidates, sheetFaces, sheetPairs, none: false };
}
