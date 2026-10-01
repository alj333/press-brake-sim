/**
 * Default tool setup for a sheet thickness: the stocked MotionX punch and a stocked MotionX die
 * groove closest to recommendedV(t), on one centred station composed from the bounded physical
 * punch inventory. Generic stocked tools remain the fallback. See docs/specs/tooling-machine.md §1.7.
 */
import type { Die, Machine, Punch, ToolLibrary, ToolSetup } from '../types';
import { recommendedV } from '../bend';
import { MOTIONX_DEFAULT_DIE_ID, MOTIONX_DIE_PHYSICAL_ID } from './factory';
import { DEFAULT_PUNCH_ID } from './standard';
import { availableSegmentLengths, hasBoundedSegmentInventory, isToolInStock } from './stock';

/**
 * Greedy sectionalisation (largest first, repeats allowed) of `length` from `available`
 * lengths. The remainder below the smallest available piece is dropped, so the sum can fall
 * short by up to that piece; with the standard set every multiple of 5 ≥ 10 is exact.
 */
export function segmentsForLength(length: number, available: readonly number[], reusable = true): number[] {
  if (!reusable) {
    const limit = Math.floor(length * 2 + 1e-4);
    if (limit <= 0) return [];
    const sizes = available.map(piece => Math.round(piece * 2)).filter(piece => piece > 0 && piece <= limit);
    const from = new Int32Array(limit + 1).fill(-1);
    const used = new Int32Array(limit + 1).fill(-1);
    from[0] = 0;
    for (let index = 0; index < sizes.length; index++) {
      const piece = sizes[index]!;
      for (let total = limit; total >= piece; total--) {
        if (from[total]! < 0 && from[total - piece]! >= 0) {
          from[total] = total - piece;
          used[total] = index;
        }
      }
    }
    let best = limit;
    while (best > 0 && from[best]! < 0) best--;
    const out: number[] = [];
    for (let total = best; total > 0;) {
      const index = used[total]!;
      if (index < 0) break;
      out.push(sizes[index]! / 2);
      total = from[total]!;
    }
    return out.sort((a, b) => b - a);
  }
  const sizes = [...new Set(available.filter(l => l > 0))].sort((a, b) => b - a);
  const out: number[] = [];
  let rest = length;
  for (const s of sizes) {
    while (rest >= s - 1e-9) { out.push(s); rest -= s; }
  }
  // try to fix a small remainder by swapping the last piece for two smaller ones (e.g. 25 = 15 + 10)
  if (rest > 1e-9 && out.length > 0) {
    const last = out[out.length - 1]!;
    const target = last + rest;
    for (const a of sizes) {
      const b = target - a;
      if (b > 1e-9 && sizes.some(s => Math.abs(s - b) < 1e-9)) { out[out.length - 1] = a; out.push(b); rest = 0; break; }
    }
  }
  return out.sort((a, b) => b - a);
}

/**
 * The V die (given angle) whose opening is closest to recommendedV(thickness); ties go to the
 * larger V. `vAngle = null` accepts any angle (fallback when no die has the wanted angle).
 */
export function pickDieForThickness(dies: readonly Die[], thickness: number, vAngle: number | null = 88): Die | undefined {
  const target = recommendedV(thickness);
  let best: Die | undefined;
  let bestErr = Infinity;
  for (const d of dies) {
    if (!isToolInStock(d) || (d.family !== 'v' && d.family !== 'multi-v') || !(d.vWidth > 0) || !(d.vAngle < 180)) continue;
    if (vAngle !== null && Math.abs(d.vAngle - vAngle) > 1e-9) continue;
    const err = Math.abs(d.vWidth - target);
    if (err < bestErr - 1e-9 || (Math.abs(err - bestErr) <= 1e-9 && best && d.vWidth > best.vWidth)) { best = d; bestErr = err; }
  }
  return best;
}

export interface DefaultSetupOptions {
  punchId?: string;
  dieId?: string;
  /** Station Z range; default the whole bed. */
  zStart?: number;
  zEnd?: number;
  stationId?: string;
}

/**
 * One station with the stocked MotionX punch and recommended in-stock die groove for the thickness.
 * Generic stocked punches and V dies remain fallbacks when the factory tooling is absent.
 * When the punch pieces cannot compose the station length exactly (a bed that is not a multiple
 * of 5 mm, e.g. 48 in = 1219.2 mm) the station is shortened to the composed length so that the
 * setup always passes validateSetup. Returns null when no suitable tools exist in the library.
 */
export function defaultToolSetup(library: Pick<ToolLibrary, 'punches' | 'dies'>, machine: Machine, thickness: number, opts: DefaultSetupOptions = {}): ToolSetup | null {
  const punch: Punch | undefined = opts.punchId
    ? library.punches.find(p => p.id === opts.punchId)
    : (library.punches.find(p => p.id === DEFAULT_PUNCH_ID && isToolInStock(p))
      ?? library.punches.find(p => isToolInStock(p) && p.family === 'straight' && p.tipAngle < 180)
      ?? library.punches.find(p => isToolInStock(p) && p.tipAngle < 180));
  const factoryDies = library.dies.filter(die => die.physicalToolId === MOTIONX_DIE_PHYSICAL_ID);
  const die: Die | undefined = opts.dieId
    ? library.dies.find(d => d.id === opts.dieId)
    : (pickDieForThickness(factoryDies, thickness, null)
      ?? library.dies.find(d => d.id === MOTIONX_DEFAULT_DIE_ID && isToolInStock(d))
      ?? pickDieForThickness(library.dies, thickness, 88)
      ?? pickDieForThickness(library.dies, thickness, null));
  if (!punch || !die) return null;
  const bounded = hasBoundedSegmentInventory(punch);
  const pieces = availableSegmentLengths(punch).filter(length => length <= 835 || bounded);
  if (bounded && pieces.length === 0) return null;
  const defaultLength = bounded
    ? segmentsForLength(machine.bedLength, pieces, false).reduce((total, piece) => total + piece, 0)
    : machine.bedLength;
  const centredStart = (machine.bedLength - defaultLength) / 2;
  const zStart = Math.max(0, opts.zStart ?? (bounded ? centredStart : 0));
  let zEnd = Math.min(machine.bedLength, opts.zEnd ?? machine.bedLength);
  if (bounded && opts.zStart === undefined && opts.zEnd === undefined) zEnd = zStart + defaultLength;
  if (!(zEnd > zStart)) return null;
  // sectionalise from the pieces (≤ 835) rather than a full bar, so the planner can pick short punch lengths
  const legacyPieces = pieces.length > 0 ? pieces : availableSegmentLengths(punch);
  let segments = legacyPieces.length > 0 ? segmentsForLength(zEnd - zStart, legacyPieces, !bounded) : [];
  const sum = segments.reduce((a, b) => a + b, 0);
  if (!bounded && segments.length > 0 && Math.abs(sum - (zEnd - zStart)) > 0.5) {
    if (sum > 0) zEnd = zStart + sum; else segments = [];
  }
  return {
    machineId: machine.id,
    stations: [{ id: opts.stationId ?? 'S1', punchId: punch.id, dieId: die.id, zStart, zEnd, segments, punchFlipped: false, dieFlipped: false }],
  };
}
