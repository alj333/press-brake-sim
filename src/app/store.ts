/**
 * ui — the project store (zustand): wires import → recognise → part model → tool setup →
 * planner → timeline → sim store, holds the Project, mirrors the LibraryStore and the UI
 * selection. See docs/specs/ui.md §2. No DOM access except File reading, fetch and Worker
 * (all guarded), so the store is unit-tested under jsdom.
 */
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type {
  BendDirection, BendLine, BendProgram, BendStep, CollisionReport, FlatPattern, Language, Machine, Material, Message, PartModel,
  PlannerOptions, Project, RecognizedSheet, ToolLibrary, ToolSetup, ToolStation, TriangleMesh, Vec2,
} from '../core/types';
import { ImportError, defaultInnerRadius, importFile, splitFileName } from '../core/import';
import type { DxfUnits, MeshUnits } from '../core/import';
import { matchToDxf, recognizeSheet } from '../core/import/recognize';
import { buildPartModel } from '../core/part';
import { STANDARD_MATERIAL_ID, buildStandardLibrary, defaultToolSetup, newCustomId, segmentsForLength } from '../core/tools';
import { defaultMachine, validateMachine, validateSetup } from '../core/machine';
import { LibraryStore, findMachine, findMaterial } from '../core/library';
import type { LibraryItem } from '../core/library';
import { buildTimeline, defaultPlannerOptions, planProgram } from '../core/planner';
import type { PlannerInput, PlannerProgress } from '../core/planner';
// pure pieces of the sim module (the barrel also pulls in the R3F components)
import { useSimStore } from '../sim/store';
import { phaseSegments } from '../sim/interpolate';
import { isLanguage, setGlobalLanguage, t as tGlobal } from '../i18n';
import { AppError, PROJECT_VERSION, emptyOverlay, parseProject, serializeProject } from './project';
import { clamp, round } from './format';

export type LeftTab = 'part' | 'tools' | 'machine';
export type RightTab = 'sequence' | 'program';
export type SimLibrary = Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>;

export interface Notice {
  id: number;
  message: Message;
  severity: 'info' | 'warning' | 'error';
}

export interface ImportInput { name: string; bytes: Uint8Array }

export type BendPatch = Partial<Pick<BendLine, 'direction' | 'angle' | 'innerRadius' | 'kFactor' | 'angleCorrection' | 'hem' | 'hemGap' | 'p0' | 'p1'>>;

export type StationPatch = Partial<Omit<ToolStation, 'id'>>;

/** Deep partial of a Machine (nested groups may be partial). */
export interface MachinePatch {
  name?: string; bedLength?: number; capacity?: number; stroke?: number; daylight?: number; throatDepth?: number;
  distanceBetweenFrames?: number; yCorrection?: number;
  ram?: Partial<Omit<Machine['ram'], 'speeds'>> & { speeds?: Partial<Machine['ram']['speeds']> };
  table?: Partial<Machine['table']>;
  backgauge?: Partial<Machine['backgauge']>;
}

export interface ProjectState {
  project: Project;
  library: ToolLibrary;
  simLibrary: SimLibrary;
  thickness: number;
  dxfFlat: FlatPattern | null;
  recognized: RecognizedSheet | null;
  mesh: TriangleMesh | null;
  matchInfo: { pairs: number; count: number; mirrored: boolean } | null;
  importWarnings: Message[];
  importing: boolean;
  planning: boolean;
  planProgress: PlannerProgress | null;
  planError: Message | null;
  /** The program no longer matches the setup / machine (re-plan suggested). */
  programStale: boolean;
  fixedOrder: string[] | null;
  selectedBendId: string | null;
  selectedStepIndex: number | null;
  dxfUnits: 'auto' | DxfUnits;
  meshUnits: MeshUnits;
  notices: Notice[];
  activeLeftTab: LeftTab;
  activeRightTab: RightTab;
}

export interface ProjectActions {
  importFiles(files: File[]): Promise<void>;
  importInputs(inputs: ImportInput[], opts?: { fresh?: boolean }): Promise<void>;
  loadSample(name: string): Promise<void>;
  loadFlat(flat: FlatPattern): void;
  setPartName(name: string): void;
  setBend(id: string, patch: BendPatch): void;
  addBend(p0: Vec2, p1: Vec2, direction?: BendDirection): string | null;
  removeBend(id: string): void;
  setMaterial(id: string): void;
  setThickness(t: number): void;
  setSetup(setup: ToolSetup): void;
  addStation(): void;
  updateStation(id: string, patch: StationPatch): void;
  /** Recompute a station's segments from its punch's segment lengths. */
  autoSegments(id: string): void;
  removeStation(id: string): void;
  resetSetup(): void;
  setMachine(id: string): void;
  updateMachine(patch: MachinePatch): void;
  saveMachineAs(name: string): string;
  plan(): Promise<void>;
  cancelPlan(): void;
  setFixedOrder(ids: string[] | null): void;
  setPlannerOptions(patch: Partial<PlannerOptions>): void;
  saveProject(): string;
  loadProject(json: string): void;
  newProject(): void;
  setProjectName(name: string): void;
  setLanguage(lang: Language): void;
  selectBend(id: string | null): void;
  selectStep(index: number | null): void;
  seekToCollision(step: BendStep, report: CollisionReport): void;
  setLeftTab(tab: LeftTab): void;
  setRightTab(tab: RightTab): void;
  setDxfUnits(units: 'auto' | DxfUnits): void;
  setMeshUnits(units: MeshUnits): void;
  notify(message: Message, severity?: Notice['severity']): void;
  dismissNotice(id: number): void;
  upsertLibraryItem(item: LibraryItem): void;
  removeLibraryItem(id: string): boolean;
  saveLibrary(): Promise<void>;
  loadLibrary(): Promise<void>;
  exportLibraryJson(): string;
  importLibraryJson(json: string, mode?: 'merge' | 'replace'): Message[];
  resetStandardItems(): void;
}

export type ProjectStore = ProjectState & ProjectActions;

export interface CreateStoreOptions {
  libraryStore?: LibraryStore;
  /** Run the planner in a module Worker when available (default: true in browsers). */
  useWorker?: boolean;
  /** Initial language (default: saved preference / navigator). */
  language?: Language;
}

const LANGUAGE_KEY = 'pbsim.language';
const NOTICE_TTL_MS = 7000;
export const DEFAULT_THICKNESS = 2;

// ── helpers ────────────────────────────────────────────────────────────────

function pickSim(lib: ToolLibrary): SimLibrary {
  return { punches: lib.punches, dies: lib.dies, fingers: lib.fingers };
}

function storedLanguage(): Language {
  try {
    const g = globalThis as { localStorage?: { getItem(k: string): string | null }; navigator?: { language?: string } };
    const saved = g.localStorage?.getItem(LANGUAGE_KEY);
    if (isLanguage(saved)) return saved;
    const nav = g.navigator?.language ?? '';
    if (nav.toLowerCase().startsWith('th')) return 'th';
  } catch { /* privacy mode */ }
  return 'en';
}

function persistLanguage(lang: Language): void {
  try { (globalThis as { localStorage?: { setItem(k: string, v: string): void } }).localStorage?.setItem(LANGUAGE_KEY, lang); } catch { /* ignore */ }
}

/** Yield until after the next paint (rAF + macrotask) so a busy state renders before heavy work. */
function nextPaint(): Promise<void> {
  return new Promise(resolve => {
    const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number };
    if (typeof g.requestAnimationFrame === 'function') g.requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}

function nextId(prefix: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!taken.has(id)) return id;
  }
}

export function makeProject(library: ToolLibrary, machine: Machine, thickness: number, language: Language): Project {
  return {
    version: PROJECT_VERSION,
    name: '',
    part: null,
    setup: defaultToolSetup(library, machine, thickness) ?? { machineId: machine.id, stations: [] },
    machineId: machine.id,
    materialId: library.materials.some(m => m.id === STANDARD_MATERIAL_ID) ? STANDARD_MATERIAL_ID : (library.materials[0]?.id ?? ''),
    plannerOptions: defaultPlannerOptions(),
    program: null,
    language,
    libraryOverlay: emptyOverlay(),
  };
}

/** Stable fallback so selectors never hand React a fresh object per call. */
const FALLBACK_MACHINE: Machine = defaultMachine();

/** Machine of the project (falls back to the first library machine, then the default machine). */
export function selectMachine(s: Pick<ProjectState, 'project' | 'library'>): Machine {
  return findMachine(s.library, s.project.machineId) ?? s.library.machines[0] ?? FALLBACK_MACHINE;
}

export function selectMaterial(s: Pick<ProjectState, 'project' | 'library'>): Material | undefined {
  return findMaterial(s.library, s.project.materialId);
}

export function selectSetupMessages(s: Pick<ProjectState, 'project' | 'library'>): Message[] {
  return validateSetup(s.project.setup, selectMachine(s), s.library);
}

export function selectMachineMessages(s: Pick<ProjectState, 'project' | 'library'>): Message[] {
  return validateMachine(selectMachine(s));
}

function mergeMachine(m: Machine, patch: MachinePatch): Machine {
  const { ram, table, backgauge, ...scalars } = patch;
  const { speeds, ...ramScalars } = ram ?? {};
  return {
    ...m,
    ...scalars,
    ram: { ...m.ram, ...ramScalars, speeds: { ...m.ram.speeds, ...(speeds ?? {}) } },
    table: { ...m.table, ...(table ?? {}) },
    backgauge: { ...m.backgauge, ...(backgauge ?? {}) },
  };
}

function patchBend(b: BendLine, patch: BendPatch): BendLine {
  const out: BendLine = { ...b, sources: { ...b.sources } };
  if (patch.direction !== undefined && patch.direction !== b.direction) { out.direction = patch.direction; out.sources.direction = 'user'; }
  if (patch.angle !== undefined && Number.isFinite(patch.angle)) {
    const a = clamp(patch.angle, 0.5, 180);
    if (a !== b.angle) { out.angle = a; out.sources.angle = 'user'; }
    if (a >= 180 && !out.hem) out.hem = 'closed';
    if (a < 180 && out.hem) { delete out.hem; delete out.hemGap; }
  }
  if (patch.innerRadius !== undefined && Number.isFinite(patch.innerRadius)) {
    const r = Math.max(0, patch.innerRadius);
    if (r !== b.innerRadius) { out.innerRadius = r; out.sources.radius = 'user'; }
  }
  if (patch.kFactor !== undefined && Number.isFinite(patch.kFactor)) out.kFactor = clamp(patch.kFactor, 0.05, 1);
  if (patch.angleCorrection !== undefined) {
    if (Number.isFinite(patch.angleCorrection) && patch.angleCorrection !== 0) out.angleCorrection = clamp(patch.angleCorrection, -45, 45);
    else delete out.angleCorrection;
  }
  if (patch.hem !== undefined) out.hem = patch.hem;
  if (patch.hemGap !== undefined) { if (Number.isFinite(patch.hemGap) && patch.hemGap > 0) out.hemGap = patch.hemGap; else delete out.hemGap; }
  if (patch.p0 !== undefined) { out.p0 = { ...patch.p0 }; out.sources.geometry = 'user'; }
  if (patch.p1 !== undefined) { out.p1 = { ...patch.p1 }; out.sources.geometry = 'user'; }
  return out;
}

function stationSegments(punchSegments: readonly number[], length: number): number[] {
  const pieces = punchSegments.filter(l => l > 0 && l <= 835);
  const available = pieces.length > 0 ? pieces : punchSegments.filter(l => l > 0);
  if (available.length === 0 || !(length > 0)) return [];
  const segs = segmentsForLength(length, available);
  const sum = segs.reduce((a, b) => a + b, 0);
  return Math.abs(sum - length) <= 0.5 ? segs : [];
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs `planProgram` in a module Worker (browser) — cancel terminates the worker and rejects with an AbortError. */
function planInWorker(input: PlannerInput, onProgress: (p: PlannerProgress) => void): { promise: Promise<BendProgram>; cancel: () => void } {
  let worker: Worker | null = null;
  let rejectFn: ((err: Error) => void) | null = null;
  const promise = new Promise<BendProgram>((resolve, reject) => {
    rejectFn = reject;
    try {
      worker = new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(new AppError('errors.plan.workerUnavailable', { detail: errorDetail(err) }));
      return;
    }
    const w = worker;
    w.onmessage = (e: MessageEvent<{ type: 'progress'; progress: PlannerProgress } | { type: 'done'; program: BendProgram } | { type: 'error'; name: string; message: string }>) => {
      const d = e.data;
      if (d.type === 'progress') { onProgress(d.progress); return; }
      w.terminate();
      if (d.type === 'done') resolve(d.program);
      else {
        const err = new Error(d.message);
        err.name = d.name;
        reject(err);
      }
    };
    w.onerror = (e: ErrorEvent) => {
      w.terminate();
      reject(new AppError('errors.plan.workerUnavailable', { detail: e.message || 'worker error' }));
    };
    w.postMessage({ type: 'plan', input });
  });
  return {
    promise,
    cancel: () => {
      worker?.terminate();
      const err = new Error('planning cancelled');
      err.name = 'AbortError';
      rejectFn?.(err);
    },
  };
}

let noticeSeq = 0;

// ── store factory ──────────────────────────────────────────────────────────

export function createProjectStore(opts: CreateStoreOptions = {}): UseBoundStore<StoreApi<ProjectStore>> {
  const libraryStore = opts.libraryStore ?? new LibraryStore();
  const useWorker = opts.useWorker ?? (typeof Worker === 'function' && typeof window !== 'undefined');
  const initialLibrary = libraryStore.get();
  const initialMachine = findMachine(initialLibrary, defaultMachine().id) ?? initialLibrary.machines[0] ?? defaultMachine();
  const language = opts.language ?? storedLanguage();
  setGlobalLanguage(language);

  let cancelCurrentPlan: (() => void) | null = null;

  const store = create<ProjectStore>()((set, get) => {
    const machineOf = (): Machine => selectMachine(get());
    const materialOf = (): Material | undefined => selectMaterial(get());

    const invalidateProgram = (): void => {
      if (get().project.program) {
        set(s => ({ project: { ...s.project, program: null }, programStale: false, selectedStepIndex: null, planError: null }));
      }
      useSimStore.getState().setKeyframes([]);
    };

    const markStale = (): void => {
      if (get().project.program) set({ programStale: true });
    };

    const pushKeyframes = (program: BendProgram | null, part: PartModel | null): void => {
      const sim = useSimStore.getState();
      if (!program || !part) { sim.setKeyframes([]); return; }
      const material = materialOf();
      if (!material) { sim.setKeyframes([]); return; }
      try {
        sim.setKeyframes(buildTimeline(program, part, material, machineOf(), get().simLibrary));
      } catch (err) {
        sim.setKeyframes([]);
        get().notify({ key: 'errors.plan.failed', params: { detail: errorDetail(err) }, severity: 'error' });
      }
    };

    /**
     * Replace the part from a flat pattern (rebuilds the model, clears the program). A flat
     * without usable material (empty / degenerate outline — e.g. a mesh the recogniser could
     * not read as a sheet) is refused with an error toast and the current part is kept.
     */
    const applyFlat = (flat: FlatPattern): boolean => {
      let part: PartModel;
      try {
        part = buildPartModel(flat);
      } catch (err) {
        get().notify({ key: 'errors.app.partBuildFailed', params: { detail: errorDetail(err) }, severity: 'error' });
        return false;
      }
      if (part.flanges.length === 0 || !part.rootFlangeId) {
        const reason = part.warnings.find(w => w.severity === 'error') ?? { key: 'warnings.part.noOutline', severity: 'error' as const };
        get().notify({ key: 'errors.app.partBuildFailed', params: { detail: tGlobal(reason.key, reason.params) }, severity: 'error' });
        return false;
      }
      const materialId = flat.materialId && findMaterial(get().library, flat.materialId) ? flat.materialId : get().project.materialId;
      set(s => {
        // a fixed order only keeps the ids that still exist (the planner appends the rest)
        const ids = new Set(flat.bends.map(b => b.id));
        const keptOrder = s.fixedOrder ? s.fixedOrder.filter(id => ids.has(id)) : [];
        const fixedOrder = keptOrder.length > 0 ? keptOrder : null;
        const plannerOptions: PlannerOptions = { ...s.project.plannerOptions };
        if (fixedOrder) plannerOptions.fixedOrder = fixedOrder; else delete plannerOptions.fixedOrder;
        return {
          project: { ...s.project, part, program: null, materialId, name: s.project.name || flat.name, plannerOptions },
          thickness: flat.thickness,
          programStale: false,
          fixedOrder,
          selectedStepIndex: null,
          planError: null,
          selectedBendId: s.selectedBendId && ids.has(s.selectedBendId) ? s.selectedBendId : null,
          activeRightTab: s.project.program ? 'sequence' : s.activeRightTab,
        };
      });
      useSimStore.getState().setKeyframes([]);
      return true;
    };

    const rebuildWithBends = (bends: BendLine[]): void => {
      const part = get().project.part;
      if (!part) return;
      applyFlat({ ...part.flat, bends });
    };

    return {
      project: makeProject(initialLibrary, initialMachine, DEFAULT_THICKNESS, language),
      library: initialLibrary,
      simLibrary: pickSim(initialLibrary),
      thickness: DEFAULT_THICKNESS,
      dxfFlat: null,
      recognized: null,
      mesh: null,
      matchInfo: null,
      importWarnings: [],
      importing: false,
      planning: false,
      planProgress: null,
      planError: null,
      programStale: false,
      fixedOrder: null,
      selectedBendId: null,
      selectedStepIndex: null,
      dxfUnits: 'auto',
      meshUnits: 'auto',
      notices: [],
      activeLeftTab: 'part',
      activeRightTab: 'sequence',

      // ── import ──────────────────────────────────────────────────────────
      async importFiles(files) {
        const inputs: ImportInput[] = [];
        for (const f of files) {
          try {
            inputs.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
          } catch {
            get().notify({ key: 'errors.app.readFailed', params: { name: f.name }, severity: 'error' });
          }
        }
        if (inputs.length) await get().importInputs(inputs);
      },

      async importInputs(inputs, o = {}) {
        if (inputs.length === 0) return;
        const s0 = get();
        set({ importing: true });
        const warnings: Message[] = [];
        let dxfFlat = o.fresh ? null : s0.dxfFlat;
        let recognized = o.fresh ? null : s0.recognized;
        let mesh = o.fresh ? null : s0.mesh;
        let thickness = s0.thickness;
        const materialId = s0.project.materialId;
        const material = findMaterial(s0.library, materialId);
        const kFactor = material?.kFactor ?? 0.44;
        // meshes first: the recognised thickness then feeds the DXF's defaults (radius rule) and its
        // stamped thickness; the drawing stays the geometry source, the 3D model supplies angle /
        // radius / direction through matchToDxf below
        const sorted = [...inputs].sort((a, b) => Number(splitFileName(a.name).ext === 'dxf') - Number(splitFileName(b.name).ext === 'dxf'));
        let importedName = '';
        for (const input of sorted) {
          const base = splitFileName(input.name).base.replace(/[-_ ]?flat$/i, '') || splitFileName(input.name).base;
          try {
            const result = await importFile(input, {
              thickness, materialId, kFactor,
              ...(material ? { material: { tensileStrength: material.tensileStrength, minInnerRadiusFactor: material.minInnerRadiusFactor } } : {}),
              units: s0.dxfUnits, meshUnits: s0.meshUnits, name: base,
            });
            warnings.push(...result.warnings);
            if (result.flat) dxfFlat = result.flat;
            if (result.mesh) {
              mesh = result.mesh;
              const rec = recognizeSheet(mesh, { materialId, kFactor, thicknessHint: thickness, name: base });
              recognized = rec;
              warnings.push(...rec.issues);
              if (rec.thickness > 0) thickness = round(rec.thickness, 3);
            }
            importedName = importedName || base;
          } catch (err) {
            if (err instanceof ImportError) warnings.push(err.toMessage());
            else warnings.push({ key: 'errors.import.unknown', params: { detail: errorDetail(err) }, severity: 'error' });
          }
        }
        let flat: FlatPattern | null = null;
        let matchInfo: ProjectState['matchInfo'] = null;
        if (dxfFlat && recognized) {
          try {
            const dxf = dxfFlat.thickness === thickness ? dxfFlat : { ...dxfFlat, thickness };
            const m = matchToDxf(recognized, dxf);
            warnings.push(...m.warnings);
            flat = m.flat;
            matchInfo = { pairs: m.pairs.length, count: dxf.bends.length, mirrored: m.mirrored };
          } catch (err) {
            warnings.push({ key: 'errors.import.unknown', params: { detail: errorDetail(err) }, severity: 'error' });
            flat = dxfFlat;
          }
        } else if (dxfFlat) flat = dxfFlat;
        else if (recognized) flat = recognized.flat;
        set({ dxfFlat, recognized, mesh, matchInfo, importWarnings: warnings, importing: false, thickness });
        if (flat) {
          const withMaterial: FlatPattern = flat.materialId === materialId && flat.thickness === thickness ? flat : { ...flat, materialId, thickness };
          if (applyFlat(withMaterial)) {
            get().notify({ key: 'app.notice.imported', params: { name: importedName || withMaterial.name } }, 'info');
            set({ activeLeftTab: 'part' });
          }
        } else {
          const errors = warnings.filter(w => w.severity === 'error');
          if (errors.length) get().notify(errors[0]!, 'error');
        }
      },

      async loadSample(name) {
        const base = `/samples/${name}/${name}`;
        const inputs: ImportInput[] = [];
        const errors: Message[] = [];
        const fetchBytes = async (url: string): Promise<Uint8Array | null> => {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(String(res.status));
            return new Uint8Array(await res.arrayBuffer());
          } catch {
            errors.push({ key: 'errors.app.fetchFailed', params: { url }, severity: 'error' });
            return null;
          }
        };
        set({ importing: true });
        const dxf = await fetchBytes(`${base}-flat.dxf`);
        if (dxf) inputs.push({ name: `${name}-flat.dxf`, bytes: dxf });
        const step = await fetchBytes(`${base}.step`);
        if (step) inputs.push({ name: `${name}.step`, bytes: step });
        if (inputs.length === 0) {
          set({ importing: false, importWarnings: errors });
          get().notify(errors[0]!, 'error');
          return;
        }
        set(s => ({ project: { ...s.project, name } }));
        await get().importInputs(inputs, { fresh: true });
        if (errors.length) set(s => ({ importWarnings: [...errors, ...s.importWarnings] }));
      },

      loadFlat(flat) {
        set({ dxfFlat: null, recognized: null, mesh: null, matchInfo: null, importWarnings: flat.warnings ?? [] });
        applyFlat(flat);
      },

      setPartName(name) {
        const part = get().project.part;
        if (!part) return;
        set(s => ({ project: { ...s.project, part: { ...part, flat: { ...part.flat, name } } } }));
      },

      // ── bends ───────────────────────────────────────────────────────────
      setBend(id, patch) {
        const part = get().project.part;
        if (!part) return;
        if (!part.flat.bends.some(b => b.id === id)) return;
        rebuildWithBends(part.flat.bends.map(b => (b.id === id ? patchBend(b, patch) : b)));
      },

      addBend(p0, p1, direction = 'up') {
        const part = get().project.part;
        if (!part) return null;
        if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 0.5) return null;
        const material = materialOf();
        const t = part.flat.thickness;
        const id = nextId('B', part.flat.bends.map(b => b.id));
        const bend: BendLine = {
          id, p0: { ...p0 }, p1: { ...p1 }, direction, angle: 90,
          innerRadius: defaultInnerRadius(t, material ? { tensileStrength: material.tensileStrength, minInnerRadiusFactor: material.minInnerRadiusFactor } : undefined),
          kFactor: material?.kFactor ?? 0.44,
          sources: { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' },
        };
        rebuildWithBends([...part.flat.bends, bend]);
        set({ selectedBendId: id });
        return id;
      },

      removeBend(id) {
        const part = get().project.part;
        if (!part) return;
        rebuildWithBends(part.flat.bends.filter(b => b.id !== id));
        set(s => ({ selectedBendId: s.selectedBendId === id ? null : s.selectedBendId }));
      },

      setMaterial(id) {
        if (!findMaterial(get().library, id)) return;
        const part = get().project.part;
        set(s => ({ project: { ...s.project, materialId: id } }));
        if (part) applyFlat({ ...part.flat, materialId: id });
        else invalidateProgram();
      },

      setThickness(t) {
        if (!Number.isFinite(t) || t <= 0) return;
        const value = round(clamp(t, 0.1, 50), 3);
        const part = get().project.part;
        set({ thickness: value });
        if (part && part.flat.thickness !== value) applyFlat({ ...part.flat, thickness: value });
      },

      // ── tool setup ──────────────────────────────────────────────────────
      setSetup(setup) {
        set(s => ({ project: { ...s.project, setup } }));
        markStale();
      },

      addStation() {
        const s = get();
        const machine = machineOf();
        const stations = [...s.project.setup.stations].sort((a, b) => a.zStart - b.zStart);
        // largest free gap on the bed
        let gapStart = 0, gapEnd = machine.bedLength, best: [number, number] = [0, 0];
        let cursor = 0;
        for (const st of stations) {
          if (st.zStart - cursor > best[1] - best[0]) best = [cursor, st.zStart];
          cursor = Math.max(cursor, st.zEnd);
        }
        if (machine.bedLength - cursor > best[1] - best[0]) best = [cursor, machine.bedLength];
        [gapStart, gapEnd] = best;
        // a full bed: put the new station at the right end (overlapping — validateSetup says so)
        // rather than beyond the bed, which no edit short of moving it could fix
        if (gapEnd - gapStart < 10) { gapEnd = Math.max(10, machine.bedLength); gapStart = Math.max(0, gapEnd - 100); }
        const zStart = Math.ceil(gapStart / 5) * 5;
        const zEnd = Math.max(zStart + 10, Math.floor(gapEnd / 5) * 5);
        const def = defaultToolSetup(s.library, machine, s.thickness);
        const punchId = def?.stations[0]?.punchId ?? s.library.punches[0]?.id ?? '';
        const dieId = def?.stations[0]?.dieId ?? s.library.dies[0]?.id ?? '';
        const punch = s.library.punches.find(p => p.id === punchId);
        const station: ToolStation = {
          id: nextId('S', s.project.setup.stations.map(x => x.id)),
          punchId, dieId, zStart, zEnd,
          segments: punch ? stationSegments(punch.segmentLengths, zEnd - zStart) : [],
          punchFlipped: false, dieFlipped: false,
        };
        set(st => ({ project: { ...st.project, setup: { ...st.project.setup, stations: [...st.project.setup.stations, station] } } }));
        markStale();
      },

      updateStation(id, patch) {
        const s = get();
        const stations = s.project.setup.stations.map(st => {
          if (st.id !== id) return st;
          const next: ToolStation = { ...st, ...patch };
          const rangeChanged = next.zStart !== st.zStart || next.zEnd !== st.zEnd;
          const punchChanged = patch.punchId !== undefined && patch.punchId !== st.punchId;
          if (patch.segments === undefined && (punchChanged || rangeChanged)) {
            const punch = s.library.punches.find(p => p.id === next.punchId);
            next.segments = punch ? stationSegments(punch.segmentLengths, next.zEnd - next.zStart) : [];
          }
          return next;
        });
        set(st => ({ project: { ...st.project, setup: { ...st.project.setup, stations } } }));
        markStale();
      },

      autoSegments(id) {
        const s = get();
        const st = s.project.setup.stations.find(x => x.id === id);
        if (!st) return;
        const punch = s.library.punches.find(p => p.id === st.punchId);
        get().updateStation(id, { segments: punch ? stationSegments(punch.segmentLengths, st.zEnd - st.zStart) : [] });
      },

      removeStation(id) {
        set(st => ({ project: { ...st.project, setup: { ...st.project.setup, stations: st.project.setup.stations.filter(x => x.id !== id) } } }));
        markStale();
      },

      resetSetup() {
        const s = get();
        const machine = machineOf();
        const setup = defaultToolSetup(s.library, machine, s.thickness) ?? { machineId: machine.id, stations: [] };
        set(st => ({ project: { ...st.project, setup } }));
        markStale();
      },

      // ── machine ─────────────────────────────────────────────────────────
      setMachine(id) {
        if (!findMachine(get().library, id)) return;
        set(s => ({ project: { ...s.project, machineId: id, setup: { ...s.project.setup, machineId: id } } }));
        markStale();
      },

      updateMachine(patch) {
        const current = machineOf();
        const next = mergeMachine(current, patch);
        next.id = current.id;
        libraryStore.upsert(next);
        set(s => ({ project: { ...s.project, machineId: next.id, setup: { ...s.project.setup, machineId: next.id } } }));
        // renaming does not change what the planner computed
        if (Object.keys(patch).some(k => k !== 'name')) markStale();
      },

      saveMachineAs(name) {
        const current = machineOf();
        const copy: Machine = { ...current, ram: { ...current.ram, speeds: { ...current.ram.speeds } }, table: { ...current.table }, backgauge: { ...current.backgauge }, id: newCustomId(), name: name.trim() || `${current.name} (copy)` };
        libraryStore.upsert(copy);
        set(s => ({ project: { ...s.project, machineId: copy.id, setup: { ...s.project.setup, machineId: copy.id } } }));
        get().notify({ key: 'app.notice.machineSaved', params: { name: copy.name } }, 'info');
        return copy.id;
      },

      // ── planning ────────────────────────────────────────────────────────
      async plan() {
        const s0 = get();
        if (s0.planning) return;
        if (!s0.project.part) { get().notify({ key: 'errors.plan.noPart', severity: 'error' }, 'error'); return; }
        if (s0.project.part.flat.bends.length === 0) { get().notify({ key: 'errors.plan.noBends', severity: 'error' }, 'error'); return; }
        if (s0.project.setup.stations.length === 0) { get().notify({ key: 'errors.plan.noStations', severity: 'error' }, 'error'); return; }
        if (!materialOf()) { get().notify({ key: 'errors.plan.noMaterial', severity: 'error' }, 'error'); return; }
        const controller = new AbortController();
        set({ planning: true, planProgress: null, planError: null, activeRightTab: 'sequence' });
        await nextPaint();
        if (!get().planning) return;   // cancelled before it started
        // read the inputs AFTER yielding so an edit made while the busy state painted is not lost
        const s = get();
        const part = s.project.part;
        const material = materialOf();
        if (!part || part.flat.bends.length === 0 || s.project.setup.stations.length === 0 || !material) { set({ planning: false, planProgress: null }); return; }
        const input: PlannerInput = { part, material, machine: machineOf(), setup: s.project.setup, library: s.simLibrary, options: s.project.plannerOptions };
        const onProgress = (p: PlannerProgress): void => { set({ planProgress: p }); };
        let program: BendProgram | null = null;
        try {
          if (useWorker) {
            const job = planInWorker(input, onProgress);
            cancelCurrentPlan = job.cancel;
            try {
              program = await job.promise;
            } catch (err) {
              if (err instanceof AppError && err.key === 'errors.plan.workerUnavailable') {
                program = planProgram(input, controller.signal, onProgress);   // fallback: in-thread
              } else throw err;
            }
          } else {
            cancelCurrentPlan = () => controller.abort();
            program = planProgram(input, controller.signal, onProgress);
          }
        } catch (err) {
          cancelCurrentPlan = null;
          if (isAbortError(err) || !get().planning) { set({ planning: false, planProgress: null }); return; }
          set({ planning: false, planProgress: null, planError: { key: 'errors.plan.failed', params: { detail: errorDetail(err) }, severity: 'error' } });
          return;
        }
        cancelCurrentPlan = null;
        if (!get().planning || !program) { set({ planning: false, planProgress: null }); return; }
        // the part may have changed while a worker was planning: drop a stale result
        if (get().project.part !== part) { set({ planning: false, planProgress: null }); return; }
        const done: BendProgram = program;
        // a setup / machine / library / option edit made while the worker was planning leaves the result stale
        const now = get();
        const stale = now.project.setup !== input.setup || now.simLibrary !== input.library || selectMachine(now) !== input.machine || now.project.plannerOptions !== input.options;
        set(st => ({ project: { ...st.project, program: done }, planning: false, planProgress: null, programStale: stale, selectedStepIndex: done.steps.length ? 0 : null }));
        pushKeyframes(done, part);
        get().notify({ key: done.feasible ? 'app.notice.planned' : 'app.notice.plannedInfeasible', params: { steps: done.steps.length } }, done.feasible ? 'info' : 'warning');
      },

      cancelPlan() {
        if (!get().planning) return;
        cancelCurrentPlan?.();
        cancelCurrentPlan = null;
        set({ planning: false, planProgress: null });
      },

      setFixedOrder(ids) {
        set(s => {
          const opts: PlannerOptions = { ...s.project.plannerOptions };
          if (ids && ids.length) opts.fixedOrder = [...ids]; else delete opts.fixedOrder;
          return { project: { ...s.project, plannerOptions: opts }, fixedOrder: ids && ids.length ? [...ids] : null };
        });
      },

      setPlannerOptions(patch) {
        set(s => ({ project: { ...s.project, plannerOptions: { ...s.project.plannerOptions, ...patch, weights: { ...s.project.plannerOptions.weights, ...(patch.weights ?? {}) } } } }));
        markStale();
      },

      // ── project files ───────────────────────────────────────────────────
      saveProject() {
        const s = get();
        const json = serializeProject(s.project, s.library);
        get().notify({ key: 'app.notice.projectSaved', params: { name: s.project.name || 'project' } }, 'info');
        return json;
      },

      loadProject(json) {
        const s = get();
        const parseMessages: Message[] = [];
        const project = parseProject(json, { machineId: s.project.machineId, materialId: s.project.materialId }, parseMessages);
        cancelCurrentPlan?.();
        cancelCurrentPlan = null;
        // custom items travel with the file: add what the library lacks
        const overlay = project.libraryOverlay;
        const lib = libraryStore.get();
        const has = (col: keyof typeof overlay, id: string): boolean => (lib[col] as Array<{ id: string }>).some(x => x.id === id);
        for (const col of ['punches', 'dies', 'fingers', 'materials', 'machines'] as const) {
          for (const item of overlay[col] as LibraryItem[]) {
            if (!has(col, item.id)) libraryStore.upsert(item);
          }
        }
        let library = libraryStore.get();
        const machineId = findMachine(library, project.machineId) ? project.machineId : s.project.machineId;
        const materialId = findMaterial(library, project.materialId) ? project.materialId : s.project.materialId;
        const next: Project = { ...project, machineId, materialId, setup: { ...project.setup, machineId } };
        // The file carries a snapshot of its machine. A standard machine that was never edited
        // here takes the snapshot (the project brings the shop's calibration to this PC); a
        // machine edited here — the shop's shared state — wins, and a program computed for the
        // other settings is flagged for re-planning.
        const snapshot = overlay.machines.find(m => m.id === machineId);
        let current = findMachine(library, machineId);
        let machineDiffers = false, machineAdopted = false;
        if (snapshot && current && JSON.stringify(snapshot) !== JSON.stringify(current)) {
          const pristine = buildStandardLibrary().machines.find(m => m.id === machineId);
          if (pristine && JSON.stringify(pristine) === JSON.stringify(current)) {
            libraryStore.upsert(snapshot);
            library = libraryStore.get();
            current = snapshot;
            machineAdopted = true;
          } else machineDiffers = !!next.program;
        }
        set({
          project: next,
          thickness: next.part?.flat.thickness ?? s.thickness,
          dxfFlat: null, recognized: null, mesh: null, matchInfo: null,
          importWarnings: next.part?.flat.warnings ?? [],
          importing: false, planning: false, planProgress: null,
          fixedOrder: next.plannerOptions.fixedOrder ?? null,
          programStale: machineDiffers, planError: null, selectedBendId: null, selectedStepIndex: next.program?.steps.length ? 0 : null,
        });
        if (next.language !== s.project.language) get().setLanguage(next.language);
        pushKeyframes(next.program, next.part);
        get().notify({ key: 'app.notice.projectLoaded', params: { name: next.name || 'project' } }, 'info');
        for (const m of parseMessages) get().notify(m);
        if (machineDiffers && current) get().notify({ key: 'app.notice.machineDiffers', params: { name: current.name }, severity: 'warning' }, 'warning');
        if (machineAdopted && current) get().notify({ key: 'app.notice.machineFromProject', params: { name: current.name } }, 'info');
      },

      newProject() {
        cancelCurrentPlan?.();
        cancelCurrentPlan = null;
        const s = get();
        const machine = machineOf();
        set({
          project: makeProject(s.library, machine, DEFAULT_THICKNESS, s.project.language),
          thickness: DEFAULT_THICKNESS,
          dxfFlat: null, recognized: null, mesh: null, matchInfo: null, importWarnings: [], importing: false,
          planning: false, planProgress: null, planError: null, programStale: false, fixedOrder: null,
          selectedBendId: null, selectedStepIndex: null,
        });
        useSimStore.getState().setKeyframes([]);
      },

      setProjectName(name) {
        set(s => ({ project: { ...s.project, name } }));
      },

      setLanguage(lang) {
        if (!isLanguage(lang)) return;
        setGlobalLanguage(lang);
        persistLanguage(lang);
        set(s => ({ project: { ...s.project, language: lang } }));
      },

      // ── selection / navigation ──────────────────────────────────────────
      selectBend(id) { set({ selectedBendId: id }); },

      selectStep(index) {
        set({ selectedStepIndex: index });
        if (index !== null) useSimStore.getState().seekStep(index);
      },

      seekToCollision(step, report) {
        const sim = useSimStore.getState();
        set({ selectedStepIndex: step.index });
        const segs = phaseSegments(sim.keyframes).filter(p => p.stepIndex === step.index);
        const bendSeg = segs.find(p => p.phase === 'bend');
        if (!bendSeg) { sim.seekStep(step.index); return; }
        if (!(report.atFraction > 0)) {
          // a collision at placement: show the part gauged, just before the ram comes down
          const gauge = segs.find(p => p.phase === 'gauge');
          sim.seekTime(gauge ? gauge.endTime : bendSeg.startTime);
          return;
        }
        // the bend phase is not linear in the fold fraction (the ram speed is): locate the
        // fraction in the keyframes' fold state and interpolate the time between neighbours
        const frames = sim.keyframes;
        const fractionOf = (i: number): number => frames[i]?.foldState[step.bendId] ?? 0;
        let time = bendSeg.endTime;
        for (let i = bendSeg.first + 1; i <= bendSeg.last; i++) {
          const f1 = fractionOf(i);
          if (f1 >= report.atFraction) {
            const f0 = fractionOf(i - 1);
            const t0 = frames[i - 1]!.timeS, t1 = frames[i]!.timeS;
            const u = f1 > f0 ? clamp((report.atFraction - f0) / (f1 - f0), 0, 1) : 1;
            time = t0 + u * (t1 - t0);
            break;
          }
        }
        sim.seekTime(time);
      },

      setLeftTab(tab) { set({ activeLeftTab: tab }); },
      setRightTab(tab) { set({ activeRightTab: tab }); },
      setDxfUnits(units) { set({ dxfUnits: units }); },
      setMeshUnits(units) { set({ meshUnits: units }); },

      notify(message, severity) {
        const id = ++noticeSeq;
        const sev = severity ?? (message.severity === 'error' ? 'error' : message.severity === 'warning' ? 'warning' : 'info');
        set(s => ({ notices: [...s.notices.slice(-4), { id, message, severity: sev }] }));
        setTimeout(() => { get().dismissNotice(id); }, NOTICE_TTL_MS);
      },

      dismissNotice(id) {
        set(s => (s.notices.some(n => n.id === id) ? { notices: s.notices.filter(n => n.id !== id) } : s));
      },

      // ── library ─────────────────────────────────────────────────────────
      upsertLibraryItem(item) {
        libraryStore.upsert(item);
        markStale();
      },

      removeLibraryItem(id) {
        const s = get();
        const inUse = s.project.setup.stations.some(st => st.punchId === id || st.dieId === id)
          || s.library.machines.some(m => m.backgauge.fingerId === id)   // a finger mounted on any machine of the library
          || s.project.machineId === id || s.project.materialId === id;
        if (inUse) { get().notify({ key: 'tools.toolInUse', severity: 'warning' }, 'warning'); return false; }
        return libraryStore.remove(id);
      },

      async saveLibrary() {
        const r = await libraryStore.save();
        const severity = r.remote === 'saved' || r.remote === 'conflict-resolved' || r.remote === 'disabled' ? 'info' : 'warning';
        get().notify({ key: 'tools.librarySaved', params: { remote: tGlobal(`tools.remote.${r.remote}`) } }, severity);
        for (const m of r.messages) get().notify(m);
      },

      async loadLibrary() {
        const r = await libraryStore.load();
        for (const m of r.messages) if (m.severity !== 'info') get().notify(m);
        // the project must still point at an existing machine / material
        const lib = libraryStore.get();
        const s = get();
        if (!findMachine(lib, s.project.machineId)) {
          const m = lib.machines[0] ?? defaultMachine();
          set(st => ({ project: { ...st.project, machineId: m.id, setup: { ...st.project.setup, machineId: m.id } } }));
        }
        if (!findMaterial(lib, s.project.materialId) && lib.materials[0]) set(st => ({ project: { ...st.project, materialId: lib.materials[0]!.id } }));
        // a fresh project (nothing loaded yet) gets its default setup rebuilt for the shop's
        // machine — its bed may be shorter than the standard machine the store started with
        const st = get();
        if (!st.project.part && !st.project.program && !st.programStale) {
          const machine = machineOf();
          const setup = defaultToolSetup(lib, machine, st.thickness) ?? { machineId: machine.id, stations: [] };
          set(p => ({ project: { ...p.project, setup } }));
        }
      },

      exportLibraryJson() { return libraryStore.exportJson(); },

      importLibraryJson(json, mode = 'merge') {
        const messages = libraryStore.importJson(json, mode);
        markStale();
        return messages;
      },

      resetStandardItems() {
        libraryStore.resetStandardItems();
        markStale();
      },
    };
  });

  libraryStore.subscribe(lib => {
    // keep the tool pick referentially stable while only materials / machines change, so the
    // sim components and the planner input do not see a "new" tool library on every machine edit
    const prev = store.getState().simLibrary;
    const same = prev.punches === lib.punches && prev.dies === lib.dies && prev.fingers === lib.fingers;
    store.setState({ library: lib, simLibrary: same ? prev : pickSim(lib) });
  });

  return store;
}

/** The app's library store singleton (localStorage cache + /api/library in the browser). */
export const libraryStore = new LibraryStore();

/** The app's project store. */
export const useProjectStore = createProjectStore({ libraryStore });
