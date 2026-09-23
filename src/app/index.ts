/** ui barrel — `<AppRoot/>` (ARCHITECTURE "Public API"), the project store and the file / format helpers. */
export { AppRoot } from './App';
export { default } from './App';
export {
  useProjectStore, libraryStore, createProjectStore, makeProject, selectMachine, selectMaterial, selectSetupMessages, selectMachineMessages, DEFAULT_THICKNESS,
} from './store';
export type {
  ProjectState, ProjectActions, ProjectStore, BendPatch, StationPatch, MachinePatch, Notice, ImportInput, LeftTab, RightTab, SimLibrary, CreateStoreOptions,
} from './store';
export {
  AppError, serializeProject, parseProject, buildOverlay, emptyOverlay, programToJson, programToCsv, downloadText, safeFileName, PROJECT_VERSION, APP_ID,
} from './project';
export type { LibraryOverlay, ProjectFile, ProgramContext } from './project';
export { fmt, fmtAngle, fmtMm, fmtForce, fmtPercent, fmtDate, kNToTonnes, parseNumberList, joinNumberList, round, clamp, KN_PER_TONNE } from './format';
export { SAMPLE_NAMES } from './sampleNames';
export type { SampleName } from './sampleNames';
