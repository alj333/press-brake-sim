/**
 * Test fixtures: load the generated sample parts (samples/<name>/<name>.truth.json) as
 * FlatPattern + expected values, and compare flat patterns modulo rigid motion / reflection.
 * Node only (vitest). The UI loads the same files over HTTP from /samples/<name>/.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlatPattern, BendLine, Vec2 } from '../types';

export const SAMPLE_NAMES = [
  'L-bracket', 'U-channel', 'Z-bracket', 'hat-channel', 'acute-bracket', 'box-4-flange', 'tabbed-plate',
] as const;
export type SampleName = (typeof SAMPLE_NAMES)[number];

export interface BendGolden {
  bendAllowance: number; bendDeduction: number; includedAngle: number; actualInnerRadius: number;
  springback: number; overbendAngle: number; loadedIncludedAngle: number; ramDepthSharpShoulder: number;
  bendLength: number; forcePerMeter: number; force: number; minLegOutside: number;
}

export interface TruthExpected {
  bendCount: number;
  directions: Record<string, 'up' | 'down'>;
  bendAllowance: Record<string, number>;
  foldedBounds: { x: number; y: number; z: number };
  flatBounds: { w: number; h: number };
  frame: { u: string; v: string; w: string; handedness: string };
  holeCount: number;
  flangeCount: number;
  defaultSetup: { punch: string; die: string; dieV: number; dieAngle: number; shoulderRadius: number; punchTipRadius: number };
  perBend: Record<string, BendGolden>;
  tolerances: { length: number; angle: number; forcePercent: number; ramDepth: number };
  expectedFlips?: number;
  maxFlips?: number;
  needsAcuteTooling?: boolean;
  rootFlangeIsLongest?: boolean;
  shortBendLine?: boolean;
  holeNearGaugedEdge?: { u: number; v: number; r: number };
  wallLengths?: number[];
  [key: string]: unknown;
}

export interface Truth {
  name: string;
  thickness: number;
  kFactor: number;
  material: { id: string; Rm: number; k: number; sb: number; minR: number };
  flat: FlatPattern;
  expected: TruthExpected;
}

export const SAMPLES_DIR = join(process.cwd(), 'samples');

export function samplePath(name: SampleName, file: 'step' | 'stl' | 'dxf' | 'truth'): string {
  const base = join(SAMPLES_DIR, name, name);
  switch (file) {
    case 'step': return `${base}.step`;
    case 'stl': return `${base}.stl`;
    case 'dxf': return `${base}-flat.dxf`;
    case 'truth': return `${base}.truth.json`;
  }
}

/** Load a sample's truth file. The `flat` is a ready-to-use FlatPattern (holes already flattened). */
export function loadTruth(name: SampleName): Truth {
  const raw = JSON.parse(readFileSync(samplePath(name, 'truth'), 'utf8')) as Truth;
  // ensure every bend has the full sources object (older files)
  for (const b of raw.flat.bends) {
    const bl = b as BendLine;
    bl.sources ??= { geometry: 'dxf', angle: 'dxf', radius: 'dxf', direction: 'dxf' };
  }
  return raw;
}

export function readSampleBytes(name: SampleName, file: 'step' | 'stl'): Uint8Array {
  return new Uint8Array(readFileSync(samplePath(name, file)));
}

export function readSampleText(name: SampleName, file: 'dxf'): string {
  return readFileSync(samplePath(name, file), 'utf8');
}

// ─── Equivalence modulo rigid motion / reflection ───────────────────────────

function polyArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[i]!, r = p[(i + 1) % n]!;
    a += q.x * r.y - r.x * q.y;
  }
  return Math.abs(a) / 2;
}

function dist(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }

export interface FlatSignature {
  area: number;
  dims: [number, number];          // sorted bounding box dims
  bendLengths: number[];           // sorted
  angles: number[];                // sorted
  ups: number;                     // count of 'up' bends
  holeCount: number;
}

export function flatSignature(f: FlatPattern): FlatSignature {
  const xs = f.outline.map(p => p.x), ys = f.outline.map(p => p.y);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  return {
    area: polyArea(f.outline) - f.holes.reduce((s, hole) => s + polyArea(hole), 0),
    dims: [Math.min(w, h), Math.max(w, h)],
    bendLengths: f.bends.map(b => dist(b.p0, b.p1)).sort((a, b) => a - b),
    angles: f.bends.map(b => b.angle).sort((a, b) => a - b),
    ups: f.bends.filter(b => b.direction === 'up').length,
    holeCount: f.holes.length,
  };
}

/**
 * True when the two flats have the same signature: same outline area (within areaTol fraction),
 * same bounding dims, bend lengths and angles (within `tol` mm / `angleTol` deg), the same hole
 * count, and directions either all equal or all inverted (reflection).
 */
export function flatsEquivalent(
  a: FlatPattern, b: FlatPattern,
  opts: { tol?: number; angleTol?: number; areaTol?: number } = {},
): { equivalent: boolean; mirrored: boolean; reasons: string[] } {
  const tol = opts.tol ?? 0.5, angleTol = opts.angleTol ?? 0.5, areaTol = opts.areaTol ?? 0.01;
  const sa = flatSignature(a), sb = flatSignature(b);
  const reasons: string[] = [];
  if (Math.abs(sa.area - sb.area) > areaTol * Math.max(sa.area, sb.area)) reasons.push(`area ${sa.area.toFixed(1)} vs ${sb.area.toFixed(1)}`);
  if (Math.abs(sa.dims[0] - sb.dims[0]) > tol || Math.abs(sa.dims[1] - sb.dims[1]) > tol) reasons.push(`dims ${sa.dims} vs ${sb.dims}`);
  if (sa.bendLengths.length !== sb.bendLengths.length) reasons.push(`bend count ${sa.bendLengths.length} vs ${sb.bendLengths.length}`);
  else {
    sa.bendLengths.forEach((l, i) => { if (Math.abs(l - sb.bendLengths[i]!) > tol) reasons.push(`bend length ${l.toFixed(2)} vs ${sb.bendLengths[i]!.toFixed(2)}`); });
    sa.angles.forEach((v, i) => { if (Math.abs(v - sb.angles[i]!) > angleTol) reasons.push(`angle ${v} vs ${sb.angles[i]}`); });
  }
  if (sa.holeCount !== sb.holeCount) reasons.push(`holes ${sa.holeCount} vs ${sb.holeCount}`);
  const n = sa.bendLengths.length;
  const same = sa.ups === sb.ups, inverted = sa.ups === n - sb.ups;
  if (!same && !inverted) reasons.push(`directions ${sa.ups}/${n} up vs ${sb.ups}/${n}`);
  return { equivalent: reasons.length === 0, mirrored: !same && inverted, reasons };
}
