/** core-geometry / part — flange tree, fold kinematics, machine poses and silhouettes. */
export { buildPartModel } from './build';
export type { BuildOptions } from './build';
export { foldGeometry, flatState, finishedState, partBoundsFolded, derivePart } from './fold';
export type { DerivedLink, DerivedPart } from './fold';
export { bendPose } from './pose';
export { partSilhouette } from './silhouette';
export type { SilhouettePiece, SilhouetteSource } from './silhouette';
export { flangeExtentFromBend } from './extent';
export { zonePoint, zoneStripPoint, zoneSurfaceSamples, zoneCentrePoint, isStraightZone, STRAIGHT_ANGLE } from './zone';
export type { FoldedBend } from './zone';
export { bendFrame, coordS, coordD, regionsSideOfBend, polygonBendSides } from './frame';
export type { BendFrame } from './frame';
