/**
 * Placements (ARCHITECTURE "Bend-sequence planner" §2, docs/specs/planner.md §2).
 * The orientation about the bend axis is forced (concave side up); the only choice is which
 * adjacent flange faces the backgauge (+X). `classifyTurn` derives the operator manipulation
 * between two placements from their relative rigid motion.
 */
import type { FoldedGeometry, Mat4, PartModel, Placement, ToolStation, Turn, Vec3 } from '../types';
import { mat4, vec3 } from '../geom';
import { partBoundsFolded, isStraightZone } from '../part';

export interface PlacementDetails {
  placement: Placement;
  /** Rotation part (PART → MACHINE) without translation. */
  rotation: Mat4;
  /** Machine Z extent of the bend line (sorted). */
  bendZ: [number, number];
  /** Machine Z of the bend line's p0 and p1 ends (unsorted). */
  bendZ01: [number, number];
  /** Machine bounds of the part at this placement (f = 0). */
  bounds: { min: Vec3; max: Vec3 };
  parentFlangeId: string;
  childFlangeId: string;
}

/** Column-major rotation matrix whose ROWS are the machine axes expressed in the source frame. */
function rotationFromRows(ex: Vec3, ey: Vec3, ez: Vec3): Mat4 {
  return [ex.x, ey.x, ez.x, 0, ex.y, ey.y, ez.y, 0, ex.z, ey.z, ez.z, 0, 0, 0, 0, 1];
}

/**
 * Placement of the part for `bendId` with `gaugedFlangeId` (parent or child of the bend) toward
 * +X. `folded` must be `foldGeometry(part, { previous bends: 1, [bendId]: 0 })`.
 */
export function computePlacementDetails(
  part: PartModel, folded: FoldedGeometry, bendId: string, gaugedFlangeId: string, station: Pick<ToolStation, 'zStart' | 'zEnd'>, thickness: number,
): PlacementDetails {
  const link = part.links.find(l => l.bendId === bendId);
  if (!link) throw new Error(`computePlacement: bend ${bendId} is not a tree link`);
  const bend = part.flat.bends.find(b => b.id === bendId);
  if (!bend) throw new Error(`computePlacement: unknown bend ${bendId}`);
  const zone = folded.bends.find(b => b.bendId === bendId);
  if (!zone) throw new Error(`computePlacement: bend ${bendId} missing from the folded geometry`);
  if (!isStraightZone(zone)) throw new Error(`computePlacement: bend ${bendId} must be flat (currentAngle ${zone.currentAngle}°) in the folded geometry`);
  if (gaugedFlangeId !== link.parentFlangeId && gaugedFlangeId !== link.childFlangeId) {
    throw new Error(`computePlacement: ${gaugedFlangeId} is not adjacent to bend ${bendId}`);
  }
  const gaugedIsChild = gaugedFlangeId === link.childFlangeId;
  const sigma = bend.direction === 'up' ? 1 : -1;
  // straight zone: toCentre = the parent's current +w, tangent = d̂ toward the child
  const w = vec3.normalize(zone.toCentre);
  const dHat = vec3.normalize(zone.tangent);
  const ey = vec3.scale(w, sigma);
  const ex = gaugedIsChild ? dHat : vec3.neg(dHat);
  const ez = vec3.normalize(vec3.cross(ex, ey));
  const rotation = rotationFromRows(ex, ey, ez);

  // bend-line centre material point (mid-surface) → (0, t/2, zc)
  const m = vec3.add(vec3.midpoint(zone.startEdge[0], zone.startEdge[1]), vec3.scale(dHat, zone.zoneWidth / 2));
  const mr = mat4.applyToPoint(rotation, m);
  const b = partBoundsFolded(folded, thickness, rotation);
  const zStart = Math.min(station.zStart, station.zEnd), zEnd = Math.max(station.zStart, station.zEnd);
  const tz = (zStart + zEnd) / 2 - mr.z;
  const transform = mat4.multiply(mat4.translationXYZ(-mr.x, thickness / 2 - mr.y, tz), rotation);
  const root = folded.flanges.find(f => f.flangeId === part.rootFlangeId);
  const rootUp = root ? mat4.applyToDir(rotation, root.normal) : ey;
  const p0 = mat4.applyToPoint(transform, zone.startEdge[0]), p1 = mat4.applyToPoint(transform, zone.startEdge[1]);
  const placement: Placement = {
    bendId,
    gaugedFlangeId,
    frontFlangeId: gaugedIsChild ? link.parentFlangeId : link.childFlangeId,
    flipped: rootUp.y < 0,
    transform,
    partZOffset: b.min.z + tz - zStart,
  };
  return {
    placement, rotation,
    bendZ: [Math.min(p0.z, p1.z), Math.max(p0.z, p1.z)],
    bendZ01: [p0.z, p1.z],
    bounds: { min: { x: b.min.x - mr.x, y: b.min.y + thickness / 2 - mr.y, z: b.min.z + tz }, max: { x: b.max.x - mr.x, y: b.max.y + thickness / 2 - mr.y, z: b.max.z + tz } },
    parentFlangeId: link.parentFlangeId, childFlangeId: link.childFlangeId,
  };
}

export function computePlacement(
  part: PartModel, folded: FoldedGeometry, bendId: string, gaugedFlangeId: string, station: Pick<ToolStation, 'zStart' | 'zEnd'>, thickness: number,
): Placement {
  return computePlacementDetails(part, folded, bendId, gaugedFlangeId, station, thickness).placement;
}

/** Rotation angle (deg) of the 3×3 part of an affine matrix. */
export function rotationAngleDeg(m: Mat4): number {
  const trace = m[0]! + m[5]! + m[10]!;
  const c = Math.min(1, Math.max(-1, (trace - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

function rotationAxis(m: Mat4): Vec3 {
  // (row r, col c) = m[c*4 + r]; axis ∝ (R32 − R23, R13 − R31, R21 − R12)
  const a = { x: m[6]! - m[9]!, y: m[8]! - m[2]!, z: m[1]! - m[4]! };
  const l = vec3.length(a);
  if (l < 1e-9) {
    // 180° rotation: axis from the symmetric part (R + I)/2 columns
    const cols = [
      { x: m[0]! + 1, y: m[1]!, z: m[2]! }, { x: m[4]!, y: m[5]! + 1, z: m[6]! }, { x: m[8]!, y: m[9]!, z: m[10]! + 1 },
    ];
    let best = cols[0]!;
    for (const c of cols) if (vec3.length(c) > vec3.length(best)) best = c;
    return vec3.normalize(best);
  }
  return vec3.scale(a, 1 / l);
}

/** Relative rotations up to this angle (deg) count as 'none': re-tilting the part in the hands is not a flip. */
export const TURN_NONE_MAX_DEG = 45;

/**
 * Operator manipulation between two placements (PART → MACHINE transforms): the relative motion
 * R = next · prev⁻¹ of the root flange. 'none' up to TURN_NONE_MAX_DEG (a translation, or the
 * small re-tilt after a shallow bend); a larger rotation about the vertical axis is 'rotate180';
 * otherwise the closer of a 180° flip about Z ('flip-front-back') or X ('flip-end-for-end').
 */
export function classifyTurn(prev: Mat4, next: Mat4): Turn {
  const R = mat4.multiply(next, mat4.invert(prev));
  const angle = rotationAngleDeg(R);
  if (angle <= TURN_NONE_MAX_DEG) return 'none';
  const axis = rotationAxis(R);
  if (Math.abs(axis.y) > 0.9) return 'rotate180';
  const candidates: Array<[Turn, Mat4]> = [
    ['flip-front-back', mat4.fromAxisAngle({ x: 0, y: 0, z: 1 }, 180)],
    ['flip-end-for-end', mat4.fromAxisAngle({ x: 1, y: 0, z: 0 }, 180)],
    ['rotate180', mat4.fromAxisAngle({ x: 0, y: 1, z: 0 }, 180)],
  ];
  let best: Turn = 'flip-front-back', bestResidual = Infinity;
  for (const [turn, C] of candidates) {
    const residual = rotationAngleDeg(mat4.multiply(R, mat4.invert(C)));
    if (residual < bestResidual - 1e-6) { best = turn; bestResidual = residual; }
  }
  return best;
}
