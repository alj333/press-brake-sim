/**
 * Planner context: resolved input (bendable bends, stations, finger), options and the
 * fold-geometry cache shared by every planner stage. See docs/specs/planner.md.
 */
import type {
  BendLine, Die, Finger, FlangeLink, FoldState, FoldedGeometry, Machine, Material, PartModel, Message, PlannerOptions,
  Punch, ToolLibrary, ToolSetup, ToolStation,
} from '../types';
import { vec2 } from '../geom';
import { foldGeometry, STRAIGHT_ANGLE } from '../part';
import { flatFinger } from '../tools';

export type PlannerLibrary = Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>;

export interface PlannerInput {
  part: PartModel;
  material: Material;
  machine: Machine;
  setup: ToolSetup;
  library: PlannerLibrary;
  options?: Partial<PlannerOptions>;
}

export interface PlannerProgress {
  phase: 'evaluate' | 'search' | 'assemble';
  done: number;
  total: number;
  sequencesEvaluated: number;
}

/** Hem pre-bend target angle from flat (deg). */
export const HEM_PREBEND = 150;
/** Bends are tracked in a 32-bit "done mask": more than this many tree links cannot be planned. */
export const MAX_BENDS = 31;

export function defaultPlannerOptions(): PlannerOptions {
  return {
    sweepStepDeg: 5,
    maxSequences: 20000,
    weights: { flip: 10, rotate: 4, stationChange: 6, shortFlange: 3, collisionWarning: 5 },
    minFlangeWarnFactor: 1.15,
  };
}

/** A bendable bend (= a tree link). */
export interface BendInfo {
  index: number;
  id: string;
  bend: BendLine;
  link: FlangeLink;
  /** Bend line length (mm). */
  length: number;
  /** Depth of the child flange in the flange tree (root children = 1). */
  depth: number;
  /** angle = 180: expanded into a pre-bend + hem-flatten. */
  isHem: boolean;
  /** Angle from flat actually air-bent in the search (the pre-bend angle for hems). */
  formAngle: number;
}

export interface StationInfo {
  index: number;
  station: ToolStation;
  punch: Punch;
  die: Die;
  zStart: number;
  zEnd: number;
  length: number;
  /** die.family 'hemming' or a flat-faced punch: only usable for hem-flatten steps. */
  isHemming: boolean;
}

export interface PlanContext {
  part: PartModel;
  material: Material;
  machine: Machine;
  setup: ToolSetup;
  library: PlannerLibrary;
  options: PlannerOptions;
  t: number;
  bends: BendInfo[];
  stations: StationInfo[];
  finger: Finger;
  /** Setup / library problems found while resolving (reported on the program). */
  warnings: Message[];
  folded: (state: FoldState) => FoldedGeometry;
  /** Fold state with the bends of `doneMask` at 1 and, optionally, one bend at `fraction`. */
  foldStateFor: (doneMask: number, bendIndex?: number, fraction?: number) => FoldState;
  /** Fraction of the bend's FULL angle that the air-bend step reaches (1, or the hem pre-bend fraction). */
  formFraction: (bendIndex: number) => number;
  /** Abort signal polling (throws AbortError). */
  checkAbort: () => void;
  /** Sweep step multiplier used while searching (2 for parts with more than 7 bends); the final program always sweeps at sweepStepDeg. */
  searchSweepFactor: number;
}

const FOLD_CACHE_LIMIT = 1500;

function flangeDepths(part: PartModel): Map<string, number> {
  const depth = new Map<string, number>([[part.rootFlangeId, 0]]);
  let progress = true;
  while (progress) {
    progress = false;
    for (const l of part.links) {
      const dp = depth.get(l.parentFlangeId);
      if (dp !== undefined && !depth.has(l.childFlangeId)) { depth.set(l.childFlangeId, dp + 1); progress = true; }
    }
  }
  return depth;
}

export function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('The planner was aborted', 'AbortError');
  const e = new Error('The planner was aborted');
  e.name = 'AbortError';
  return e;
}

export function createContext(input: PlannerInput, signal?: AbortSignal): PlanContext {
  const { part, material, machine, setup, library } = input;
  const options: PlannerOptions = { ...defaultPlannerOptions(), ...(input.options ?? {}) };
  if (input.options?.weights) options.weights = { ...defaultPlannerOptions().weights, ...input.options.weights };
  const warnings: Message[] = [];
  const bendById = new Map(part.flat.bends.map(b => [b.id, b]));
  const depths = flangeDepths(part);

  const bends: BendInfo[] = [];
  for (const link of part.links) {
    const bend = bendById.get(link.bendId);
    if (!bend) continue;
    // a "bend" below the fold model's straight-zone threshold has no arc to form (bendPose would reject it)
    if (!(bend.angle >= STRAIGHT_ANGLE) || !Number.isFinite(vec2.dist(bend.p0, bend.p1))) continue;
    const isHem = bend.angle >= 180 - 1e-9;
    bends.push({
      index: bends.length, id: bend.id, bend, link,
      length: vec2.dist(bend.p0, bend.p1),
      depth: depths.get(link.childFlangeId) ?? 1,
      isHem,
      formAngle: isHem ? HEM_PREBEND : bend.angle,
    });
  }
  for (const b of part.flat.bends) {
    if (!bends.some(x => x.id === b.id)) warnings.push({ key: 'warnings.planner.bendSkipped', severity: 'warning', params: { bendId: b.id } });
  }
  if (bends.length > MAX_BENDS) throw new RangeError(`planner: ${bends.length} bends exceed the supported maximum of ${MAX_BENDS}`);

  const stations: StationInfo[] = [];
  for (const st of setup.stations) {
    const punch = library.punches.find(p => p.id === st.punchId);
    const die = library.dies.find(d => d.id === st.dieId);
    if (!punch || !die) continue;
    const zStart = Math.min(st.zStart, st.zEnd), zEnd = Math.max(st.zStart, st.zEnd);
    stations.push({
      index: stations.length, station: st, punch, die, zStart, zEnd, length: zEnd - zStart,
      isHemming: die.family === 'hemming' || punch.tipAngle >= 180 || !(die.vWidth > 0),
    });
  }

  // an unknown finger id falls back to the standard flat finger (validateSetup reports it on the program)
  const finger = library.fingers.find(f => f.id === machine.backgauge.fingerId) ?? flatFinger();
  if (!library.fingers.some(f => f.id === machine.backgauge.fingerId)) {
    warnings.push({ key: 'warnings.setup.unknownFinger', severity: 'error', params: { fingerId: machine.backgauge.fingerId } });
  }

  const cache = new Map<string, FoldedGeometry>();
  const folded = (state: FoldState): FoldedGeometry => {
    const key = bends.map(b => `${b.id}=${state[b.id] ?? 0}`).join(';');
    let g = cache.get(key);
    if (!g) {
      if (cache.size >= FOLD_CACHE_LIMIT) cache.clear();
      g = foldGeometry(part, state);
      cache.set(key, g);
    }
    return g;
  };
  const foldStateFor = (doneMask: number, bendIndex?: number, fraction?: number): FoldState => {
    const s: FoldState = {};
    for (const b of bends) s[b.id] = (doneMask >> b.index) & 1 ? 1 : 0;
    if (bendIndex !== undefined && fraction !== undefined) s[bends[bendIndex]!.id] = fraction;
    return s;
  };
  const formFraction = (bendIndex: number): number => {
    const b = bends[bendIndex]!;
    return b.isHem ? b.formAngle / b.bend.angle : 1;
  };
  const checkAbort = (): void => { if (signal?.aborted) throw abortError(); };

  return {
    part, material, machine, setup, library, options, t: part.flat.thickness,
    bends, stations, finger, warnings, folded, foldStateFor, formFraction, checkAbort,
    searchSweepFactor: bends.length > 7 ? 2 : 1,
  };
}
