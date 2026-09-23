/**
 * sim-3d — playback store (zustand). See docs/specs/sim-3d.md §1.
 * Holds the timeline (SimKeyframe[] from the planner's buildTimeline), the time cursor and the
 * viewer options; `currentFrame` interpolates between adjacent keyframes (memoised).
 */
import { create } from 'zustand';
import type { SimKeyframe } from '../core/types';
import { frameAt, firstNewErrorKeyframe, keyframeIndexAt, phaseSegments } from './interpolate';
import type { SimFrame } from './interpolate';

export type CameraPreset = 'iso' | 'front' | 'side' | 'top';

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

export interface SimState {
  keyframes: SimKeyframe[];
  /** Time cursor (s), 0 … duration. */
  timeS: number;
  playing: boolean;
  /** Playback speed (× real time), SPEED_MIN … SPEED_MAX. */
  speed: number;
  /** Keep playing through 'error' collisions instead of pausing on the first one. */
  continueOnCollision: boolean;
  showSection: boolean;
  cameraPreset: CameraPreset;
  /** Bumped by every setCameraPreset so re-selecting the same preset re-frames the camera. */
  cameraNonce: number;
  /** Keyframe index of the last automatic collision pause (null = none). */
  pausedAtCollision: number | null;
}

export interface SimActions {
  setKeyframes(frames: SimKeyframe[]): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seekTime(timeS: number): void;
  seekKeyframe(index: number): void;
  seekStep(stepIndex: number): void;
  stepPhase(dir: 1 | -1): void;
  setSpeed(speed: number): void;
  setContinueOnCollision(on: boolean): void;
  setShowSection(on: boolean): void;
  setCameraPreset(preset: CameraPreset): void;
  /** Advance the cursor by dtS · speed while playing (called from the render loop). */
  tick(dtS: number): void;
}

export type SimStore = SimState & SimActions;

/** Total timeline duration (s): the last keyframe's time, 0 when empty. */
export function simDuration(state: Pick<SimState, 'keyframes'>): number {
  const k = state.keyframes;
  return k.length ? k[k.length - 1]!.timeS : 0;
}

let memo: { keyframes: SimKeyframe[]; timeS: number; frame: SimFrame | null } | null = null;

/** Interpolated frame at the cursor (memoised on the keyframes array identity and the time). */
export function currentFrame(state: Pick<SimState, 'keyframes' | 'timeS'>): SimFrame | null {
  if (memo && memo.keyframes === state.keyframes && memo.timeS === state.timeS) return memo.frame;
  const frame = frameAt(state.keyframes, state.timeS);
  memo = { keyframes: state.keyframes, timeS: state.timeS, frame };
  return frame;
}

/** Program step at the cursor (−1 without keyframes). */
export function currentStepIndex(state: Pick<SimState, 'keyframes' | 'timeS'>): number {
  const i = keyframeIndexAt(state.keyframes, state.timeS);
  return i < 0 ? -1 : state.keyframes[i]!.stepIndex;
}

function clampTime(state: Pick<SimState, 'keyframes'>, timeS: number): number {
  const d = simDuration(state);
  if (!(timeS > 0)) return 0;
  return timeS > d ? d : timeS;
}

export const useSimStore = create<SimStore>()((set, get) => ({
  keyframes: [],
  timeS: 0,
  playing: false,
  speed: 1,
  continueOnCollision: false,
  showSection: false,
  cameraPreset: 'iso',
  cameraNonce: 0,
  pausedAtCollision: null,

  setKeyframes: frames => set({ keyframes: frames, timeS: 0, playing: false, pausedAtCollision: null }),

  play: () => {
    const s = get();
    if (s.keyframes.length === 0) return;
    const d = simDuration(s);
    set({ playing: true, timeS: s.timeS >= d - 1e-9 ? 0 : s.timeS, pausedAtCollision: null });
  },
  pause: () => set({ playing: false }),
  toggle: () => { if (get().playing) get().pause(); else get().play(); },

  seekTime: timeS => set(s => ({ timeS: clampTime(s, timeS), pausedAtCollision: null })),
  seekKeyframe: index => set(s => {
    if (s.keyframes.length === 0) return {};
    const i = Math.min(s.keyframes.length - 1, Math.max(0, Math.floor(index)));
    return { timeS: s.keyframes[i]!.timeS, pausedAtCollision: null };
  }),
  seekStep: stepIndex => set(s => {
    const seg = phaseSegments(s.keyframes).find(x => x.stepIndex === stepIndex);
    return seg ? { timeS: seg.startTime, pausedAtCollision: null } : {};
  }),
  stepPhase: dir => set(s => {
    const segs = phaseSegments(s.keyframes);
    if (segs.length === 0) return {};
    const idx = keyframeIndexAt(s.keyframes, s.timeS);
    let cur = segs.findIndex(seg => idx >= seg.first && idx <= seg.last);
    if (cur < 0) cur = 0;
    let timeS: number;
    if (dir > 0) {
      timeS = cur + 1 < segs.length ? segs[cur + 1]!.startTime : simDuration(s);
    } else {
      const seg = segs[cur]!;
      timeS = s.timeS > seg.startTime + 1e-6 ? seg.startTime : segs[Math.max(0, cur - 1)]!.startTime;
    }
    return { timeS, playing: false, pausedAtCollision: null };
  }),

  setSpeed: speed => set({ speed: Number.isFinite(speed) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)) : 1 }),
  setContinueOnCollision: on => set({ continueOnCollision: on }),
  setShowSection: on => set({ showSection: on }),
  setCameraPreset: preset => set(s => ({ cameraPreset: preset, cameraNonce: s.cameraNonce + 1 })),

  tick: dtS => {
    const s = get();
    if (!s.playing || !(dtS > 0) || s.keyframes.length === 0) return;
    const d = simDuration(s);
    const t1 = Math.min(s.timeS + dtS * s.speed, d);
    if (!s.continueOnCollision) {
      const i0 = keyframeIndexAt(s.keyframes, s.timeS);
      const i1 = keyframeIndexAt(s.keyframes, t1);
      const k = firstNewErrorKeyframe(s.keyframes, i0, i1);
      if (k >= 0) {
        set({ timeS: s.keyframes[k]!.timeS, playing: false, pausedAtCollision: k });
        return;
      }
    }
    if (t1 >= d) set({ timeS: d, playing: false });
    else set({ timeS: t1 });
  },
}));
