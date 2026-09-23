/**
 * Bend-zone surface sampling shared by bounds, silhouette and pose (constant-arc-length model).
 * Mid-surface arc: P(φ, λ) = C_λ + rm·(−toCentre·cos φ + tangent·sin φ), C_λ = S_λ + rm·toCentre.
 */
import type { FoldedGeometry, Vec3 } from '../types';
import { vec3 } from '../geom';

export type FoldedBend = FoldedGeometry['bends'][number];

/** Minimum fold angle (deg) for the zone to be treated as an arc. */
export const STRAIGHT_ANGLE = 0.01;

export function isStraightZone(b: FoldedBend): boolean {
  return b.currentAngle < STRAIGHT_ANGLE || !Number.isFinite(b.midRadius);
}

/** Point of the zone at arc angle φ (deg), axial fraction λ (0 = startEdge[0], 1 = startEdge[1]) and radius r. */
export function zonePoint(b: FoldedBend, phiDeg: number, lambda: number, r: number): Vec3 {
  const S = vec3.lerp(b.startEdge[0], b.startEdge[1], lambda);
  if (isStraightZone(b)) {
    // straight strip: r is measured from the "centre side" — offset = (r − rm) toward toCentre; here rm is
    // infinite, so callers pass offsets via zoneStripPoint instead.
    return S;
  }
  const C = vec3.add(S, vec3.scale(b.toCentre, b.midRadius));
  const phi = (phiDeg * Math.PI) / 180;
  return vec3.add(C, vec3.add(vec3.scale(b.toCentre, -r * Math.cos(phi)), vec3.scale(b.tangent, r * Math.sin(phi))));
}

/** Straight strip point: distance `along` from the start edge along the tangent, `offset` toward toCentre. */
export function zoneStripPoint(b: FoldedBend, along: number, lambda: number, offset: number): Vec3 {
  const S = vec3.lerp(b.startEdge[0], b.startEdge[1], lambda);
  return vec3.add(S, vec3.add(vec3.scale(b.tangent, along), vec3.scale(b.toCentre, offset)));
}

/**
 * Samples of the inner and outer surfaces at one axial position, from φ = 0 to currentAngle in
 * `steps` steps (steps + 1 points each). For a straight zone: the two strip edges.
 */
export function zoneSurfaceSamples(b: FoldedBend, thickness: number, lambda: number, steps = 8): { inner: Vec3[]; outer: Vec3[] } {
  const inner: Vec3[] = [], outer: Vec3[] = [];
  if (isStraightZone(b)) {
    for (const along of [0, b.zoneWidth]) {
      inner.push(zoneStripPoint(b, along, lambda, thickness / 2));
      outer.push(zoneStripPoint(b, along, lambda, -thickness / 2));
    }
    return { inner, outer };
  }
  const rIn = Math.max(0, b.innerRadius), rOut = b.innerRadius + thickness;
  for (let i = 0; i <= steps; i++) {
    const phi = (b.currentAngle * i) / steps;
    inner.push(zonePoint(b, phi, lambda, rIn));
    outer.push(zonePoint(b, phi, lambda, rOut));
  }
  return { inner, outer };
}

/** The bend-line-centre material point on the mid-surface (φ = θf/2, λ = ½). */
export function zoneCentrePoint(b: FoldedBend): Vec3 {
  if (isStraightZone(b)) return zoneStripPoint(b, b.zoneWidth / 2, 0.5, 0);
  return zonePoint(b, b.currentAngle / 2, 0.5, b.midRadius);
}
