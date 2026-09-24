/** planner — bend-sequence planner (ARCHITECTURE "Bend-sequence planner", docs/specs/planner.md). */
export { planProgram, buildBendStep, buildHemFlattenStep, RETRACT_MARGIN } from './program';
export { defaultPlannerOptions, createContext, HEM_PREBEND, MAX_BENDS } from './context';
export type { PlannerInput, PlannerProgress, PlannerLibrary, PlanContext, BendInfo, StationInfo } from './context';
export { computePlacement, computePlacementDetails, classifyTurn, rotationAngleDeg, TURN_NONE_MAX_DEG } from './placement';
export type { PlacementDetails } from './placement';
export { analyseStation, bendStationMaths, flatMaterialLimits, bestSegmentsWithin, centrePunchInStation, shiftPlacementDetails, PUNCH_CLEARANCE, HEM_PREBEND_MIN } from './stations';
export type { StationAnalysis, BendStationMaths } from './stations';
export { planBackgauge, maxXInBand } from './backgauge';
export type { BackgaugeRequest, BackgaugeResult } from './backgauge';
export { sweepCollisions, obstaclesAt, cutBox, overlapLocation, poseAtFraction, COLLISION_THRESHOLD, MAX_SWEEP_STEPS } from './collision';
export type { SweepRequest, SweepResult } from './collision';
export { createEvaluator, HARD_ERROR_COST, GAUGE_WARNING_COST, FINGER_OVER_DIE_COST, SINGLE_FINGER_COST } from './evaluate';
export type { Evaluation, Evaluator, GaugedSide, LegInfo } from './evaluate';
export { searchSequence, sequenceCost, manipulationCost, BEAM_WIDTH, EXHAUSTIVE_MAX_BENDS } from './search';
export type { SearchResult, SequenceStep } from './search';
export { buildTimeline, KEYFRAMES_PER_PHASE, PARK_OFFSET, parkOffsetFor, HANDLING_SPEED, TURN_TIME_S, GAUGE_APPROACH, RELEASE_RISE } from './timeline';
