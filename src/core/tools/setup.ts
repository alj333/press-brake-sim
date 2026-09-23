/**
 * Default tool setup for a sheet thickness: the straight 88° R0.8 punch and the 88° V die
 * closest to recommendedV(t), on one station spanning the bed, sectionalised from the standard
 * segment set. See docs/specs/tooling-machine.md §1.7.
 */
import type { Die, Machine, Punch, ToolLibrary, ToolSetup } from '../types';
import { recommendedV } from '../bend';
import { STANDARD_PUNCH_ID } from './standard';

/**
 * Greedy sectionalisation (largest first, repeats allowed) of `length` from `available`
 * lengths. The remainder below the smallest available piece is dropped, so the sum can fall
 * short by up to that piece; with the standard set every multiple of 5 ≥ 10 is exact.
 */
export function segmentsForLength(length: number, available: readonly number[]): number[] {
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
    if (d.family !== 'v' || !(d.vWidth > 0) || !(d.vAngle < 180)) continue;
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
 * One station over the whole bed with the standard straight punch and the recommended V die
 * for the thickness (e.g. t = 2 → V16, t = 1.5 → V12, matching the samples' expected.defaultSetup).
 * When the punch pieces cannot compose the station length exactly (a bed that is not a multiple
 * of 5 mm, e.g. 48 in = 1219.2 mm) the station is shortened to the composed length so that the
 * setup always passes validateSetup. Returns null when no suitable tools exist in the library.
 */
export function defaultToolSetup(library: Pick<ToolLibrary, 'punches' | 'dies'>, machine: Machine, thickness: number, opts: DefaultSetupOptions = {}): ToolSetup | null {
  const punch: Punch | undefined = opts.punchId
    ? library.punches.find(p => p.id === opts.punchId)
    : (library.punches.find(p => p.id === STANDARD_PUNCH_ID) ?? library.punches.find(p => p.family === 'straight' && p.tipAngle < 180) ?? library.punches.find(p => p.tipAngle < 180));
  const die: Die | undefined = opts.dieId
    ? library.dies.find(d => d.id === opts.dieId)
    : (pickDieForThickness(library.dies, thickness, 88) ?? pickDieForThickness(library.dies, thickness, null));
  if (!punch || !die) return null;
  const zStart = Math.max(0, opts.zStart ?? 0);
  let zEnd = Math.min(machine.bedLength, opts.zEnd ?? machine.bedLength);
  if (!(zEnd > zStart)) return null;
  // sectionalise from the pieces (≤ 835) rather than a full bar, so the planner can pick short punch lengths
  const pieces = punch.segmentLengths.filter(l => l > 0 && l <= 835);
  const available = pieces.length > 0 ? pieces : punch.segmentLengths.filter(l => l > 0);
  let segments = available.length > 0 ? segmentsForLength(zEnd - zStart, available) : [];
  const sum = segments.reduce((a, b) => a + b, 0);
  if (segments.length > 0 && Math.abs(sum - (zEnd - zStart)) > 0.5) {
    if (sum > 0) zEnd = zStart + sum; else segments = [];
  }
  return {
    machineId: machine.id,
    stations: [{ id: opts.stationId ?? 'S1', punchId: punch.id, dieId: die.id, zStart, zEnd, segments, punchFlipped: false, dieFlipped: false }],
  };
}
