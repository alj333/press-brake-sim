/**
 * bendPose — machine pose of the part during a bend (both legs rise symmetrically).
 * pose = T(−apex.x, punchTipY − t/2 − apex.y, 0) · R(C', a', −θf/2) · placement
 * where apex = R·placement·m and m is the bend-line-centre mid-surface material point.
 * See docs/specs/core-geometry.md §3.4.
 */
import type { FoldedGeometry, Mat4 } from '../types';
import { mat4 } from '../geom';
import { isStraightZone, zoneCentrePoint } from './zone';

/**
 * `folded` must be `foldGeometry(part, { …previous bends: 1, [bendId]: fraction })`; θf is read from
 * it (`currentAngle`), `fraction` is only checked for consistency (a folded geometry at 0 passed with
 * a fraction > 0, or vice versa, throws — it would silently produce a wrong pose otherwise).
 */
export function bendPose(placement: Mat4, folded: FoldedGeometry, bendId: string, fraction: number, punchTipY: number, thickness: number): Mat4 {
  const b = folded.bends.find(x => x.bendId === bendId);
  if (!b) throw new Error(`bendPose: bend ${bendId} is not part of the folded geometry`);
  const straight = isStraightZone(b);
  if (Number.isFinite(fraction) && ((fraction >= 0.01 && straight) || (fraction <= 0 && !straight))) {
    throw new Error(`bendPose: folded geometry of ${bendId} (θf = ${b.currentAngle}°) does not match fraction ${fraction}`);
  }
  const m = zoneCentrePoint(b);
  let R: Mat4;
  if (straight) {
    R = mat4.identity();
  } else {
    const cPrime = mat4.applyToPoint(placement, b.axisPoint);
    const aPrime = mat4.applyToDir(placement, b.axisDir);
    R = mat4.rotationAxisAngle(cPrime, aPrime, -b.currentAngle / 2);
  }
  const rp = mat4.multiply(R, placement);
  const apex = mat4.applyToPoint(rp, m);
  const T = mat4.translationXYZ(-apex.x, punchTipY - thickness / 2 - apex.y, 0);
  return mat4.multiply(T, rp);
}
