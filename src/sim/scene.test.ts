import { describe, it, expect } from 'vitest';
import { loadTruth, SAMPLE_NAMES } from '../core/testing/fixtures';
import { buildPartModel, foldGeometry, finishedState, partBoundsFolded } from '../core/part';
import { buildStandardLibrary } from '../core/tools';
import { defaultMachine, machineLevels } from '../core/machine';
import { mat4, vec3 } from '../core/geom';
import type { BendStep, CollisionReport, FlatPattern, ToolSetup, ToolStation } from '../core/types';
import {
  idleFrame, idleRotation, punchPieces, formatTime, collisionKinds, toolStack, stationCentreZ, stationOf, stepOf, sceneFrameOf, EMPTY_SETUP,
} from './scene';
import { frameAt } from './interpolate';
import { defaultT, withFallback, simLabelsEn } from './labels';
import { planProgram, buildTimeline } from '../core/planner';
import { sampleSetup } from '../core/planner/test-helpers';

const library = buildStandardLibrary();
const machine = defaultMachine();

describe('idleFrame', () => {
  it('lays every sample finished on the die plane: lowest point at Y = 0, X centred, Z at the bed centre, top face up', () => {
    for (const name of SAMPLE_NAMES) {
      const tr = loadTruth(name);
      const part = buildPartModel(tr.flat);
      const f = idleFrame(part, machine, EMPTY_SETUP, library);
      expect(f.stepIndex).toBe(-1);
      expect(f.phase).toBeNull();
      expect(f.backgauge).toEqual([]);
      expect(f.collisions).toEqual([]);
      expect(f.foldState).toEqual(finishedState(part));
      const b = partBoundsFolded(foldGeometry(part, f.foldState), tr.flat.thickness, f.partTransform);
      expect(b.min.y).toBeCloseTo(0, 6);
      expect(b.min.x + b.max.x).toBeCloseTo(0, 6);
      expect((b.min.z + b.max.z) / 2).toBeCloseTo(machine.bedLength / 2, 6);
      // rigid, right-handed, root top face (+w) → +Y
      const d = mat4.decompose(f.partTransform);
      expect(d.scale.x).toBeCloseTo(1, 9); expect(d.scale.y).toBeCloseTo(1, 9); expect(d.scale.z).toBeCloseTo(1, 9);
      const w = mat4.applyToDir(f.partTransform, { x: 0, y: 0, z: 1 });
      expect(w.y).toBeCloseTo(1, 9);
      // the longest bend line runs along the bed (Z)
      const longest = tr.flat.bends.reduce((a, b) => (Math.hypot(b.p1.x - b.p0.x, b.p1.y - b.p0.y) > Math.hypot(a.p1.x - a.p0.x, a.p1.y - a.p0.y) ? b : a));
      const dir = mat4.applyToDir(f.partTransform, { x: longest.p1.x - longest.p0.x, y: longest.p1.y - longest.p0.y, z: 0 });
      expect(Math.abs(dir.x)).toBeLessThan(1e-6);
      expect(Math.abs(dir.y)).toBeLessThan(1e-6);
      expect(Math.abs(dir.z)).toBeGreaterThan(1);
    }
  });

  it('ram at TDC for the mounted stack (defaults 60 / 120 without stations); no part ⇒ identity', () => {
    const f0 = idleFrame(null, machine, EMPTY_SETUP, library);
    expect(f0.partTransform).toEqual(mat4.identity());
    expect(f0.ramY).toBe(machineLevels(machine, 60, 120).tdcClampY);
    expect(f0.foldState).toEqual({});
    const s = sampleSetup('L-bracket');
    const die = library.dies.find(d => d.id === s.setup.stations[0]!.dieId)!;
    const punch = library.punches.find(p => p.id === s.setup.stations[0]!.punchId)!;
    expect(toolStack(s.setup, library)).toEqual({ dieHeight: die.height, punchHeight: punch.height });
    expect(idleFrame(s.part, machine, s.setup, library).ramY).toBe(machineLevels(machine, die.height, punch.height).tdcClampY);
    // unknown tool ids fall back to the defaults
    const bogus: ToolSetup = { machineId: machine.id, stations: [{ ...s.setup.stations[0]!, punchId: 'nope', dieId: 'nope' }] };
    expect(toolStack(bogus, library)).toEqual({ dieHeight: 60, punchHeight: 120 });
  });

  it('a flat plate without bends gets the plain u → Z rotation and still lies on the plane', () => {
    const tr = loadTruth('L-bracket');
    const flat: FlatPattern = { ...tr.flat, bends: [], holes: [] };
    const part = buildPartModel(flat);
    expect(part.flat.bends.length).toBe(0);
    const r = idleRotation(part);
    expect(mat4.applyToDir(r, { x: 1, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(mat4.applyToDir(r, { x: 0, y: 0, z: 1 })).toEqual({ x: 0, y: 1, z: 0 });
    const f = idleFrame(part, machine, EMPTY_SETUP, library);
    const b = partBoundsFolded(foldGeometry(part, f.foldState), flat.thickness, f.partTransform);
    expect(b.min.y).toBeCloseTo(0, 9);
    expect(b.max.y).toBeCloseTo(flat.thickness, 9);
  });
});

describe('scene helpers', () => {
  const s = sampleSetup('U-channel');
  const program = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
  const frames = buildTimeline(program, s.part, s.material, s.machine, s.library);

  it('stepOf / stationOf / stationCentreZ / sceneFrameOf follow the frame', () => {
    const sf = sceneFrameOf(frameAt(frames, frames[frames.length - 1]!.timeS)!);
    expect(sf.stepIndex).toBe(program.steps.length - 1);
    expect(sf.phase).toBe('retract');
    const step = stepOf(program, sf)!;
    expect(step.index).toBe(program.steps.length - 1);
    const st = stationOf(program.setup, step)!;
    expect(st.id).toBe(step.stationId);
    expect(stationCentreZ(st, machine)).toBe((st.zStart + st.zEnd) / 2);
    expect(stationCentreZ(undefined, machine)).toBe(machine.bedLength / 2);
    const idle = idleFrame(s.part, machine, s.setup, library);
    expect(stepOf(program, idle)).toBeUndefined();
    expect(stepOf(null, sf)).toBeUndefined();
    expect(stationOf(program.setup, undefined)).toBeUndefined();
  });

  it('punchPieces: the step piece is centred in the station, station segments otherwise, reversed Z handled', () => {
    const st: ToolStation = { id: 'S', punchId: 'p', dieId: 'd', zStart: 100, zEnd: 1100, segments: [400, 300], punchFlipped: false, dieFlipped: false };
    expect(punchPieces(st, undefined)).toEqual([{ z0: 100, z1: 500 }, { z0: 500, z1: 800 }]);
    const noSeg = { ...st, segments: [] };
    expect(punchPieces(noSeg, undefined)).toEqual([{ z0: 100, z1: 1100 }]);
    const reversed = { ...st, zStart: 1100, zEnd: 100 };
    expect(punchPieces(reversed, undefined)).toEqual([{ z0: 100, z1: 500 }, { z0: 500, z1: 800 }]);
    const step = { ...program.steps[0]!, stationId: 'S', punchLength: 200, segments: [150, 50] } as BendStep;
    expect(punchPieces(st, step)).toEqual([{ z0: 500, z1: 650 }, { z0: 650, z1: 700 }]);
    const stepNoSeg = { ...step, segments: [] };
    expect(punchPieces(st, stepNoSeg)).toEqual([{ z0: 500, z1: 700 }]);
    // a step on another station does not affect this one; zero-length pieces are dropped
    expect(punchPieces(st, { ...step, stationId: 'other' })).toEqual(punchPieces(st, undefined));
    expect(punchPieces({ ...st, segments: [0, 400] }, undefined)).toEqual([{ z0: 100, z1: 500 }]);
    // the real program: the piece covers the bend line at the station centre
    const real = program.steps[0]!;
    const realSt = stationOf(program.setup, real)!;
    const pieces = punchPieces(realSt, real);
    const total = pieces.reduce((a, p) => a + (p.z1 - p.z0), 0);
    expect(total).toBeCloseTo(real.punchLength, 6);
    expect(pieces[0]!.z0).toBeLessThanOrEqual(stationCentreZ(realSt, machine));
    expect(pieces[pieces.length - 1]!.z1).toBeGreaterThanOrEqual(stationCentreZ(realSt, machine));
  });

  it('formatTime rounds to tenths without overflowing the seconds field', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(4.44)).toBe('0:04.4');
    expect(formatTime(59.94)).toBe('0:59.9');
    expect(formatTime(59.96)).toBe('1:00.0');
    expect(formatTime(65.25)).toBe('1:05.3');
    expect(formatTime(600)).toBe('10:00.0');
    expect(formatTime(-3)).toBe('0:00.0');
    expect(formatTime(Number.NaN)).toBe('0:00.0');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00.0');
  });

  it('collisionKinds collects the obstacle kinds once', () => {
    const c = (w: CollisionReport['with']): CollisionReport => ({ with: w, atFraction: 0, location: { x: 0, y: 0, z: 0 }, depth: 1, severity: 'error', message: { key: `collisions.${w}` } });
    expect([...collisionKinds([c('die'), c('die'), c('finger')])].sort()).toEqual(['die', 'finger']);
    expect(collisionKinds([]).size).toBe(0);
  });

  it('the idle frame and the first keyframe both put the part on the die plane (rigid transforms only)', () => {
    const f = frameAt(frames, 0)!;
    const d = mat4.decompose(f.partTransform);
    expect(vec3.length(d.scale)).toBeCloseTo(Math.sqrt(3), 9);
    expect(mat4.equals(mat4.compose(d.position, d.quaternion), f.partTransform, 1e-9)).toBe(true);
  });
});

describe('labels', () => {
  it('defaultT interpolates params and returns unknown keys unchanged', () => {
    expect(defaultT('sim.play')).toBe('Play');
    expect(defaultT('sim.step', { index: 2, bendId: 'B1' })).toBe('Step 2 · B1');
    expect(defaultT('sim.finger', { index: 1, x: '58.3', r: '-9.0', z: 1530 })).toBe('Finger 1: X 58.3 R -9.0 Z 1530');
    expect(defaultT('sim.ramY')).toBe('Ram Y {y}');           // missing param stays visible
    expect(defaultT('collisions.die', { depth: 3 })).toBe('collisions.die');
  });

  it('withFallback uses the English default when the ui translator returns the key or nothing', () => {
    const th = withFallback((k, p) => (k === 'sim.play' ? 'เล่น' : k === 'sim.pause' ? '' : k === 'sim.step' ? `ขั้นที่ ${p?.['index']}` : k));
    expect(th('sim.play')).toBe('เล่น');
    expect(th('sim.pause')).toBe('Pause');
    expect(th('sim.step', { index: 3, bendId: 'B2' })).toBe('ขั้นที่ 3');
    expect(th('sim.phase.bend')).toBe('Bend');
    expect(th('collisions.clamp')).toBe('collisions.clamp');   // not a sim key: the caller falls back itself
    expect(withFallback(undefined)).toBe(defaultT);
  });

  it('every key the components use has an English default', () => {
    const phases = ['position', 'gauge', 'approach', 'bend', 'release', 'retract', 'reposition'];
    const turns = ['none', 'rotate180', 'flip-front-back', 'flip-end-for-end'];
    const keys = [
      'sim.play', 'sim.pause', 'sim.stepBack', 'sim.stepForward', 'sim.speed', 'sim.continueOnCollision', 'sim.section', 'sim.camera',
      'sim.camera.iso', 'sim.camera.front', 'sim.camera.side', 'sim.camera.top', 'sim.steps', 'sim.step', 'sim.stepKind.bend',
      'sim.stepKind.hem-flatten', 'sim.noProgram', 'sim.pausedOnCollision', 'sim.collisions', 'sim.time', 'sim.operator', 'sim.backgauge',
      'sim.ramY', 'sim.finger', 'sim.legend.sheet', 'sim.legend.gauged', 'sim.legend.collision', 'sim.idle', 'sim.warnings',
      ...phases.map(p => `sim.phase.${p}`), ...turns.map(t => `sim.turn.${t}`),
    ];
    for (const k of keys) expect(simLabelsEn[k], k).toBeTruthy();
  });
});
