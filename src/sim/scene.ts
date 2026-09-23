/**
 * sim-3d — shared scene helpers (pure, no React/three): scene frame shape, idle frame, active
 * station lookup, collision kinds, colours. See docs/specs/sim-3d.md §4–5.
 */
import type {
  BendProgram, BendStep, CollisionReport, FingerSetting, FoldState, Machine, Mat4, ObstacleKind, PartModel, SimPhase, ToolLibrary,
  ToolSetup, ToolStation, Vec3,
} from '../core/types';
import { mat4, vec3 } from '../core/geom';
import { foldGeometry, finishedState, partBoundsFolded } from '../core/part';
import { machineLevels } from '../core/machine';
import type { SimFrame } from './interpolate';

export type SimLibrary = Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>;

/** What the scene components consume: an interpolated keyframe or the idle preview frame. */
export interface SceneFrame {
  ramY: number;
  foldState: FoldState;
  partTransform: Mat4;
  backgauge: FingerSetting[];
  collisions: CollisionReport[];
  /** −1 in the idle preview. */
  stepIndex: number;
  phase: SimPhase | null;
}

export const EMPTY_SETUP: ToolSetup = { machineId: '', stations: [] };

/** Transport bar speed choices (× real time). */
export const SIM_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
/** A bend zone mesh is regenerated when its fraction moved by more than this. */
export const ZONE_REFILL_DELTA = 0.002;
/** Visual gap between punch segments (mm). */
export const SEGMENT_GAP = 0.4;
/** Side-frame plate thickness (Z) and back-column depth (X), mm — visual only. */
export const FRAME_PLATE = 80;
export const FRAME_COLUMN = 300;

/** Scene colours (hex). */
export const SIM_COLORS = {
  sheet: '#c3c9d0',
  gauged: '#8fb5d9',
  collision: '#d63b3b',
  punch: '#59636f',
  die: '#59636f',
  clamp: '#5b6474',
  ram: '#6b7484',
  table: '#6d7683',
  holder: '#7a8390',
  frame: '#7d8694',
  beam: '#4a5c7a',
  finger: '#3b6fb6',
  grid: '#9aa3ad',
} as const;

export function sceneFrameOf(f: SimFrame): SceneFrame {
  return { ramY: f.ramY, foldState: f.foldState, partTransform: f.partTransform, backgauge: f.backgauge, collisions: f.collisions, stepIndex: f.stepIndex, phase: f.phase };
}

/** Tallest mounted die / punch heights (defaults 60 / 120) for the machine levels. */
export function toolStack(setup: ToolSetup, library: SimLibrary): { dieHeight: number; punchHeight: number } {
  let dieHeight = 0, punchHeight = 0;
  for (const st of setup.stations) {
    const die = library.dies.find(d => d.id === st.dieId);
    const punch = library.punches.find(p => p.id === st.punchId);
    if (die) dieHeight = Math.max(dieHeight, die.height);
    if (punch) punchHeight = Math.max(punchHeight, punch.height);
  }
  return { dieHeight: dieHeight || 60, punchHeight: punchHeight || 120 };
}

/** Rotation PART → MACHINE for the idle preview: u → +Z, v → +X, w → +Y (right-handed). */
const IDLE_ROTATION: Mat4 = [
  0, 0, 1, 0,   // column 0: image of x (u) = +Z
  1, 0, 0, 0,   // column 1: image of y (v) = +X
  0, 1, 0, 0,   // column 2: image of z (w) = +Y
  0, 0, 0, 1,
];

/**
 * Rotation PART → MACHINE of the idle preview: the part's +w (top face) maps to +Y and the
 * longest bend line runs along the bed (+Z); u → +Z when the part has no bends.
 */
export function idleRotation(part: PartModel): Mat4 {
  let best: { len: number; angleDeg: number } | null = null;
  for (const b of part.flat.bends) {
    const dx = b.p1.x - b.p0.x, dy = b.p1.y - b.p0.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-9 && (!best || len > best.len)) best = { len, angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI };
  }
  if (!best) return IDLE_ROTATION.slice();
  // rotate the bend direction onto +u about w, then map u → Z, v → X, w → Y
  return mat4.multiply(IDLE_ROTATION, mat4.fromAxisAngle({ x: 0, y: 0, z: 1 }, -best.angleDeg));
}

/**
 * Idle preview frame (no keyframes): the part fully folded lying on the die plane with its
 * longest bend line along the bed, X centred on the bend line, Z centred on the bed, lowest
 * point on the die plane; ram at TDC; no fingers.
 */
export function idleFrame(part: PartModel | null, machine: Machine, setup: ToolSetup, library: SimLibrary): SceneFrame {
  const { dieHeight, punchHeight } = toolStack(setup, library);
  const ramY = machineLevels(machine, dieHeight, punchHeight).tdcClampY;
  if (!part) {
    return { ramY, foldState: {}, partTransform: mat4.identity(), backgauge: [], collisions: [], stepIndex: -1, phase: null };
  }
  const foldState = finishedState(part);
  const folded = foldGeometry(part, foldState);
  const rotation = idleRotation(part);
  const b = partBoundsFolded(folded, part.flat.thickness, rotation);
  const centre: Vec3 = vec3.midpoint(b.min, b.max);
  const shift: Vec3 = { x: -centre.x, y: -b.min.y, z: machine.bedLength / 2 - centre.z };
  const partTransform = mat4.multiply(mat4.translation(shift), rotation);
  return { ramY, foldState, partTransform, backgauge: [], collisions: [], stepIndex: -1, phase: null };
}

/** The program step of a scene frame (undefined in the idle preview). */
export function stepOf(program: BendProgram | null, frame: SceneFrame): BendStep | undefined {
  if (!program || frame.stepIndex < 0) return undefined;
  return program.steps[frame.stepIndex];
}

/** The station used by a step (by id) in the setup. */
export function stationOf(setup: ToolSetup, step: BendStep | undefined): ToolStation | undefined {
  if (!step) return undefined;
  return setup.stations.find(s => s.id === step.stationId);
}

/** Z centre of a station (the bend line is centred there by the planner). */
export function stationCentreZ(station: ToolStation | undefined, machine: Machine): number {
  return station ? (station.zStart + station.zEnd) / 2 : machine.bedLength / 2;
}

/** Obstacle kinds involved in the frame's collisions. */
export function collisionKinds(collisions: readonly CollisionReport[]): Set<ObstacleKind> {
  const s = new Set<ObstacleKind>();
  for (const c of collisions) s.add(c.with);
  return s;
}

/** Punch piece Z range drawn for a station: the step's piece centred in the station, else the whole station. */
export function punchPieces(station: ToolStation, step: BendStep | undefined): Array<{ z0: number; z1: number }> {
  const zStart = Math.min(station.zStart, station.zEnd), zEnd = Math.max(station.zStart, station.zEnd);
  let segments: number[];
  let z = zStart;
  if (step && step.stationId === station.id && step.punchLength > 0) {
    segments = step.segments.length > 0 ? step.segments : [step.punchLength];
    const total = segments.reduce((a, b) => a + b, 0);
    z = (zStart + zEnd) / 2 - total / 2;
  } else {
    segments = station.segments.length > 0 ? station.segments : [zEnd - zStart];
  }
  const out: Array<{ z0: number; z1: number }> = [];
  for (const len of segments) {
    if (len > 0) out.push({ z0: z, z1: z + len });
    z += len;
  }
  return out;
}

/** Formats seconds as m:ss.s (rounded to tenths first, so 59.96 s is "1:00.0", never "0:60.0"). */
export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  const rest = tenths - m * 600;
  const sec = Math.floor(rest / 10), frac = rest % 10;
  return `${m}:${sec < 10 ? '0' : ''}${sec}.${frac}`;
}
