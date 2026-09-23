import { describe, it, expect } from 'vitest';
import { planProgram, buildTimeline } from '../core/planner';
import { sampleSetup } from '../core/planner/test-helpers';
import { mat4, vec3 } from '../core/geom';
import { SAMPLE_NAMES } from '../core/testing/fixtures';
import type { CollisionReport, Quat, SimKeyframe } from '../core/types';
import {
  frameAt, keyframeIndexAt, interpolateKeyframes, slerpQuat, lerpFoldState, lerpFingers, phaseSegments, hasErrorCollision,
  hasNewErrorCollision, firstNewErrorKeyframe,
} from './interpolate';

const s = sampleSetup('L-bracket');
const program = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
const frames = buildTimeline(program, s.part, s.material, s.machine, s.library);

function expectFrameEqualsKeyframe(i: number): void {
  const f = frameAt(frames, frames[i]!.timeS)!;
  // at a boundary time (two keyframes with one time) the frame is the FIRST keyframe of the new phase
  const j = keyframeIndexAt(frames, frames[i]!.timeS);
  if (i + 1 >= frames.length || frames[i + 1]!.timeS > frames[i]!.timeS) expect(j).toBe(i);
  expect(f.index).toBe(j);
  expect(f.u).toBe(0);
  const k = frames[j]!;
  expect(f.timeS).toBeCloseTo(k.timeS, 12);
  expect(f.stepIndex).toBe(k.stepIndex);
  expect(f.phase).toBe(k.phase);
  expect(f.collisions).toBe(k.collisions);
  expect(f.ramY).toBeCloseTo(k.ramY, 9);
  for (const id of Object.keys(k.foldState)) expect(f.foldState[id]).toBeCloseTo(k.foldState[id]!, 9);
  expect(mat4.equals(f.partTransform, k.partTransform, 1e-9)).toBe(true);
  expect(f.backgauge.length).toBe(k.backgauge.length);
  k.backgauge.forEach((g, j) => { expect(f.backgauge[j]!.x).toBeCloseTo(g.x, 9); expect(f.backgauge[j]!.r).toBeCloseTo(g.r, 9); expect(f.backgauge[j]!.z).toBeCloseTo(g.z, 9); });
}

describe('keyframeIndexAt', () => {
  it('clamps before the start and after the end, finds the last keyframe ≤ t', () => {
    expect(keyframeIndexAt([], 1)).toBe(-1);
    expect(keyframeIndexAt(frames, -5)).toBe(0);
    expect(keyframeIndexAt(frames, Number.NaN)).toBe(0);
    expect(keyframeIndexAt(frames, 1e9)).toBe(frames.length - 1);
    for (const i of [0, 7, 30, 100, frames.length - 1]) {
      const t = frames[i]!.timeS;
      const j = keyframeIndexAt(frames, t);
      expect(frames[j]!.timeS).toBeLessThanOrEqual(t);
      if (j + 1 < frames.length) expect(frames[j + 1]!.timeS).toBeGreaterThan(t);
    }
  });

  it('at a phase boundary (two keyframes with one time) it points at the new phase', () => {
    const b = frames.findIndex((k, i) => i > 0 && k.timeS === frames[i - 1]!.timeS && k.phase !== frames[i - 1]!.phase);
    expect(b).toBeGreaterThan(0);
    const j = keyframeIndexAt(frames, frames[b]!.timeS);
    expect(frames[j]!.phase).toBe(frames[b]!.phase);
    expect(j).toBeGreaterThanOrEqual(b);
  });
});

describe('frameAt', () => {
  it('a frame at a keyframe time equals the keyframe', () => {
    for (const i of [0, 1, 12, 24, 25, 60, 99, 130, frames.length - 1]) expectFrameEqualsKeyframe(i);
    expect(frameAt([], 0)).toBeNull();
  });

  it('the midpoint of two keyframes lerps ramY, fold fractions and the position', () => {
    // pick an interval inside the bend phase with a real change
    const i = frames.findIndex((k, j) => k.phase === 'bend' && j + 1 < frames.length && frames[j + 1]!.timeS > k.timeS + 1e-6 && frames[j + 1]!.ramY !== k.ramY);
    expect(i).toBeGreaterThan(0);
    const a = frames[i]!, b = frames[i + 1]!;
    const f = frameAt(frames, (a.timeS + b.timeS) / 2)!;
    expect(f.index).toBe(i);
    expect(f.nextIndex).toBe(i + 1);
    expect(f.u).toBeCloseTo(0.5, 9);
    expect(f.ramY).toBeCloseTo((a.ramY + b.ramY) / 2, 9);
    expect(f.foldState['B1']).toBeCloseTo((a.foldState['B1']! + b.foldState['B1']!) / 2, 9);
    expect(f.pose.position.x).toBeCloseTo((a.pose.position.x + b.pose.position.x) / 2, 9);
    expect(f.pose.position.y).toBeCloseTo((a.pose.position.y + b.pose.position.y) / 2, 9);
    expect(f.phaseT).toBeCloseTo((a.t + b.t) / 2, 9);
    expect(f.phase).toBe('bend');
    // the transform is rebuilt from the interpolated pose
    expect(mat4.equals(f.partTransform, mat4.compose(f.pose.position, f.pose.quaternion), 1e-12)).toBe(true);
    const l = Math.hypot(...f.pose.quaternion);
    expect(l).toBeCloseTo(1, 9);
  });

  it('collisions come from the nearer keyframe', () => {
    const c: CollisionReport = { with: 'punch', atFraction: 0.5, location: { x: 0, y: 0, z: 0 }, depth: 1, severity: 'error', message: { key: 'collisions.punch' } };
    const a = { ...frames[0]!, collisions: [] as CollisionReport[] };
    const b = { ...frames[0]!, timeS: frames[0]!.timeS + 1, collisions: [c] };
    expect(interpolateKeyframes(a, b, 0.25).collisions).toEqual([]);
    expect(interpolateKeyframes(a, b, 0.75).collisions).toEqual([c]);
    expect(interpolateKeyframes(a, b, 0).collisions).toBe(a.collisions);
    expect(interpolateKeyframes(a, b, 1).collisions).toBe(b.collisions);
  });
});

describe('helpers', () => {
  it('slerpQuat halves a 90° rotation and takes the shortest arc', () => {
    const q0: Quat = [0, 0, 0, 1];
    const s90 = Math.sin(Math.PI / 4);
    const q90: Quat = [0, s90, 0, Math.cos(Math.PI / 4)];
    const mid = slerpQuat(q0, q90, 0.5);
    expect(mid[1]).toBeCloseTo(Math.sin(Math.PI / 8), 9);
    expect(mid[3]).toBeCloseTo(Math.cos(Math.PI / 8), 9);
    // −q represents the same rotation: the interpolation must not go the long way round
    const midNeg = slerpQuat(q0, [-q90[0], -q90[1], -q90[2], -q90[3]], 0.5);
    expect(Math.abs(midNeg[1])).toBeCloseTo(Math.sin(Math.PI / 8), 9);
    expect(Math.abs(midNeg[3])).toBeCloseTo(Math.cos(Math.PI / 8), 9);
    expect(slerpQuat(q90, q90, 0.3)).toEqual(q90);
  });

  it('lerpFoldState covers the union of bend ids; lerpFingers handles different counts', () => {
    expect(lerpFoldState({ A: 0, B: 1 }, { A: 1 }, 0.25)).toEqual({ A: 0.25, B: 0.75 });
    expect(lerpFoldState({}, { C: 0.8 }, 0.5)).toEqual({ C: 0.4 });
    const a = [{ x: 0, r: 0, z: 0 }], b = [{ x: 10, r: -4, z: 100 }];
    expect(lerpFingers(a, b, 0.5)).toEqual([{ x: 5, r: -2, z: 50 }]);
    expect(lerpFingers([], b, 0.2)).toEqual(b);
    expect(lerpFingers(a, [], 0.2)).toEqual(a);
    expect(lerpFingers(a, [], 0.2)[0]).not.toBe(a[0]);
  });

  it('phaseSegments are contiguous, ordered and cover every keyframe', () => {
    const segs = phaseSegments(frames);
    expect(segs[0]!.first).toBe(0);
    expect(segs[segs.length - 1]!.last).toBe(frames.length - 1);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.first).toBe(segs[i - 1]!.last + 1);
      expect(segs[i]!.startTime).toBeGreaterThanOrEqual(segs[i - 1]!.endTime - 1e-12);
    }
    for (const seg of segs) {
      for (let i = seg.first; i <= seg.last; i++) { expect(frames[i]!.phase).toBe(seg.phase); expect(frames[i]!.stepIndex).toBe(seg.stepIndex); }
      expect(seg.startTime).toBe(frames[seg.first]!.timeS);
      expect(seg.endTime).toBe(frames[seg.last]!.timeS);
    }
    expect(segs.map(x => x.phase)).toEqual(['position', 'gauge', 'approach', 'bend', 'release', 'retract']);
    expect(phaseSegments([])).toEqual([]);
  });

  it('firstNewErrorKeyframe finds the first keyframe where an error appears', () => {
    const err: CollisionReport = { with: 'clamp', atFraction: 0.3, location: { x: 0, y: 0, z: 0 }, depth: 2, severity: 'error', message: { key: 'collisions.clamp' } };
    const warn: CollisionReport = { ...err, with: 'finger', severity: 'warning' };
    const mk = (i: number, c: CollisionReport[]): SimKeyframe => ({ ...frames[0]!, timeS: i, collisions: c });
    const ks = [mk(0, []), mk(1, [warn]), mk(2, [err]), mk(3, [err]), mk(4, []), mk(5, [err])];
    expect(hasErrorCollision(ks[1]!)).toBe(false);
    expect(hasErrorCollision(ks[2]!)).toBe(true);
    expect(firstNewErrorKeyframe(ks, -1, 5)).toBe(2);
    expect(firstNewErrorKeyframe(ks, 2, 5)).toBe(5);   // index 3 continues the same error
    expect(firstNewErrorKeyframe(ks, 0, 1)).toBe(-1);
    expect(firstNewErrorKeyframe(ks, 5, 99)).toBe(-1);
    expect(firstNewErrorKeyframe([mk(0, [err])], -1, 0)).toBe(0);
  });
});

// ─── Review additions ───────────────────────────────────────────────────────

describe('review: interpolation edge cases', () => {
  const mk = (i: number, extra: Partial<SimKeyframe> = {}): SimKeyframe => ({ ...frames[0]!, timeS: i, ...extra });

  it('a single-keyframe timeline: index 0 everywhere, the frame equals the keyframe, one phase segment', () => {
    const one = [frames[5]!];
    expect(keyframeIndexAt(one, -1)).toBe(0);
    expect(keyframeIndexAt(one, frames[5]!.timeS)).toBe(0);
    expect(keyframeIndexAt(one, 1e6)).toBe(0);
    const f = frameAt(one, 1e6)!;
    expect(f.index).toBe(0); expect(f.nextIndex).toBe(0); expect(f.u).toBe(0);
    expect(f.ramY).toBe(frames[5]!.ramY);
    expect(f.partTransform).toBe(frames[5]!.partTransform);
    expect(phaseSegments(one)).toEqual([{ stepIndex: frames[5]!.stepIndex, phase: frames[5]!.phase, first: 0, last: 0, startTime: frames[5]!.timeS, endTime: frames[5]!.timeS }]);
  });

  it('keyframeIndexAt is the LAST keyframe with timeS ≤ t, also when several keyframes share the start time', () => {
    const ks = [mk(0, { phase: 'position' }), mk(0, { phase: 'gauge' }), mk(1, { phase: 'approach' }), mk(1, { phase: 'bend' }), mk(2)];
    expect(keyframeIndexAt(ks, 0)).toBe(1);
    expect(keyframeIndexAt(ks, -0.5)).toBe(0);
    expect(keyframeIndexAt(ks, 0.5)).toBe(1);
    expect(keyframeIndexAt(ks, 1)).toBe(3);
    expect(keyframeIndexAt(ks, 2)).toBe(4);
    expect(keyframeIndexAt(ks, 3)).toBe(4);
    expect(keyframeIndexAt(ks, Number.NaN)).toBe(0);
    // frameAt at t = 0 therefore shows the gauge keyframe, at t = 0.5 it interpolates gauge → approach
    expect(frameAt(ks, 0)!.phase).toBe('gauge');
    const half = frameAt(ks, 0.5)!;
    expect(half.index).toBe(1); expect(half.nextIndex).toBe(2); expect(half.u).toBeCloseTo(0.5, 12);
    expect(half.phase).toBe('gauge');
  });

  it('a 180° turn between keyframes is halved to a 90° rotation about the same axis', () => {
    const q0: Quat = [0, 0, 0, 1];
    const q180: Quat = [0, 1, 0, 0];   // 180° about Y
    const mid = slerpQuat(q0, q180, 0.5);
    expect(Math.abs(mid[1])).toBeCloseTo(Math.SQRT1_2, 9);
    expect(Math.abs(mid[3])).toBeCloseTo(Math.SQRT1_2, 9);
    // rebuilding the transform from the interpolated quaternion gives a rigid matrix
    const m = mat4.compose({ x: 0, y: 0, z: 0 }, mid);
    const d = mat4.decompose(m);
    expect(d.scale.x).toBeCloseTo(1, 12); expect(d.scale.y).toBeCloseTo(1, 12); expect(d.scale.z).toBeCloseTo(1, 12);
    const x = mat4.applyToDir(m, { x: 1, y: 0, z: 0 });
    expect(Math.abs(x.z)).toBeCloseTo(1, 9);   // 90° about Y sends x to ∓z
    // u outside [0, 1] is not extrapolated by interpolateKeyframes
    const a = mk(0), b = mk(1);
    expect(interpolateKeyframes(a, b, -1)).toEqual(interpolateKeyframes(a, b, 0));
    expect(interpolateKeyframes(a, b, 2)).toEqual(interpolateKeyframes(a, b, 1));
    expect(interpolateKeyframes(a, b, Number.NaN)).toEqual(interpolateKeyframes(a, b, 0));
  });

  it('lerpFingers: count mismatch takes the nearer keyframe; lerpFoldState keeps ids of both states', () => {
    const a = [{ x: 0, r: 0, z: 0 }, { x: 10, r: 0, z: 100 }], b = [{ x: 50, r: 5, z: 500 }];
    expect(lerpFingers(a, b, 0.25)).toEqual(a);
    expect(lerpFingers(a, b, 0.75)).toEqual(b);
    expect(lerpFingers(a, b, 0.75)[0]).not.toBe(b[0]);
    expect(lerpFingers([], [], 0.5)).toEqual([]);
    expect(lerpFoldState({ A: 1 }, { B: 1 }, 0.5)).toEqual({ A: 0.5, B: 0.5 });
    expect(lerpFoldState({}, {}, 0.5)).toEqual({});
  });

  it('a reposition phase (hat-channel flip / rotate) interpolates rigidly and keeps the fold state fixed', () => {
    const h = sampleSetup('hat-channel');
    const prog = planProgram({ part: h.part, material: h.material, machine: h.machine, setup: h.setup, library: h.library });
    const ks = buildTimeline(prog, h.part, h.material, h.machine, h.library);
    const segs = phaseSegments(ks).filter(x => x.phase === 'reposition');
    expect(segs.length).toBeGreaterThan(0);
    expect(prog.steps.some(s => s.manipulation.turn !== 'none')).toBe(true);
    for (const seg of segs) {
      const state0 = ks[seg.first]!.foldState;
      for (let i = 0; i <= 40; i++) {
        const t = seg.startTime + ((seg.endTime - seg.startTime) * i) / 40;
        const f = frameAt(ks, t)!;
        expect(f.stepIndex).toBe(seg.stepIndex);
        if (t < seg.endTime) expect(f.phase).toBe('reposition');
        const d = mat4.decompose(f.partTransform);
        expect(d.scale.x).toBeCloseTo(1, 9); expect(d.scale.y).toBeCloseTo(1, 9); expect(d.scale.z).toBeCloseTo(1, 9);
        expect(Math.hypot(...f.pose.quaternion)).toBeCloseTo(1, 9);
        for (const id of Object.keys(state0)) expect(f.foldState[id]).toBeCloseTo(state0[id]!, 12);
      }
      // the turn really rotates the part: the orientation differs at both ends of the segment
      const qa = ks[seg.first]!.pose.quaternion, qb = ks[seg.last]!.pose.quaternion;
      const dot = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
      expect(dot).toBeLessThan(0.9);   // a turn of well over 50° (180° flip composed with the −θ/2 pose tilt)
    }
  });

  it('a dense sweep of every sample timeline stays finite, rigid, within the fold range and continuous', () => {
    for (const name of SAMPLE_NAMES) {
      const s2 = sampleSetup(name);
      const prog = planProgram({ part: s2.part, material: s2.material, machine: s2.machine, setup: s2.setup, library: s2.library });
      const ks = buildTimeline(prog, s2.part, s2.material, s2.machine, s2.library);
      const dur = ks[ks.length - 1]!.timeS;
      let prev = frameAt(ks, 0)!;
      const maxFold = Math.max(...ks.flatMap(k => Object.values(k.foldState)));
      for (let t = 0; t <= dur; t += 1 / 60) {
        const f = frameAt(ks, t)!;
        expect(Number.isFinite(f.ramY)).toBe(true);
        for (const v of f.partTransform) expect(Number.isFinite(v)).toBe(true);
        for (const v of Object.values(f.foldState)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(maxFold + 1e-12); }
        const d = mat4.decompose(f.partTransform);
        expect(Math.abs(d.scale.x - 1) + Math.abs(d.scale.y - 1) + Math.abs(d.scale.z - 1)).toBeLessThan(1e-9);
        // continuity: the part never moves faster than the handling speed (300 mm/s) + slack, the ram ≤ 100 mm/s
        expect(vec3.dist(f.pose.position, prev.pose.position)).toBeLessThan(300 / 60 + 1);
        expect(Math.abs(f.ramY - prev.ramY)).toBeLessThan(100 / 60 + 0.5);
        expect(f.timeS).toBeGreaterThanOrEqual(prev.timeS - 1e-12);
        prev = f;
      }
    }
  });

  it('hasNewErrorCollision / firstNewErrorKeyframe treat a second, distinct error as new while the first persists', () => {
    const err = (w: CollisionReport['with'], at: number): CollisionReport => ({ with: w, atFraction: at, location: { x: 0, y: 0, z: 0 }, depth: 1, severity: 'error', message: { key: `collisions.${w}` } });
    const warn: CollisionReport = { ...err('finger', 0.2), severity: 'warning' };
    const clamp = err('clamp', 0), die = err('die', 0.4);
    const ks = [mk(0, { collisions: [] }), mk(1, { collisions: [warn] }), mk(2, { collisions: [clamp] }), mk(3, { collisions: [clamp] }),
      mk(4, { collisions: [clamp, die] }), mk(5, { collisions: [{ ...clamp }, { ...die }] }), mk(6, { collisions: [] }), mk(7, { collisions: [die] })];
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(k => hasNewErrorCollision(ks, k))).toEqual([false, false, true, false, true, false, false, true]);
    expect(firstNewErrorKeyframe(ks, -1, 7)).toBe(2);
    expect(firstNewErrorKeyframe(ks, 2, 7)).toBe(4);   // the die error appears while the clamp error persists
    expect(firstNewErrorKeyframe(ks, 4, 7)).toBe(7);   // copies with the same identity are not new (keyframe 5)
    expect(firstNewErrorKeyframe(ks, 7, 99)).toBe(-1);
    expect(hasNewErrorCollision(ks, 99)).toBe(false);
    expect(hasNewErrorCollision([mk(0, { collisions: [warn] })], 0)).toBe(false);
  });
});
