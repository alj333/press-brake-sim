/**
 * Sheet-metal maths — the single source of truth (ARCHITECTURE "Sheet-metal maths").
 * Notation: t thickness, ri inner radius, k k-factor, θ bend angle from flat (deg),
 * θi = 180 − θ included angle, V die opening, Rm tensile strength (MPa), rs shoulder radius.
 * All lengths mm, angles degrees, forces kN.
 */
import type { Material } from '../types';

const DEG = Math.PI / 180;
export const rad = (deg: number): number => deg * DEG;
export const deg = (r: number): number => r / DEG;

export type DimensionRef = 'virtual-sharp' | 'tangent';

/** BA = rad(θ)·(ri + k·t) */
export function bendAllowance(angleDeg: number, innerRadius: number, kFactor: number, thickness: number): number {
  return rad(angleDeg) * (innerRadius + kFactor * thickness);
}

/** Outside setback: tan(θ/2)·(ri + t) to the virtual sharp for θ ≤ 90, else ri + t to the tangent. */
export function outsideSetback(angleDeg: number, innerRadius: number, thickness: number): { value: number; ref: DimensionRef } {
  if (angleDeg <= 90) return { value: Math.tan(rad(angleDeg) / 2) * (innerRadius + thickness), ref: 'virtual-sharp' };
  return { value: innerRadius + thickness, ref: 'tangent' };
}

/** BD = 2·OSSB − BA */
export function bendDeduction(angleDeg: number, innerRadius: number, kFactor: number, thickness: number): number {
  return 2 * outsideSetback(angleDeg, innerRadius, thickness).value - bendAllowance(angleDeg, innerRadius, kFactor, thickness);
}

export function neutralRadius(innerRadius: number, kFactor: number, thickness: number): number {
  return innerRadius + kFactor * thickness;
}

export function midRadius(innerRadius: number, thickness: number): number {
  return innerRadius + thickness / 2;
}

/** kN/m: 1.42·Rm·t²/V */
export function airBendForcePerMeter(tensileStrength: number, thickness: number, vWidth: number): number {
  return (1.42 * tensileStrength * thickness * thickness) / vWidth;
}

/** Air-bend force: F = 1.42·Rm·L·t²/(V·1000) kN, with the per-metre value. */
export function airBendForce(tensileStrength: number, bendLength: number, thickness: number, vWidth: number): { force: number; forcePerMeter: number } {
  const forcePerMeter = airBendForcePerMeter(tensileStrength, thickness, vWidth);
  return { force: (forcePerMeter * bendLength) / 1000, forcePerMeter };
}

/** Hem flattening force ≈ 0.7·Rm·t·L/1000 kN (≈ 60 t/m at 2 mm mild steel). */
export function hemFlattenForce(tensileStrength: number, thickness: number, bendLength: number): number {
  return (0.7 * tensileStrength * thickness * bendLength) / 1000;
}

/**
 * Ram depth D (punch tip below the die shoulder plane) for included angle θi.
 * Legs symmetric about Y at φ = θi/2 from vertical, outer radius R = ri + t tangent to both legs,
 * tip at the inner-arc apex. Sharp shoulder: the outer leg line passes through (V/2, 0):
 *   D = (V/2)·cot φ + ri − R/sin φ.
 * Shoulder fillet rs > 0: the outer leg line is tangent to the fillet circle
 *   centre (xc, −rs), xc = V/2 + rs·(1 − sin β)/cos β, β = vAngle/2 —
 * closed form of "distance from the fillet centre to the leg line = rs":
 *   D = ri + xc·cot φ − R/sin φ − rs·(1/sin φ − 1).
 * D(θi = 180) = −t (flat sheet on the die). Clamped only to D ≥ −t.
 */
export function ramDepth(vWidth: number, thickness: number, innerRadius: number, includedAngleDeg: number, shoulderRadius = 0, vAngleDeg = 88): number {
  const phi = rad(Math.min(180, Math.max(1e-6, includedAngleDeg))) / 2;
  const R = innerRadius + thickness;
  const sinPhi = Math.sin(phi), cotPhi = Math.cos(phi) / sinPhi;
  let D: number;
  if (shoulderRadius > 0) {
    const beta = rad(vAngleDeg) / 2;
    const xc = vWidth / 2 + (shoulderRadius * (1 - Math.sin(beta))) / Math.cos(beta);
    D = innerRadius + xc * cotPhi - R / sinPhi - shoulderRadius * (1 / sinPhi - 1);
  } else {
    D = (vWidth / 2) * cotPhi + innerRadius - R / sinPhi;
  }
  return Math.max(D, -thickness);
}

/** Punch tip Y (machine frame, die shoulder plane = 0) at fold angle θf: −D(θi = 180 − θf); = +t at 0. */
export function punchTipY(vWidth: number, thickness: number, innerRadius: number, foldAngleDeg: number, shoulderRadius = 0, vAngleDeg = 88): number {
  return -ramDepth(vWidth, thickness, innerRadius, 180 - foldAngleDeg, shoulderRadius, vAngleDeg);
}

/** Inner radius that actually forms in air bending: max(0.16·V·Rm/420, punch tip, material minimum). */
export function actualInnerRadius(vWidth: number, material: Pick<Material, 'tensileStrength' | 'minInnerRadiusFactor'>, thickness: number, punchTipRadius: number): number {
  return Math.max((0.16 * vWidth * material.tensileStrength) / 420, punchTipRadius, material.minInnerRadiusFactor * thickness);
}

/** sb = material.springbackDeg·(0.5 + 0.5·(ri/t))·(θ/90), clamped to [0.3°, 12°]. */
export function springback(material: Pick<Material, 'springbackDeg'>, riActual: number, thickness: number, angleDeg: number): number {
  const sb = material.springbackDeg * (0.5 + 0.5 * (riActual / thickness)) * (angleDeg / 90);
  return Math.min(12, Math.max(0.3, sb));
}

/** overbend = θ + springback + correction; loaded included angle = 180 − overbend. */
export function overbend(
  material: Pick<Material, 'springbackDeg'>, riActual: number, thickness: number, angleDeg: number, angleCorrection = 0,
): { springback: number; overbendAngle: number; loadedIncludedAngle: number } {
  const sb = springback(material, riActual, thickness, angleDeg);
  const overbendAngle = angleDeg + sb + angleCorrection;
  return { springback: sb, overbendAngle, loadedIncludedAngle: 180 - overbendAngle };
}

/** Preferred die opening: 8t (t ≤ 3), 10t (3 < t ≤ 6), 12t (t > 6). */
export function recommendedV(thickness: number): number {
  return thickness <= 3 ? 8 * thickness : thickness <= 6 ? 10 * thickness : 12 * thickness;
}

/** Minimum outside leg (to the virtual sharp): (V/2)/sin(θi_loaded/2) + rs + 2. */
export function minLeg(vWidth: number, loadedIncludedDeg: number, shoulderRadius: number): number {
  return (vWidth / 2) / Math.sin(rad(loadedIncludedDeg) / 2) + shoulderRadius + 2;
}

export type LegStatus = 'ok' | 'warning' | 'error';

export function legCheck(outsideLength: number, minimumLeg: number, warnFactor = 1.15): LegStatus {
  if (outsideLength < minimumLeg) return 'error';
  if (outsideLength < warnFactor * minimumLeg) return 'warning';
  return 'ok';
}

/** Hard constraint: punch.tipAngle + 1 ≤ 180 − overbend and die.vAngle + 1 ≤ 180 − overbend. */
export function toolAngleFeasible(punchTipAngle: number, dieVAngle: number, overbendAngle: number): boolean {
  const loaded = 180 - overbendAngle;
  return punchTipAngle + 1 <= loaded && dieVAngle + 1 <= loaded;
}
