/**
 * Backgauge finger generators. Profiles are closed CCW polygons in the finger frame: origin at
 * the bottom of the stop face, the stop face is (0,0)–(0,stopHeight), the body extends toward
 * +X, y ∈ [0, height]. See docs/specs/tooling-machine.md §1.3.
 */
import type { Finger, ToolSource, Vec2 } from '../types';
import { finishProfile } from './profile';

export interface FingerMeta {
  id?: string;
  name?: string;
  maxLoadPerMeter?: number;
  notes?: string;
  source?: ToolSource;
}

function makeFinger(points: Vec2[], p: { stopHeight: number; bodyDepth: number; width: number; height: number }, meta: FingerMeta, defaultId: string, defaultName: string): Finger {
  return {
    kind: 'finger',
    id: meta.id ?? defaultId,
    name: meta.name ?? defaultName,
    source: meta.source ?? 'standard',
    height: p.height,
    maxLoadPerMeter: meta.maxLoadPerMeter ?? 0,
    segmentLengths: [],
    profile: finishProfile(points),
    stopHeight: p.stopHeight,
    bodyDepth: p.bodyDepth,
    width: p.width,
    ...(meta.notes !== undefined ? { notes: meta.notes } : {}),
  };
}

export interface FlatFingerParams { stopHeight?: number; bodyDepth?: number; width?: number; height?: number }

/** Standard flat finger: stop face 20 high, 45° chamfer up to the 35 high body, 60 deep, 30 wide. */
export function flatFinger(params: FlatFingerParams = {}, meta: FingerMeta = {}): Finger {
  const stopHeight = params.stopHeight ?? 20, bodyDepth = params.bodyDepth ?? 60, width = params.width ?? 30;
  const height = Math.max(params.height ?? 35, stopHeight);
  const chamfer = Math.min(height - stopHeight, bodyDepth / 2);
  const points: Vec2[] = chamfer > 1e-9
    ? [{ x: 0, y: 0 }, { x: bodyDepth, y: 0 }, { x: bodyDepth, y: height }, { x: chamfer, y: height }, { x: 0, y: stopHeight }]
    : [{ x: 0, y: 0 }, { x: bodyDepth, y: 0 }, { x: bodyDepth, y: height }, { x: 0, y: height }];
  return makeFinger(points, { stopHeight, bodyDepth, width, height }, meta, 'std:finger-flat', `Flat finger ${stopHeight}/${height} × ${bodyDepth}`);
}

export interface SteppedFingerParams { stopHeight?: number; stepDepth?: number; height?: number; bodyDepth?: number; width?: number }

/** Stepped finger (samples/tools/custom-finger.dxf shape): a 25 mm step at the stop-face top, then a 35 high body. */
export function steppedFinger(params: SteppedFingerParams = {}, meta: FingerMeta = {}): Finger {
  const stopHeight = params.stopHeight ?? 20, stepDepth = params.stepDepth ?? 25, bodyDepth = params.bodyDepth ?? 60, width = params.width ?? 30;
  const height = Math.max(params.height ?? 35, stopHeight);
  const points: Vec2[] = [
    { x: 0, y: 0 }, { x: bodyDepth, y: 0 }, { x: bodyDepth, y: height }, { x: stepDepth, y: height }, { x: stepDepth, y: stopHeight }, { x: 0, y: stopHeight },
  ];
  return makeFinger(points, { stopHeight, bodyDepth, width, height }, meta, 'std:finger-stepped', `Stepped finger ${stopHeight}/${height} × ${bodyDepth}`);
}
