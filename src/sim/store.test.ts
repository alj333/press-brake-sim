import { describe, it, expect, beforeEach } from 'vitest';
import { planProgram, buildTimeline } from '../core/planner';
import { sampleSetup } from '../core/planner/test-helpers';
import type { CollisionReport, SimKeyframe } from '../core/types';
import { useSimStore, currentFrame, simDuration, currentStepIndex, SPEED_MIN, SPEED_MAX } from './store';
import { phaseSegments } from './interpolate';

const s = sampleSetup('U-channel');
const program = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
const frames = buildTimeline(program, s.part, s.material, s.machine, s.library);
const duration = frames[frames.length - 1]!.timeS;

const err: CollisionReport = { with: 'clamp', atFraction: 0.3, location: { x: 0, y: 0, z: 0 }, depth: 2, severity: 'error', message: { key: 'collisions.clamp' } };
/** The same timeline with an error collision on the second half of the first bend phase. */
function withError(): { frames: SimKeyframe[]; firstError: number } {
  const bend = phaseSegments(frames).find(x => x.stepIndex === 0 && x.phase === 'bend')!;
  const firstError = bend.first + Math.floor((bend.last - bend.first) / 2);
  const out = frames.map((k, i) => (i >= firstError && i <= bend.last ? { ...k, collisions: [err] } : k));
  return { frames: out, firstError };
}

beforeEach(() => {
  useSimStore.setState({
    keyframes: [], timeS: 0, playing: false, speed: 1, continueOnCollision: false, showSection: false,
    cameraPreset: 'iso', cameraNonce: 0, pausedAtCollision: null,
  });
});

describe('useSimStore', () => {
  it('setKeyframes resets the cursor and pauses; play/pause/toggle', () => {
    const st = useSimStore.getState();
    st.play();
    expect(useSimStore.getState().playing).toBe(false);   // nothing to play
    st.setKeyframes(frames);
    expect(useSimStore.getState().timeS).toBe(0);
    expect(simDuration(useSimStore.getState())).toBeCloseTo(duration, 12);
    st.play();
    expect(useSimStore.getState().playing).toBe(true);
    st.pause();
    expect(useSimStore.getState().playing).toBe(false);
    st.toggle();
    expect(useSimStore.getState().playing).toBe(true);
    st.toggle();
    expect(useSimStore.getState().playing).toBe(false);
    st.setKeyframes(frames.slice(0, 30));
    expect(useSimStore.getState().playing).toBe(false);
    expect(useSimStore.getState().keyframes.length).toBe(30);
  });

  it('seekTime clamps, seekKeyframe / seekStep land on keyframe times, play at the end restarts', () => {
    const st = useSimStore.getState();
    st.setKeyframes(frames);
    st.seekTime(-3);
    expect(useSimStore.getState().timeS).toBe(0);
    st.seekTime(duration + 100);
    expect(useSimStore.getState().timeS).toBe(duration);
    st.play();
    expect(useSimStore.getState().timeS).toBe(0);
    expect(useSimStore.getState().playing).toBe(true);
    st.pause();
    st.seekKeyframe(40);
    expect(useSimStore.getState().timeS).toBe(frames[40]!.timeS);
    st.seekKeyframe(1e9);
    expect(useSimStore.getState().timeS).toBe(duration);
    st.seekStep(1);
    const seg1 = phaseSegments(frames).find(x => x.stepIndex === 1)!;
    expect(useSimStore.getState().timeS).toBe(seg1.startTime);
    expect(currentStepIndex(useSimStore.getState())).toBe(1);
    st.seekStep(99);
    expect(useSimStore.getState().timeS).toBe(seg1.startTime);
  });

  it('stepPhase walks the phase segments forward and back', () => {
    const st = useSimStore.getState();
    st.setKeyframes(frames);
    const segs = phaseSegments(frames);
    st.play();
    st.stepPhase(1);
    expect(useSimStore.getState().playing).toBe(false);
    expect(useSimStore.getState().timeS).toBe(segs[1]!.startTime);
    st.stepPhase(1);
    expect(useSimStore.getState().timeS).toBe(segs[2]!.startTime);
    // inside a segment: back goes to its start, then to the previous segment
    st.seekTime((segs[2]!.startTime + segs[2]!.endTime) / 2);
    st.stepPhase(-1);
    expect(useSimStore.getState().timeS).toBe(segs[2]!.startTime);
    st.stepPhase(-1);
    expect(useSimStore.getState().timeS).toBe(segs[1]!.startTime);
    // forward from the last segment ends at the duration; back from 0 stays at 0
    st.seekTime(segs[segs.length - 1]!.startTime);
    st.stepPhase(1);
    expect(useSimStore.getState().timeS).toBe(duration);
    st.seekTime(0);
    st.stepPhase(-1);
    expect(useSimStore.getState().timeS).toBe(0);
  });

  it('tick advances by dt·speed, stops at the end, speed is clamped', () => {
    const st = useSimStore.getState();
    st.setKeyframes(frames);
    st.tick(1);
    expect(useSimStore.getState().timeS).toBe(0);   // paused
    st.setSpeed(2);
    st.play();
    st.tick(0.5);
    expect(useSimStore.getState().timeS).toBeCloseTo(1, 12);
    st.tick(1e9);
    expect(useSimStore.getState().timeS).toBe(duration);
    expect(useSimStore.getState().playing).toBe(false);
    st.setSpeed(100);
    expect(useSimStore.getState().speed).toBe(SPEED_MAX);
    st.setSpeed(0);
    expect(useSimStore.getState().speed).toBe(SPEED_MIN);
    st.setSpeed(Number.NaN);
    expect(useSimStore.getState().speed).toBe(1);
  });

  it('tick pauses on the first new error collision, play continues past it, continueOnCollision skips the pause', () => {
    const { frames: ks, firstError } = withError();
    const st = useSimStore.getState();
    st.setKeyframes(ks);
    st.play();
    st.tick(1e9);
    let state = useSimStore.getState();
    expect(state.playing).toBe(false);
    expect(state.pausedAtCollision).toBe(firstError);
    expect(state.timeS).toBe(ks[firstError]!.timeS);
    expect(currentFrame(state)!.collisions).toEqual([err]);
    // resume: the same error is not new any more
    st.play();
    expect(useSimStore.getState().pausedAtCollision).toBeNull();
    st.tick(1e9);
    state = useSimStore.getState();
    expect(state.timeS).toBe(ks[ks.length - 1]!.timeS);
    expect(state.playing).toBe(false);
    // continueOnCollision: straight through
    st.setKeyframes(ks);
    st.setContinueOnCollision(true);
    st.play();
    st.tick(1e9);
    expect(useSimStore.getState().timeS).toBe(ks[ks.length - 1]!.timeS);
    expect(useSimStore.getState().pausedAtCollision).toBeNull();
  });

  it('currentFrame is memoised per (keyframes, timeS) and follows the cursor', () => {
    const st = useSimStore.getState();
    st.setKeyframes(frames);
    const a = currentFrame(useSimStore.getState());
    const b = currentFrame(useSimStore.getState());
    expect(a).toBe(b);
    expect(a!.stepIndex).toBe(0);
    st.seekTime(frames[10]!.timeS);
    const c = currentFrame(useSimStore.getState());
    expect(c).not.toBe(a);
    expect(c!.index).toBe(10);
    expect(currentFrame({ keyframes: [], timeS: 0 })).toBeNull();
  });

  it('camera preset changes bump the nonce; section toggle', () => {
    const st = useSimStore.getState();
    st.setCameraPreset('top');
    st.setCameraPreset('top');
    expect(useSimStore.getState().cameraPreset).toBe('top');
    expect(useSimStore.getState().cameraNonce).toBe(2);
    st.setShowSection(true);
    expect(useSimStore.getState().showSection).toBe(true);
  });
});

// ─── Review additions ───────────────────────────────────────────────────────

describe('review: store edge cases', () => {
  it('pauses once per distinct error: a second error appearing while the first persists pauses again', () => {
    const die: CollisionReport = { ...err, with: 'die', atFraction: 0.6, message: { key: 'collisions.die' } };
    const bend = phaseSegments(frames).find(x => x.stepIndex === 0 && x.phase === 'bend')!;
    const k1 = bend.first + 3, k2 = bend.first + 12;
    const ks = frames.map((k, i) => (i >= k2 && i <= bend.last ? { ...k, collisions: [err, die] } : i >= k1 && i <= bend.last ? { ...k, collisions: [err] } : k));
    const st = useSimStore.getState();
    st.setKeyframes(ks);
    st.play();
    st.tick(1e9);
    expect(useSimStore.getState().pausedAtCollision).toBe(k1);
    st.play();
    st.tick(1e9);
    expect(useSimStore.getState().pausedAtCollision).toBe(k2);
    expect(useSimStore.getState().timeS).toBe(ks[k2]!.timeS);
    st.play();
    st.tick(1e9);
    expect(useSimStore.getState().pausedAtCollision).toBeNull();
    expect(useSimStore.getState().timeS).toBe(duration);
    // seeking back before the first error and playing pauses there again; a seek clears the pause marker
    st.seekTime(0);
    expect(useSimStore.getState().pausedAtCollision).toBeNull();
    st.play();
    st.tick(1e9);
    expect(useSimStore.getState().pausedAtCollision).toBe(k1);
    // the cursor never overshoots the requested time: a small tick short of the error keyframe does not pause
    st.setKeyframes(ks);
    st.play();
    const before = ks[k1]!.timeS - 0.01;
    st.tick(before);
    expect(useSimStore.getState().timeS).toBeCloseTo(before, 12);
    expect(useSimStore.getState().playing).toBe(true);
    st.tick(0.02);
    expect(useSimStore.getState().timeS).toBe(ks[k1]!.timeS);
    expect(useSimStore.getState().playing).toBe(false);
  });

  it('invalid inputs: NaN / negative seek → 0, NaN / negative / zero dt ignored, setKeyframes([]) resets everything', () => {
    const st = useSimStore.getState();
    st.setKeyframes(frames);
    st.seekTime(Number.NaN);
    expect(useSimStore.getState().timeS).toBe(0);
    st.seekTime(2);
    st.play();
    st.tick(Number.NaN); st.tick(-1); st.tick(0);
    expect(useSimStore.getState().timeS).toBe(2);
    expect(useSimStore.getState().playing).toBe(true);
    st.seekTime(3);                       // seeking while playing keeps playing
    expect(useSimStore.getState().playing).toBe(true);
    expect(useSimStore.getState().timeS).toBe(3);
    st.setKeyframes([]);
    const s = useSimStore.getState();
    expect(s.timeS).toBe(0); expect(s.playing).toBe(false); expect(s.pausedAtCollision).toBeNull();
    expect(simDuration(s)).toBe(0);
    expect(currentStepIndex(s)).toBe(-1);
    expect(currentFrame(s)).toBeNull();
    st.seekTime(5); st.seekKeyframe(3); st.seekStep(0); st.stepPhase(1); st.stepPhase(-1); st.tick(1);
    expect(useSimStore.getState().timeS).toBe(0);
    st.play();
    expect(useSimStore.getState().playing).toBe(false);
  });

  it('stepPhase on a single-segment timeline and seekStep on a step that starts with a reposition', () => {
    const st = useSimStore.getState();
    const seg0 = phaseSegments(frames)[0]!;
    st.setKeyframes(frames.slice(seg0.first, seg0.last + 1));
    st.stepPhase(1);
    expect(useSimStore.getState().timeS).toBe(seg0.endTime);
    st.stepPhase(-1);
    expect(useSimStore.getState().timeS).toBe(seg0.startTime);
    st.stepPhase(-1);
    expect(useSimStore.getState().timeS).toBe(seg0.startTime);
    // a reposition phase belongs to the step it prepares: seekStep lands on it
    const h = sampleSetup('hat-channel');
    const hp = planProgram({ part: h.part, material: h.material, machine: h.machine, setup: h.setup, library: h.library });
    const hk = buildTimeline(hp, h.part, h.material, h.machine, h.library);
    const rep = phaseSegments(hk).find(x => x.phase === 'reposition')!;
    st.setKeyframes(hk);
    st.seekStep(rep.stepIndex);
    expect(useSimStore.getState().timeS).toBe(rep.startTime);
    expect(currentStepIndex(useSimStore.getState())).toBe(rep.stepIndex);
    expect(currentFrame(useSimStore.getState())!.phase).toBe('reposition');
    // stepping back from the first keyframe of that step goes to the previous step's last phase
    st.stepPhase(-1);
    const segs = phaseSegments(hk);
    const prev = segs[segs.findIndex(x => x.first === rep.first) - 1]!;
    expect(useSimStore.getState().timeS).toBe(prev.startTime);
    expect(currentStepIndex(useSimStore.getState())).toBe(rep.stepIndex - 1);
  });

  it('play at the last keyframe restarts; tick lands exactly on the duration and pauses; speed accepted as given', () => {
    const st = useSimStore.getState();
    st.setKeyframes(frames);
    st.seekTime(duration - 0.005);
    st.setSpeed(0.5);
    st.play();
    expect(useSimStore.getState().playing).toBe(true);
    expect(useSimStore.getState().timeS).toBeCloseTo(duration - 0.005, 12);
    st.tick(0.5);
    expect(useSimStore.getState().timeS).toBe(duration);
    expect(useSimStore.getState().playing).toBe(false);
    st.play();
    expect(useSimStore.getState().timeS).toBe(0);
    st.setSpeed(3);
    expect(useSimStore.getState().speed).toBe(3);
  });
});
