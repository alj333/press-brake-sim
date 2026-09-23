/** core-geometry / bend — sheet-metal formulas (single source of truth). */
export {
  rad, deg, bendAllowance, outsideSetback, bendDeduction, neutralRadius, midRadius, airBendForce,
  airBendForcePerMeter, hemFlattenForce, ramDepth, punchTipY, actualInnerRadius, springback, overbend,
  recommendedV, minLeg, legCheck, toolAngleFeasible,
} from './formulas';
export type { DimensionRef, LegStatus } from './formulas';
