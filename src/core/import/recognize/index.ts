/**
 * recognize-3d barrel: sheet-metal feature recognition + unfolding of a TriangleMesh and
 * alignment with a DXF flat pattern. See docs/specs/recognize-3d.md.
 */
export { recognizeSheet } from './recognize';
export type { RecognizeOptions } from './recognize';
export { matchToDxf, applyFlatTransform, kabsch2d } from './match';
export type { FlatTransform } from './match';
export { buildTopology } from './topology';
export type { Topology } from './topology';
export { groupFaces, buildPlanarFace, PLANAR_TOL_DEG, CURVED_MAX_DEG } from './faces';
export type { Grouping, FaceSet, PlanarFace } from './faces';
export { fitCylinder, fitCircle2d, cylinderAxisDirection } from './cylinders';
export type { CylinderFit } from './cylinders';
export { detectThickness } from './thickness';
export type { ThicknessResult } from './thickness';
export { pairCylinders } from './bends';
export type { BendCandidate, CylFace } from './bends';
