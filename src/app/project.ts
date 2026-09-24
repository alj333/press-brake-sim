/**
 * ui — project file (de)serialisation, the library overlay, and program exports (JSON / CSV).
 * See docs/specs/ui.md §2 / §4.
 */
import type {
  BendProgram, BendStep, Die, Finger, FlatPattern, Language, Machine, Material, Message, PartModel, PlannerOptions, Project, Punch,
  ToolLibrary, ToolSetup,
} from '../core/types';
import { buildPartModel } from '../core/part';
import { defaultPlannerOptions } from '../core/planner';
import { migrateDie, migrateFinger, migrateMachine, migrateMaterial, migratePunch } from '../core/library';
import { translate } from '../i18n';
import { fmt, kNToTonnes } from './format';

export const PROJECT_VERSION = 1;
export const APP_ID = 'press-brake-sim';

/** Typed failure with an i18n key (the UI renders `toMessage()`). */
export class AppError extends Error {
  readonly key: string;
  readonly params: Record<string, string | number> | undefined;
  constructor(key: string, params?: Record<string, string | number>, detail?: string) {
    super(detail ?? key);
    this.name = 'AppError';
    this.key = key;
    this.params = params;
  }
  toMessage(): Message {
    return { key: this.key, severity: 'error', ...(this.params ? { params: this.params } : {}) };
  }
}

export type LibraryOverlay = Project['libraryOverlay'];

export function emptyOverlay(): LibraryOverlay {
  return { punches: [], dies: [], fingers: [], materials: [], machines: [] };
}

/** Every library item the project references (setup tools, finger, machine, material) plus every custom item. */
export function buildOverlay(project: Pick<Project, 'setup' | 'machineId' | 'materialId'>, library: ToolLibrary): LibraryOverlay {
  const punchIds = new Set<string>(), dieIds = new Set<string>();
  for (const st of project.setup.stations) { punchIds.add(st.punchId); dieIds.add(st.dieId); }
  const machine = library.machines.find(m => m.id === project.machineId);
  const fingerIds = new Set<string>();
  if (machine) fingerIds.add(machine.backgauge.fingerId);
  const pick = <T extends { id: string; source?: string }>(items: T[], ids: Set<string>): T[] =>
    items.filter(x => ids.has(x.id) || x.id.startsWith('custom:'));
  return {
    punches: pick(library.punches, punchIds),
    dies: pick(library.dies, dieIds),
    fingers: pick(library.fingers, fingerIds),
    materials: library.materials.filter(m => m.id === project.materialId || m.id.startsWith('custom:')),
    machines: library.machines.filter(m => m.id === project.machineId || m.id.startsWith('custom:')),
  };
}

export interface ProjectFile extends Project {
  app: typeof APP_ID;
  savedAt: string;
}

export function serializeProject(project: Project, library: ToolLibrary, now: Date = new Date()): string {
  const file: ProjectFile = {
    ...project,
    version: PROJECT_VERSION,
    libraryOverlay: buildOverlay(project, library),
    app: APP_ID,
    savedAt: now.toISOString(),
  };
  return JSON.stringify(file, null, 2);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isVec2(v: unknown): v is { x: number; y: number } {
  return isObject(v) && typeof v.x === 'number' && typeof v.y === 'number' && Number.isFinite(v.x) && Number.isFinite(v.y);
}

function isPolygon(v: unknown): v is Array<{ x: number; y: number }> {
  return Array.isArray(v) && v.every(isVec2);
}

function validateFlat(v: unknown): FlatPattern {
  if (!isObject(v)) throw new AppError('errors.app.invalidProject', undefined, 'flat is not an object');
  if (!isPolygon(v.outline) || v.outline.length < 3) throw new AppError('errors.app.invalidProject', undefined, 'flat.outline');
  if (!Array.isArray(v.holes) || !v.holes.every(isPolygon)) throw new AppError('errors.app.invalidProject', undefined, 'flat.holes');
  if (!Array.isArray(v.bends)) throw new AppError('errors.app.invalidProject', undefined, 'flat.bends');
  if (typeof v.thickness !== 'number' || !(v.thickness > 0)) throw new AppError('errors.app.invalidProject', undefined, 'flat.thickness');
  const thickness = v.thickness;
  const bends = v.bends.map((b, i) => {
    if (!isObject(b) || !isVec2(b.p0) || !isVec2(b.p1)) throw new AppError('errors.app.invalidProject', undefined, `flat.bends[${i}]`);
    const sources = isObject(b.sources) ? b.sources : {};
    const src = (k: string): 'dxf' | 'step' | 'mesh' | 'user' | 'default' => {
      const s = sources[k];
      return s === 'dxf' || s === 'step' || s === 'mesh' || s === 'user' || s === 'default' ? s : 'user';
    };
    const angle = typeof b.angle === 'number' && b.angle > 0 && b.angle <= 180 ? b.angle : 90;
    const bend: FlatPattern['bends'][number] = {
      id: typeof b.id === 'string' && b.id ? b.id : `B${i + 1}`,
      p0: b.p0, p1: b.p1,
      direction: b.direction === 'down' ? 'down' : 'up',
      angle,
      innerRadius: typeof b.innerRadius === 'number' && b.innerRadius >= 0 ? b.innerRadius : thickness,
      kFactor: typeof b.kFactor === 'number' && b.kFactor > 0 && b.kFactor <= 1 ? b.kFactor : 0.44,
      sources: { geometry: src('geometry'), angle: src('angle'), radius: src('radius'), direction: src('direction') },
    };
    if (typeof b.angleCorrection === 'number' && Number.isFinite(b.angleCorrection)) bend.angleCorrection = b.angleCorrection;
    if (b.hem === 'closed' || b.hem === 'open' || b.hem === 'teardrop') bend.hem = b.hem;
    if (typeof b.hemGap === 'number' && Number.isFinite(b.hemGap)) bend.hemGap = b.hemGap;
    return bend;
  });
  const flat: FlatPattern = {
    id: typeof v.id === 'string' ? v.id : 'part',
    name: typeof v.name === 'string' ? v.name : 'part',
    thickness,
    materialId: typeof v.materialId === 'string' ? v.materialId : '',
    outline: v.outline,
    holes: v.holes,
    bends,
  };
  if (v.sourceUnits === 'mm' || v.sourceUnits === 'in') flat.sourceUnits = v.sourceUnits;
  if (isObject(v.provenance)) {
    const prov: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.provenance)) if (typeof val === 'string') prov[k] = val;
    flat.provenance = prov;
  }
  if (Array.isArray(v.warnings)) flat.warnings = v.warnings.filter((m): m is Message => isObject(m) && typeof m.key === 'string');
  return flat;
}

function validateSetup(v: unknown, machineId: string): ToolSetup {
  if (!isObject(v) || !Array.isArray(v.stations)) return { machineId, stations: [] };
  const stations = v.stations.flatMap((s, i) => {
    if (!isObject(s) || typeof s.punchId !== 'string' || typeof s.dieId !== 'string') return [];
    const zStart = typeof s.zStart === 'number' ? s.zStart : 0;
    const zEnd = typeof s.zEnd === 'number' ? s.zEnd : zStart;
    return [{
      id: typeof s.id === 'string' && s.id ? s.id : `S${i + 1}`,
      punchId: s.punchId, dieId: s.dieId, zStart, zEnd,
      segments: Array.isArray(s.segments) ? s.segments.filter((x): x is number => typeof x === 'number' && x > 0) : [],
      punchFlipped: s.punchFlipped === true, dieFlipped: s.dieFlipped === true,
    }];
  });
  return { machineId: typeof v.machineId === 'string' ? v.machineId : machineId, stations };
}

function validateOptions(v: unknown): PlannerOptions {
  const d = defaultPlannerOptions();
  if (!isObject(v)) return d;
  const num = (x: unknown, fallback: number, min = Number.MIN_VALUE): number => (typeof x === 'number' && Number.isFinite(x) && x >= min ? x : fallback);
  const w = isObject(v.weights) ? v.weights : {};
  const weight = (x: unknown, fallback: number): number => num(x, fallback, 0);   // a zero weight is a legitimate choice
  const opts: PlannerOptions = {
    sweepStepDeg: num(v.sweepStepDeg, d.sweepStepDeg),
    maxSequences: num(v.maxSequences, d.maxSequences, 1),
    weights: {
      flip: weight(w.flip, d.weights.flip), rotate: weight(w.rotate, d.weights.rotate), stationChange: weight(w.stationChange, d.weights.stationChange),
      shortFlange: weight(w.shortFlange, d.weights.shortFlange), collisionWarning: weight(w.collisionWarning, d.weights.collisionWarning),
    },
    minFlangeWarnFactor: num(v.minFlangeWarnFactor, d.minFlangeWarnFactor, 1),
  };
  if (Array.isArray(v.fixedOrder) && v.fixedOrder.length > 0 && v.fixedOrder.every(x => typeof x === 'string')) opts.fixedOrder = v.fixedOrder as string[];
  return opts;
}

const STEP_NUMBER_FIELDS = [
  'index', 'targetAngle', 'includedAngle', 'springback', 'overbendAngle', 'loadedIncludedAngle', 'actualInnerRadius', 'ramDepth', 'pinchY',
  'ramUpperLimit', 'force', 'forcePerMeter', 'loadPercentOfTool', 'bendLength', 'punchLength', 'partZOffset', 'gaugedFlangeOutside', 'bendDeduction',
] as const;
const STEP_STRING_FIELDS = ['bendId', 'stationId', 'punchId', 'dieId', 'punchName', 'dieName'] as const;

function isMat4(v: unknown): boolean {
  return Array.isArray(v) && v.length === 16 && v.every(x => typeof x === 'number' && Number.isFinite(x));
}

/** Shape check of a saved BendStep — the panels and the timeline read every one of these fields. */
function isBendStep(v: unknown, bendIds: Set<string>): v is BendStep {
  if (!isObject(v)) return false;
  if (!STEP_NUMBER_FIELDS.every(k => typeof v[k] === 'number' && Number.isFinite(v[k]))) return false;
  if (!STEP_STRING_FIELDS.every(k => typeof v[k] === 'string')) return false;
  if (!bendIds.has(v.bendId as string)) return false;
  if (v.kind !== 'bend' && v.kind !== 'hem-flatten') return false;
  if (v.dimensionRef !== 'virtual-sharp' && v.dimensionRef !== 'tangent') return false;
  if (typeof v.bottoming !== 'boolean') return false;
  if (!Array.isArray(v.segments) || !Array.isArray(v.backgauge) || !Array.isArray(v.collisions) || !Array.isArray(v.warnings)) return false;
  if (!v.backgauge.every(f => isObject(f) && typeof f.x === 'number' && typeof f.r === 'number' && typeof f.z === 'number')) return false;
  if (!v.collisions.every(c => isObject(c) && typeof c.with === 'string' && typeof c.atFraction === 'number' && isObject(c.message) && typeof c.message.key === 'string')) return false;
  if (!v.warnings.every(m => isObject(m) && typeof m.key === 'string')) return false;
  const placement = v.placement, orientation = v.orientation, manipulation = v.manipulation;
  if (!isObject(placement) || typeof placement.gaugedFlangeId !== 'string' || typeof placement.frontFlangeId !== 'string' || !isMat4(placement.transform)) return false;
  if (!isObject(orientation) || (orientation.faceUp !== 'top' && orientation.faceUp !== 'bottom') || typeof orientation.backFlangeId !== 'string') return false;
  if (!isObject(manipulation) || typeof manipulation.turn !== 'string' || typeof manipulation.stationChange !== 'boolean') return false;
  return true;
}

function validateProgram(v: unknown, part: PartModel): BendProgram | null {
  if (!isObject(v) || !Array.isArray(v.steps)) return null;
  const ids = new Set(part.flat.bends.map(b => b.id));
  if (!v.steps.every(s => isBendStep(s, ids))) return null;
  if (typeof v.maxForce !== 'number' || typeof v.feasible !== 'boolean' || typeof v.thickness !== 'number') return null;
  if (!Array.isArray(v.warnings) || !v.warnings.every(m => isObject(m) && typeof m.key === 'string')) return null;
  const stats = isObject(v.stats) && typeof v.stats.sequencesEvaluated === 'number' && typeof v.stats.timeMs === 'number'
    ? { sequencesEvaluated: v.stats.sequencesEvaluated, timeMs: v.stats.timeMs } : { sequencesEvaluated: 0, timeMs: 0 };
  return {
    partId: typeof v.partId === 'string' ? v.partId : part.flat.id,
    partName: typeof v.partName === 'string' ? v.partName : part.flat.name,
    machineId: typeof v.machineId === 'string' ? v.machineId : '',
    setup: validateSetup(v.setup, typeof v.machineId === 'string' ? v.machineId : ''),
    materialId: typeof v.materialId === 'string' ? v.materialId : part.flat.materialId,
    thickness: v.thickness,
    steps: v.steps as BendStep[],
    maxForce: v.maxForce,
    feasible: v.feasible,
    warnings: v.warnings as Message[],
    stats,
  };
}

function validateOverlay(v: unknown): LibraryOverlay {
  const out = emptyOverlay();
  if (!isObject(v)) return out;
  const msgs: Message[] = [];
  const list = (k: string): unknown[] => (Array.isArray(v[k]) ? (v[k] as unknown[]) : []);
  out.punches = list('punches').map((x, i) => migratePunch(x, i, msgs)).filter((x): x is Punch => x !== null);
  out.dies = list('dies').map((x, i) => migrateDie(x, i, msgs)).filter((x): x is Die => x !== null);
  out.fingers = list('fingers').map((x, i) => migrateFinger(x, i, msgs)).filter((x): x is Finger => x !== null);
  out.materials = list('materials').map((x, i) => migrateMaterial(x, i, msgs)).filter((x): x is Material => x !== null);
  out.machines = list('machines').map((x, i) => migrateMachine(x, i, msgs)).filter((x): x is Machine => x !== null);
  return out;
}

/**
 * Parse a project file: validates the shape, rebuilds the PartModel from its flat pattern (the
 * flat is the source of truth), keeps the saved program when every step has the shape the
 * panels and the timeline read (the caller rebuilds the timeline). Non-fatal findings (a
 * dropped program) are pushed to `messages` when given.
 */
export function parseProject(json: string, fallback: { machineId: string; materialId: string }, messages?: Message[]): Project {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new AppError('errors.app.invalidProject', undefined, 'not JSON'); }
  if (!isObject(raw)) throw new AppError('errors.app.invalidProject', undefined, 'not an object');
  if (raw.app !== undefined && raw.app !== APP_ID) throw new AppError('errors.app.invalidProject', undefined, 'wrong app id');
  if (typeof raw.version === 'number' && raw.version > PROJECT_VERSION) throw new AppError('errors.app.projectVersion', { version: raw.version });
  if (!('part' in raw) && !('setup' in raw)) throw new AppError('errors.app.invalidProject', undefined, 'no part/setup');
  let part: PartModel | null = null;
  if (isObject(raw.part) && raw.part.flat !== undefined) part = buildPartModel(validateFlat(raw.part.flat));
  else if (isObject(raw.part) && Array.isArray(raw.part.outline)) part = buildPartModel(validateFlat(raw.part));
  const machineId = typeof raw.machineId === 'string' ? raw.machineId : fallback.machineId;
  const materialId = typeof raw.materialId === 'string' ? raw.materialId : (part?.flat.materialId || fallback.materialId);
  const language: Language = raw.language === 'th' ? 'th' : 'en';
  let program: BendProgram | null = null;
  if (raw.program !== null && raw.program !== undefined) {
    program = part ? validateProgram(raw.program, part) : null;
    if (!program) messages?.push({ key: 'app.notice.programDropped', severity: 'warning' });
  }
  return {
    version: PROJECT_VERSION,
    name: typeof raw.name === 'string' ? raw.name : '',
    part,
    setup: validateSetup(raw.setup, machineId),
    machineId,
    materialId,
    plannerOptions: validateOptions(raw.plannerOptions),
    program,
    language,
    libraryOverlay: validateOverlay(raw.libraryOverlay),
  };
}

// ── program exports ───────────────────────────────────────────────────────

export interface ProgramContext {
  program: BendProgram;
  part: PartModel | null;
  machine: Machine;
  material: Material | undefined;
  library: Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>;
}

export function programToJson(ctx: ProgramContext, now: Date = new Date()): string {
  const { program, machine, material } = ctx;
  return JSON.stringify({
    app: APP_ID,
    exportedAt: now.toISOString(),
    part: { id: program.partId, name: program.partName, thickness: program.thickness, materialId: program.materialId, materialName: material?.name ?? null },
    machine: { id: machine.id, name: machine.name, capacity: machine.capacity, bedLength: machine.bedLength },
    setup: program.setup,
    feasible: program.feasible,
    maxForce: program.maxForce,
    maxForceTonnes: kNToTonnes(program.maxForce),
    warnings: program.warnings,
    stats: program.stats,
    steps: program.steps,
  }, null, 2);
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS: Array<[string, (s: BendStep, lang: Language) => string | number]> = [
  ['program.col.step', s => s.index + 1],
  ['program.col.bend', s => s.bendId],
  ['program.col.kind', (s, lang) => translate(lang, `sequence.kind.${s.kind}`)],
  ['program.col.station', s => s.stationId],
  ['common.punch', s => s.punchName],
  ['common.die', s => s.dieName],
  ['program.col.segments', s => `${fmt(s.punchLength, 1)} (${s.segments.join('+')})`],
  ['program.col.includedAngle', s => fmt(s.includedAngle, 2)],
  ['program.col.loadedAngle', s => fmt(s.loadedIncludedAngle, 2)],
  ['program.col.springback', s => fmt(s.springback, 2)],
  ['program.col.actualRadius', s => fmt(s.actualInnerRadius, 2)],
  ['program.col.outside', s => fmt(s.gaugedFlangeOutside, 2)],
  ['program.col.ref', (s, lang) => translate(lang, `ref.${s.dimensionRef}`)],
  ['program.col.deduction', s => fmt(s.bendDeduction, 2)],
  ['sequence.gaugeContact', (s, lang) => translate(lang, `contact.${s.gaugeContact}`)],
  ['program.col.backgauge', s => s.backgauge.map((f, i) => `F${i + 1}: X ${fmt(f.x, 2)} R ${fmt(f.r, 2)} Z ${fmt(f.z, 1)}`).join(' | ')],
  ['program.col.partZOffset', s => fmt(s.partZOffset, 1)],
  ['program.col.ramDepth', s => fmt(s.ramDepth, 2)],
  ['sequence.force', s => fmt(s.force, 1)],
  ['common.tonnes', s => fmt(kNToTonnes(s.force), 2)],
  ['program.col.ofTool', s => fmt(s.loadPercentOfTool, 0)],
  ['program.col.turn', (s, lang) => translate(lang, `turn.${s.manipulation.turn}`)],
  ['program.col.orientation', (s, lang) => `${translate(lang, `faceUp.${s.orientation.faceUp}`)} / ${s.orientation.backFlangeId}`],
  ['sequence.bottoming', (s, lang) => (s.bottoming ? translate(lang, 'common.yes') : translate(lang, 'common.no'))],
  ['program.col.notes', (s, lang) => [...s.warnings.map(w => translate(lang, w.key, w.params)), ...s.collisions.map(c => translate(lang, c.message.key, c.message.params))].join(' | ')],
];

/** Bilingual (EN / TH) header, one row per step, UTF-8 BOM so spreadsheets open Thai correctly. */
export function programToCsv(ctx: ProgramContext, lang: Language = 'en'): string {
  const header = CSV_COLUMNS.map(([key]) => csvCell(`${translate('en', key)} / ${translate('th', key)}`)).join(',');
  const rows = ctx.program.steps.map(s => CSV_COLUMNS.map(([, f]) => csvCell(f(s, lang))).join(','));
  const meta = [
    `${csvCell(translate('en', 'program.header.part') + ' / ' + translate('th', 'program.header.part'))},${csvCell(ctx.program.partName)}`,
    `${csvCell(translate('en', 'program.header.machine') + ' / ' + translate('th', 'program.header.machine'))},${csvCell(ctx.machine.name)}`,
    `${csvCell(translate('en', 'program.header.material') + ' / ' + translate('th', 'program.header.material'))},${csvCell(ctx.material?.name ?? ctx.program.materialId)}`,
    `${csvCell(translate('en', 'program.header.thickness') + ' / ' + translate('th', 'program.header.thickness'))},${csvCell(ctx.program.thickness)}`,
    `${csvCell(translate('en', 'program.footer.maxForce') + ' / ' + translate('th', 'program.footer.maxForce'))},${csvCell(fmt(ctx.program.maxForce, 1))} kN,${csvCell(fmt(kNToTonnes(ctx.program.maxForce), 2))} t`,
    '',
  ];
  return '﻿' + [...meta, header, ...rows].join('\r\n') + '\r\n';
}

/** Trigger a browser download of a text file (no-op outside a DOM). */
export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Safe file name from a project / part name. */
export function safeFileName(name: string, fallback = 'project'): string {
  const s = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '-');
  return s.length ? s : fallback;
}
