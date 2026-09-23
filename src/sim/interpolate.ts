/**
 * sim-3d — keyframe interpolation (pure). See docs/specs/sim-3d.md §2.
 * Between adjacent keyframes: lerp ramY / fold fractions / finger settings / position, slerp the
 * quaternion, rebuild the transform with mat4.compose (never element-wise).
 */
import type { CollisionReport, FingerSetting, FoldState, Mat4, Quat, SimKeyframe, SimPhase, Vec3 } from '../core/types';
import { mat4, vec3 } from '../core/geom';

/** Interpolated state at a time of the timeline. */
export interface SimFrame {
  /** Index of the keyframe at or before the time (`keyframeIndexAt`). */
  index: number;
  /** Index of the keyframe the interpolation runs toward (index or index + 1). */
  nextIndex: number;
  /** Interpolation parameter between `index` and `nextIndex` (0 … 1). */
  u: number;
  stepIndex: number;
  phase: SimPhase;
  /** 0..1 within the phase (lerped). */
  phaseT: number;
  timeS: number;
  ramY: number;
  foldState: FoldState;
  partTransform: Mat4;
  pose: { position: Vec3; quaternion: Quat };
  backgauge: FingerSetting[];
  collisions: CollisionReport[];
}

export interface PhaseSegment {
  stepIndex: number;
  phase: SimPhase;
  /** First / last keyframe index of the run. */
  first: number;
  last: number;
  startTime: number;
  endTime: number;
}

/**
 * Index of the LAST keyframe with timeS ≤ t (0 before the start — also for NaN — and −1 for an
 * empty timeline). At a phase boundary, where two keyframes share a time, this is the first
 * keyframe of the new phase.
 */
export function keyframeIndexAt(keyframes: readonly SimKeyframe[], timeS: number): number {
  const n = keyframes.length;
  if (n === 0) return -1;
  if (!(timeS >= keyframes[0]!.timeS)) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keyframes[mid]!.timeS <= timeS) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Shortest-arc spherical interpolation of unit quaternions [x, y, z, w]; the result is normalised. */
export function slerpQuat(a: Quat, b: Quat, u: number): Quat {
  let [bx, by, bz, bw] = b;
  let cosom = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0: number, s1: number;
  if (1 - cosom > 1e-6) {
    const omega = Math.acos(Math.min(1, cosom)), so = Math.sin(omega);
    s0 = Math.sin((1 - u) * omega) / so;
    s1 = Math.sin(u * omega) / so;
  } else {
    s0 = 1 - u;
    s1 = u;
  }
  const q: Quat = [s0 * a[0] + s1 * bx, s0 * a[1] + s1 * by, s0 * a[2] + s1 * bz, s0 * a[3] + s1 * bw];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Per-bend lerp over the union of the two states' bend ids (a missing id counts as 0). */
export function lerpFoldState(a: FoldState, b: FoldState, u: number): FoldState {
  const out: FoldState = {};
  for (const id of Object.keys(a)) out[id] = (a[id] ?? 0) + ((b[id] ?? 0) - (a[id] ?? 0)) * u;
  for (const id of Object.keys(b)) if (!(id in out)) out[id] = (b[id] ?? 0) * u;
  return out;
}

/**
 * Per-finger lerp of x/r/z. An empty list yields the other one (fingers appear/disappear at once,
 * as in the timeline); other count mismatches ⇒ the nearer keyframe's list (copied).
 */
export function lerpFingers(a: FingerSetting[], b: FingerSetting[], u: number): FingerSetting[] {
  if (a.length === 0) return b.map(f => ({ ...f }));
  if (b.length === 0) return a.map(f => ({ ...f }));
  if (a.length !== b.length) return (u < 0.5 ? a : b).map(f => ({ ...f }));
  return a.map((fa, i) => {
    const fb = b[i]!;
    return { x: fa.x + (fb.x - fa.x) * u, r: fa.r + (fb.r - fa.r) * u, z: fa.z + (fb.z - fa.z) * u };
  });
}

type FrameData = Omit<SimFrame, 'index' | 'nextIndex' | 'u'>;

function keyframeData(k: SimKeyframe): FrameData {
  return {
    stepIndex: k.stepIndex, phase: k.phase, phaseT: k.t, timeS: k.timeS, ramY: k.ramY,
    foldState: k.foldState, partTransform: k.partTransform, pose: k.pose, backgauge: k.backgauge, collisions: k.collisions,
  };
}

/**
 * Interpolate between two keyframes (u clamped to [0, 1]; u ≤ 0 returns a's data, u ≥ 1 b's).
 * stepIndex/phase come from `a` for u < 1; collisions from the nearer keyframe.
 */
export function interpolateKeyframes(a: SimKeyframe, b: SimKeyframe, u: number): FrameData {
  if (!(u > 0)) return keyframeData(a);
  if (u >= 1) return keyframeData(b);
  const position = vec3.lerp(a.pose.position, b.pose.position, u);
  const quaternion = slerpQuat(a.pose.quaternion, b.pose.quaternion, u);
  return {
    stepIndex: a.stepIndex, phase: a.phase, phaseT: a.t + (b.t - a.t) * u,
    timeS: a.timeS + (b.timeS - a.timeS) * u,
    ramY: a.ramY + (b.ramY - a.ramY) * u,
    foldState: lerpFoldState(a.foldState, b.foldState, u),
    partTransform: mat4.compose(position, quaternion),
    pose: { position, quaternion },
    backgauge: lerpFingers(a.backgauge, b.backgauge, u),
    collisions: u < 0.5 ? a.collisions : b.collisions,
  };
}

/** The interpolated frame at a time (clamped to the timeline); null for an empty timeline. */
export function frameAt(keyframes: readonly SimKeyframe[], timeS: number): SimFrame | null {
  const i = keyframeIndexAt(keyframes, timeS);
  if (i < 0) return null;
  const a = keyframes[i]!;
  const j = i + 1 < keyframes.length ? i + 1 : i;
  const b = keyframes[j]!;
  const span = b.timeS - a.timeS;
  let u = span > 0 ? (timeS - a.timeS) / span : 0;
  if (!(u > 0)) u = 0; else if (u > 1) u = 1;
  const data = j === i ? keyframeData(a) : interpolateKeyframes(a, b, u);
  return { index: i, nextIndex: j, u, ...data };
}

/** Maximal runs of equal (stepIndex, phase). */
export function phaseSegments(keyframes: readonly SimKeyframe[]): PhaseSegment[] {
  const out: PhaseSegment[] = [];
  for (let i = 0; i < keyframes.length; i++) {
    const k = keyframes[i]!;
    const last = out[out.length - 1];
    if (last && last.stepIndex === k.stepIndex && last.phase === k.phase) {
      last.last = i;
      last.endTime = k.timeS;
    } else {
      out.push({ stepIndex: k.stepIndex, phase: k.phase, first: i, last: i, startTime: k.timeS, endTime: k.timeS });
    }
  }
  return out;
}

export function hasErrorCollision(k: SimKeyframe): boolean {
  return k.collisions.some(c => c.severity === 'error');
}

/** Identity of a collision report across keyframes (the timeline re-emits the planner's report objects). */
function reportKey(c: CollisionReport): string {
  return `${c.with}|${c.severity}|${c.atFraction}|${c.message.key}`;
}

/**
 * True when keyframe k carries an 'error' collision report that keyframe k − 1 does not carry
 * (compared by obstacle kind, severity, fraction and message key, so a second, distinct error
 * appearing while an earlier one persists also counts as new). k = 0 is new when it has an error.
 */
export function hasNewErrorCollision(keyframes: readonly SimKeyframe[], k: number): boolean {
  const cur = keyframes[k];
  if (!cur || !hasErrorCollision(cur)) return false;
  const prev = keyframes[k - 1];
  if (!prev) return true;
  const seen = new Set(prev.collisions.filter(c => c.severity === 'error').map(reportKey));
  return cur.collisions.some(c => c.severity === 'error' && !seen.has(reportKey(c)));
}

/**
 * First keyframe index in (fromExclusive, toInclusive] carrying an 'error' collision that the
 * previous keyframe did not carry (a NEW error, see hasNewErrorCollision), or −1.
 */
export function firstNewErrorKeyframe(keyframes: readonly SimKeyframe[], fromExclusive: number, toInclusive: number): number {
  const start = Math.max(0, fromExclusive + 1);
  const end = Math.min(keyframes.length - 1, toInclusive);
  for (let k = start; k <= end; k++) {
    if (hasNewErrorCollision(keyframes, k)) return k;
  }
  return -1;
}
