/** sim-3d — 3D simulation, section view, transport bar and playback store (docs/specs/sim-3d.md). */
export { SimViewport } from './SimViewport';
export type { SimViewportProps, SimSceneProps } from './SimViewport';
export { SectionView } from './SectionView';
export type { SectionViewProps } from './SectionView';
export { TransportBar } from './TransportBar';
export type { TransportBarProps } from './TransportBar';
export { PartMesh } from './PartMesh';
export type { PartMeshProps } from './PartMesh';
export { MachineModel } from './MachineModel';
export type { MachineModelProps } from './MachineModel';
export { ToolModel } from './ToolModel';
export type { ToolModelProps } from './ToolModel';
export { useSimStore, currentFrame, simDuration, currentStepIndex, SPEED_MIN, SPEED_MAX } from './store';
export type { SimState, SimActions, SimStore, CameraPreset } from './store';
export {
  frameAt, keyframeIndexAt, interpolateKeyframes, slerpQuat, lerpFoldState, lerpFingers, phaseSegments, hasErrorCollision,
  hasNewErrorCollision, firstNewErrorKeyframe,
} from './interpolate';
export type { SimFrame, PhaseSegment } from './interpolate';
export {
  buildFlangeGeometry, buildBendZoneGeometry, fillBendZoneArrays, zoneIndices, zoneHandedness, zoneToLocal, zoneParentFlangeIndex,
  zoneVertexCount, zoneIndexCount, meshDataBounds, ZONE_SEGMENTS,
} from './partGeometry';
export type { MeshData } from './partGeometry';
export {
  idleFrame, idleRotation, sceneFrameOf, stepOf, stationOf, stationCentreZ, collisionKinds, punchPieces, toolStack, formatTime, SIM_COLORS, EMPTY_SETUP,
  SIM_SPEEDS, ZONE_REFILL_DELTA, SEGMENT_GAP, FRAME_PLATE, FRAME_COLUMN,
} from './scene';
export type { SceneFrame, SimLibrary } from './scene';
export { simLabelsEn, defaultT, withFallback } from './labels';
export type { TranslateFn } from './labels';
