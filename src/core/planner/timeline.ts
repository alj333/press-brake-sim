/**
 * Simulation timeline (ARCHITECTURE "Bend-sequence planner" §7, docs/specs/planner.md §7):
 * per step the phases reposition → position → gauge → approach → bend → release → retract, ≥ 25
 * keyframes per phase, times from travel ÷ machine speeds, poses from bendPose.
 */
import type {
  BendProgram, BendStep, CollisionReport, FingerSetting, FoldState, Machine, Mat4, Material, PartModel, Quat, SimKeyframe, SimPhase, Vec3,
} from '../types';
import { mat4, vec3 } from '../geom';
import { actualInnerRadius, punchTipY } from '../bend';
import { finishedState, foldGeometry, partSilhouette } from '../part';
import { machineLevels } from '../machine';
import type { PlannerLibrary } from './context';
import { poseAtFraction } from './collision';

/** Keyframes per phase (t = 0 … 1 inclusive). */
export const KEYFRAMES_PER_PHASE = 25;
/** Maximum parked pose offset from the placement (mm): in front (−X) and above. The actual offset
 *  is scaled to the part (see parkOffsetFor) so small parts stay in the camera frame. */
export const PARK_OFFSET: Vec3 = { x: -300, y: 200, z: 0 };

/** Parked offset for a part of the given finished diagonal (mm): 0.6 × diag in front, 0.4 × diag up,
 *  clamped to [60, 300] × [40, 200]. */
export function parkOffsetFor(diag: number): Vec3 {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return { x: -clamp(0.6 * diag, 60, -PARK_OFFSET.x), y: clamp(0.4 * diag, 40, PARK_OFFSET.y), z: 0 };
}
/** Part handling speed (mm/s) and turn time (s). */
export const HANDLING_SPEED = 300;
export const TURN_TIME_S = 1.5;
/** The part stops this far in front of the fingers before the gauge slide (mm). */
export const GAUGE_APPROACH = 20;
/** Ram rise during the release phase (mm). */
export const RELEASE_RISE = 5;

interface Sample {
  ramY: number;
  foldState: FoldState;
  partTransform: Mat4;
  backgauge: FingerSetting[];
  collisions: CollisionReport[];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cosom = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0: number, s1: number;
  if (1 - cosom > 1e-6) {
    const omega = Math.acos(Math.min(1, cosom)), so = Math.sin(omega);
    s0 = Math.sin((1 - t) * omega) / so; s1 = Math.sin(t * omega) / so;
  } else { s0 = 1 - t; s1 = t; }
  const q: Quat = [s0 * a[0] + s1 * bx, s0 * a[1] + s1 * by, s0 * a[2] + s1 * bz, s0 * a[3] + s1 * bw];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Rigid interpolation between two transforms (position lerp, quaternion slerp). */
function lerpTransform(a: Mat4, b: Mat4, t: number): Mat4 {
  const da = mat4.decompose(a), db = mat4.decompose(b);
  return mat4.compose(vec3.lerp(da.position, db.position, t), slerp(da.quaternion, db.quaternion, t));
}

function lerpFingers(a: FingerSetting[], b: FingerSetting[], t: number): FingerSetting[] {
  if (a.length === 0) return b.map(f => ({ ...f }));
  if (b.length === 0) return a.map(f => ({ ...f }));
  return b.map((fb, i) => {
    const fa = a[Math.min(i, a.length - 1)]!;
    return { x: fa.x + (fb.x - fa.x) * t, r: fa.r + (fb.r - fa.r) * t, z: fa.z + (fb.z - fa.z) * t };
  });
}

/** Rotation about a point: T(c) · R · T(−c) applied to `m`. */
function rotateAbout(m: Mat4, centre: Vec3, axis: Vec3, deg: number): Mat4 {
  return mat4.multiply(mat4.rotationAxisAngle(centre, axis, deg), m);
}

export function buildTimeline(program: BendProgram, part: PartModel, material: Material, machine: Machine, library: PlannerLibrary): SimKeyframe[] {
  const t = program.thickness;
  const frames: SimKeyframe[] = [];
  let timeS = 0;
  const bendIds = part.flat.bends.map(b => b.id);
  const doneState = (done: Set<string>, current?: string, fraction = 0): FoldState => {
    const s: FoldState = {};
    for (const id of bendIds) s[id] = done.has(id) ? 1 : 0;
    if (current !== undefined) s[current] = fraction;
    return s;
  };
  const done = new Set<string>();
  const hemFraction = new Map<string, number>();   // hems: fraction reached by the pre-bend
  let prevRamY: number | null = null;
  let prevFingers: FingerSetting[] = [];
  let prevFinishedPose: Mat4 | null = null;

  const emit = (stepIndex: number, phase: SimPhase, seconds: number, at: (u: number) => Sample): void => {
    const n = KEYFRAMES_PER_PHASE;
    const dur = Math.max(seconds, 1e-3);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const s = at(u);
      const d = mat4.decompose(s.partTransform);
      frames.push({
        stepIndex, phase, t: u, timeS: timeS + dur * u,
        ramY: s.ramY, foldState: s.foldState, partTransform: s.partTransform,
        pose: { position: d.position, quaternion: d.quaternion },
        backgauge: s.backgauge, collisions: s.collisions,
      });
    }
    timeS += dur;
  };

  const finishedBounds = foldGeometry(part, finishedState(part)).bounds;
  const parkOffset = parkOffsetFor(Math.hypot(
    finishedBounds.max.x - finishedBounds.min.x,
    finishedBounds.max.y - finishedBounds.min.y,
    finishedBounds.max.z - finishedBounds.min.z,
  ));

  program.steps.forEach((step: BendStep, stepIndex) => {
    const bend = part.flat.bends.find(b => b.id === step.bendId);
    if (!bend) return;
    const punch = library.punches.find(p => p.id === step.punchId);
    const die = library.dies.find(d => d.id === step.dieId);
    const punchHeight = punch?.height ?? 120;
    const dieHeight = die?.height ?? 60;
    const levels = machineLevels(machine, dieHeight, punchHeight);
    const speeds = machine.ram.speeds;
    const placement = step.placement.transform;
    const isHem = step.kind === 'hem-flatten';
    const fStart = isHem ? (hemFraction.get(step.bendId) ?? 0) : 0;
    const fTarget = isHem ? 1 : step.targetAngle / bend.angle;
    const fOver = isHem ? 1 : step.overbendAngle / bend.angle;
    const V = die?.vWidth ?? 16, rs = die?.shoulderRadius ?? 0, vAngle = die?.vAngle ?? 88;
    const riActual = die && punch && V > 0 ? actualInnerRadius(V, material, t, punch.tipRadius) : step.actualInnerRadius;
    const foldedAt = (f: number) => foldGeometry(part, doneState(done, step.bendId, f));
    const collisionsAt = (f: number | null): CollisionReport[] => step.collisions.filter(c => (f === null ? c.atFraction <= 0 : c.atFraction <= f + 1e-9));
    const placementCollisions = collisionsAt(null);

    // tip height and pose for a fold fraction of the current bend
    const tipYAt = (f: number): number => {
      if (isHem) {
        const sil = partSilhouette(foldedAt(f), placement, t);
        let top = -Infinity;
        for (const p of sil) for (const v of p.polygon) if (v.y > top) top = v.y;
        return Number.isFinite(top) ? top : 2 * t;
      }
      return punchTipY(V, t, riActual, f * bend.angle, rs, vAngle);
    };
    const poseAt = (f: number): Mat4 => {
      if (isHem || f <= 1e-9) return placement;
      return poseAtFraction(placement, foldedAt(f), step.bendId, f, tipYAt(f), t);
    };
    const ramAt = (f: number): number => tipYAt(f) + punchHeight;

    const startState = doneState(done, step.bendId, fStart);
    const parked = mat4.multiply(mat4.translation(parkOffset), placement);
    const nearGauge = mat4.multiply(mat4.translationXYZ(-GAUGE_APPROACH, 0, 0), placement);
    const ramStart = prevRamY ?? levels.tdcClampY;
    const fingersPrev = prevFingers;

    // 1. reposition: rotate from the previous finished orientation about the part centre (parked)
    if (step.manipulation.turn !== 'none' && prevFinishedPose) {
      const from = prevFinishedPose;
      const rel = mat4.multiply(parked, mat4.invert(from));
      const foldedNow = foldGeometry(part, startState);
      const cPart = vec3.midpoint(foldedNow.bounds.min, foldedNow.bounds.max);
      const centre = mat4.applyToPoint(from, cPart);
      const parkedCentre = mat4.applyToPoint(parked, cPart);
      const [qx, qy, qz, qw] = mat4.decompose(rel).quaternion;
      const angle = (2 * Math.acos(Math.min(1, Math.abs(qw))) * 180) / Math.PI;
      const sl = Math.hypot(qx, qy, qz) || 1;
      const axis = { x: qx / sl, y: qy / sl, z: qz / sl };
      const signedAngle = qw < 0 ? -angle : angle;
      // rotate about the part centre while the centre glides to the parked position
      emit(stepIndex, 'reposition', TURN_TIME_S, u => {
        const rotated = rotateAbout(from, centre, axis, signedAngle * u);
        const cNow = vec3.lerp(centre, parkedCentre, u);
        const m = mat4.multiply(mat4.translation(vec3.sub(cNow, mat4.applyToPoint(rotated, cPart))), rotated);
        return { ramY: ramStart, foldState: startState, partTransform: m, backgauge: fingersPrev, collisions: [] };
      });
    }

    // 2. position: (previous finished pose →) parked → 20 mm in front of the placement
    const turned = step.manipulation.turn !== 'none' && prevFinishedPose !== null;
    const from: Mat4 = turned || !prevFinishedPose ? parked : prevFinishedPose;
    const lift = vec3.dist(mat4.getPosition(from), mat4.getPosition(parked));
    const travel = vec3.dist(mat4.getPosition(parked), mat4.getPosition(nearGauge));
    const total = lift + travel;
    emit(stepIndex, 'position', total / HANDLING_SPEED, u => {
      const dist = u * total;
      const m = lift > 1e-9 && dist < lift ? lerpTransform(from, parked, dist / lift) : lerpTransform(parked, nearGauge, travel > 1e-9 ? (dist - lift) / travel : 1);
      return { ramY: ramStart, foldState: startState, partTransform: m, backgauge: fingersPrev, collisions: [] };
    });

    // 3. gauge: fingers to the step setting, part slides +X to touch. A step without gauging
    //    (hem-flatten) leaves the fingers where they were.
    const stepFingers: FingerSetting[] = step.backgauge.length > 0 ? step.backgauge : fingersPrev.map(f => ({ ...f }));
    let fingerTravel = 0;
    stepFingers.forEach((f, i) => { const p = fingersPrev[Math.min(i, Math.max(0, fingersPrev.length - 1))]; if (p) fingerTravel = Math.max(fingerTravel, vec3.dist({ x: f.x, y: f.r, z: f.z }, { x: p.x, y: p.r, z: p.z })); });
    const gaugeTime = Math.max(fingerTravel / Math.max(1, machine.backgauge.speed), GAUGE_APPROACH / HANDLING_SPEED, 0.2);
    emit(stepIndex, 'gauge', gaugeTime, u => ({
      ramY: ramStart, foldState: startState, partTransform: lerpTransform(nearGauge, placement, u),
      backgauge: lerpFingers(fingersPrev, stepFingers, Math.min(1, u * 1.25)), collisions: u >= 1 ? placementCollisions : [],
    }));

    // 4. approach: ram down to the pinch (= punchTipY(fStart) + punch height, exactly where the bend phase starts;
    //    step.pinchY is the same number rounded to 0.01)
    const pinchRam = ramAt(fStart);
    emit(stepIndex, 'approach', Math.abs(ramStart - pinchRam) / Math.max(1, speeds.approach), u => ({
      ramY: ramStart + (pinchRam - ramStart) * u, foldState: startState, partTransform: placement, backgauge: stepFingers, collisions: placementCollisions,
    }));

    // 5. bend: fStart → fOver (fingers retract after the pinch only when this step gauged with them)
    const retract = step.backgauge.length > 0 ? machine.backgauge.retractAtPinch : 0;
    const retracted = stepFingers.map(f => ({ ...f, x: f.x + retract }));
    const bendTravel = Math.abs(ramAt(fOver) - pinchRam);
    emit(stepIndex, 'bend', Math.max(0.5, bendTravel / Math.max(0.1, speeds.bend)), u => {
      const f = fStart + (fOver - fStart) * u;
      const ff = u <= 0 ? fStart : f;
      const fingers = retract > 0 ? lerpFingers(stepFingers, retracted, Math.min(1, u / 0.1)) : stepFingers;
      // hem-flatten reports report the fold fraction itself; air-bend reports the fraction of the formed angle
      return { ramY: ramAt(ff), foldState: doneState(done, step.bendId, ff), partTransform: poseAt(ff), backgauge: fingers, collisions: collisionsAt(isHem ? ff : (ff - fStart) / Math.max(1e-9, fTarget - fStart)) };
    });

    // 6. release: springback (fOver → fTarget) while the ram rises RELEASE_RISE
    const ramBottom = ramAt(fOver);
    const fingersAfter = retract > 0 ? retracted : stepFingers;
    emit(stepIndex, 'release', RELEASE_RISE / Math.max(1, speeds.retract), u => {
      const f = fOver + (fTarget - fOver) * u;
      return { ramY: ramBottom + RELEASE_RISE * u, foldState: doneState(done, step.bendId, f), partTransform: poseAt(f), backgauge: fingersAfter, collisions: [] };
    });

    // 7. retract: ram to the upper limit
    const finished = poseAt(fTarget);
    const finishedState = doneState(done, step.bendId, fTarget);
    emit(stepIndex, 'retract', Math.abs(step.ramUpperLimit - (ramBottom + RELEASE_RISE)) / Math.max(1, speeds.retract), u => ({
      ramY: ramBottom + RELEASE_RISE + (step.ramUpperLimit - ramBottom - RELEASE_RISE) * u, foldState: finishedState, partTransform: finished, backgauge: fingersAfter, collisions: [],
    }));

    if (isHem || fTarget >= 1 - 1e-9) { done.add(step.bendId); hemFraction.delete(step.bendId); }
    else hemFraction.set(step.bendId, fTarget);
    prevRamY = step.ramUpperLimit;
    prevFingers = fingersAfter;
    prevFinishedPose = finished;
  });
  return frames;
}
