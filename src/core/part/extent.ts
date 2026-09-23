/** flangeExtentFromBend — flat distances of a flange from a bend line along the bend normal. */
import type { PartModel } from '../types';
import { centroid } from '../geom';
import { bendFrame, coordD, regionsSideOfBend } from './frame';

/**
 * Signed flat distances of the flange's region vertices from the bend line along the bend
 * normal, positive toward that flange (its adjacency side; centroid side when not adjacent).
 * E.g. the L-bracket child: { min: BA/2, max: 38.26 }.
 */
export function flangeExtentFromBend(part: PartModel, flangeId: string, bendId: string): { min: number; max: number } {
  const flange = part.flanges.find(f => f.id === flangeId);
  const bend = part.flat.bends.find(b => b.id === bendId);
  if (!flange) throw new Error(`flangeExtentFromBend: unknown flange ${flangeId}`);
  if (!bend) throw new Error(`flangeExtentFromBend: unknown bend ${bendId}`);
  const frame = bendFrame(bend, part.bendAllowance[bendId] ?? 0);
  const polys = flange.regions.map(r => r.polygon);
  let side = regionsSideOfBend(polys, frame);
  if (side === 0) {
    const c = centroid(polys[0] ?? [bend.p0]);
    side = coordD(frame, c) >= 0 ? 1 : -1;
  }
  let min = Infinity, max = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      const d = side * coordD(frame, p);
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}
