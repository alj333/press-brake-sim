/** tooling-machine / tools — parametric standard tooling, custom tools, ratings and checks. */
export { straightPunch, gooseneckPunch, acutePunch, radiusPunch, hemmingPunch, STANDARD_SEGMENT_LENGTHS, PUNCH_RATINGS } from './punches';
export type { PunchMeta, StraightPunchParams, GooseneckPunchParams, AcutePunchParams, RadiusPunchParams, HemmingPunchParams } from './punches';
export {
  vDie, multiVDie, hemmingDie, vNotchTopEdge, vNotchDepth, shoulderTangentX, maxShoulderRadius,
  standardDieBodyWidth, standardDieHeight, standardShoulderRadius, standardDieRating, MULTI_V_RATING,
} from './dies';
export type { DieMeta, VDieParams, MultiVDieParams, HemmingDieParams } from './dies';
export { flatFinger, steppedFinger } from './fingers';
export type { FingerMeta, FlatFingerParams, SteppedFingerParams } from './fingers';
export { normalizeProfile, createCustomPunch, createCustomDie, createCustomFinger, enforceFrameExtents, newCustomId, CUSTOM_DEFAULT_RATING } from './custom';
export type {
  ToolKind, ProfileUpDir, NormalizeProfileOptions, NormalizedProfile, CustomToolMeta, CustomPunchMeta, CustomDieMeta, CustomFingerMeta,
} from './custom';
export { derivePunchParams, deriveDieParams, deriveFingerParams } from './derive';
export type { DerivedPunchParams, DerivedDieParams, DerivedFingerParams } from './derive';
export { isSimplePolygon, fitCircle, tipArc, mirrorProfileX, translateProfile, TOOL_CHORD_TOL } from './profile';
export type { CircleFit } from './profile';
export {
  buildStandardLibrary, standardPunches, standardDies, standardFingers, standardMaterials, standardDieId,
  LIBRARY_VERSION, STANDARD_V_WIDTHS, MULTI_V_WIDTHS, STANDARD_PUNCH_ID, STANDARD_FINGER_ID, STANDARD_MATERIAL_ID,
} from './standard';
export { toolLoadCheck, daylightCheck, strokeCheck } from './checks';
export { defaultToolSetup, pickDieForThickness, segmentsForLength } from './setup';
export type { DefaultSetupOptions } from './setup';
export type { ToolLoadCheck, DaylightCheck, StrokeCheck } from './checks';
