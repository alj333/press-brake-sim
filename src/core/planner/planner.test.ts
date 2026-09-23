import { describe, it, expect } from 'vitest';
import { mat4 } from '../geom';
import { buildPartModel, foldGeometry, flatState, bendPose } from '../part';
import { punchTipY } from '../bend';
import { vDie } from '../tools';
import { planProgram, defaultPlannerOptions, buildTimeline } from './index';
import type { PlannerInput } from './index';
import { makeBoxFlat, sampleSetup, stationSetup } from './test-helpers';
import type { SampleSetup } from './test-helpers';
import type { BendProgram } from '../types';
import { SAMPLE_NAMES } from '../testing/fixtures';

function inputOf(s: SampleSetup, options?: PlannerInput['options']): PlannerInput {
  return { part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library, ...(options ? { options } : {}) };
}
const flips = (p: BendProgram): number => p.steps.filter(s => s.manipulation.turn === 'flip-front-back' || s.manipulation.turn === 'flip-end-for-end').length;
const errorCollisions = (p: BendProgram) => p.steps.flatMap(s => s.collisions.filter(c => c.severity === 'error'));

describe('planProgram — samples', () => {
  it('L-bracket: one feasible step, long leg gauged on the cut edge, goldens reproduced', () => {
    const s = sampleSetup('L-bracket');
    const p = planProgram(inputOf(s));
    expect(p.feasible).toBe(true);
    expect(p.steps.length).toBe(1);
    const st = p.steps[0]!;
    const g = s.truth.expected.perBend['B1']!;
    expect(st.kind).toBe('bend');
    expect(st.gaugeContact).toBe('cut-edge');
    expect(st.backgauge.length).toBe(2);
    const longLegGauged = st.placement.gaugedFlangeId === s.part.rootFlangeId;
    const expectedX = longLegGauged ? 58.26 : 38.26;
    for (const f of st.backgauge) {
      expect(Math.abs(f.x - expectedX)).toBeLessThan(0.1);
      expect(f.r).toBeCloseTo(-(20 - s.truth.thickness) / 2, 6);
    }
    expect(Math.abs(st.ramDepth - g.ramDepthSharpShoulder)).toBeLessThan(0.3);
    expect(Math.abs(st.forcePerMeter - g.forcePerMeter) / g.forcePerMeter).toBeLessThan(0.02);
    expect(Math.abs(st.force - g.force) / g.force).toBeLessThan(0.02);
    expect(st.includedAngle).toBe(90);
    expect(st.loadedIncludedAngle).toBeCloseTo(g.loadedIncludedAngle, 1);
    expect(st.actualInnerRadius).toBeCloseTo(g.actualInnerRadius, 2);
    expect(st.bendDeduction).toBeCloseTo(g.bendDeduction, 1);
    expect(st.dimensionRef).toBe('virtual-sharp');
    // outside dimension of the gauged leg (60 for the root, 40 for the child)
    expect(st.gaugedFlangeOutside).toBeCloseTo(longLegGauged ? 60 : 40, 1);
    expect(st.punchLength).toBe(3100);
    expect(st.segments).toEqual(s.setup.stations[0]!.segments);
    expect(st.pinchY).toBeCloseTo(120 + 2, 6);
    expect(st.ramUpperLimit).toBeLessThanOrEqual(300);
    expect(st.ramUpperLimit).toBeGreaterThan(st.pinchY);
    expect(st.collisions).toEqual([]);
    expect(st.manipulation).toEqual({ turn: 'none', stationChange: false });
    expect(st.orientation).toEqual({ faceUp: 'top', backFlangeId: st.placement.gaugedFlangeId });
    expect(p.maxForce).toBeCloseTo(st.force, 6);
    expect(p.stats.timeMs).toBeGreaterThanOrEqual(0);
    expect(p.warnings.filter(w => w.severity === 'error')).toEqual([]);
  });

  it('U-channel: two steps, no flips, second step gauges on the standing wall face or the free cut edge', () => {
    const s = sampleSetup('U-channel');
    const p = planProgram(inputOf(s));
    expect(p.feasible).toBe(true);
    expect(p.steps.length).toBe(2);
    expect(flips(p)).toBe(s.truth.expected.expectedFlips ?? 0);
    expect(errorCollisions(p)).toEqual([]);
    const second = p.steps[1]!;
    const b1 = s.part.flat.bends.find(b => b.id === 'B1')!, b2 = s.part.flat.bends.find(b => b.id === 'B2')!;
    const gap = Math.abs(b2.p0.x - b1.p0.x);
    const wallFaceX = gap - s.part.bendAllowance['B1']! / 2 + b1.innerRadius + s.truth.thickness;
    if (second.gaugeContact === 'flange-face') {
      expect(Math.abs(second.backgauge[0]!.x - wallFaceX)).toBeLessThan(0.1);
      expect(second.backgauge[0]!.r).toBeCloseTo(b1.innerRadius + s.truth.thickness + 2, 6);
    } else {
      expect(second.gaugeContact).toBe('cut-edge');
      expect(Math.abs(second.backgauge[0]!.x - 38.26)).toBeLessThan(0.1);
      expect(second.backgauge[0]!.r).toBeGreaterThanOrEqual(s.machine.backgauge.rMin);
    }
  });

  it('Z-bracket: exactly one flip', () => {
    const s = sampleSetup('Z-bracket');
    const p = planProgram(inputOf(s));
    expect(p.feasible).toBe(true);
    expect(p.steps.length).toBe(2);
    expect(flips(p)).toBe(1);
    expect(p.steps[1]!.placement.flipped).not.toBe(p.steps[0]!.placement.flipped);
    expect(errorCollisions(p)).toEqual([]);
  });

  it('hat-channel: infeasible on the 60 mm wide standard die (hanging flange hits the die), feasible with a 50 mm die, ≤ 2 flips', () => {
    const s = sampleSetup('hat-channel');
    const p = planProgram(inputOf(s));
    expect(p.steps.length).toBe(4);
    expect(p.feasible).toBe(false);
    expect(errorCollisions(p).some(c => c.with === 'die')).toBe(true);
    // a narrower die body clears the hanging brim / crown
    const die = vDie({ vWidth: 16, vAngle: 88, shoulderRadius: 1.5, bodyWidth: 50, height: 60 }, { id: 'custom:v16-narrow', name: 'V16 narrow' });
    s.library.dies.push(die);
    const setup = stationSetup(s.machine, s.truth.expected.defaultSetup.punch, die.id);
    const p2 = planProgram({ ...inputOf(s), setup });
    expect(p2.feasible).toBe(true);
    expect(p2.steps.length).toBe(4);
    expect(flips(p2)).toBeLessThanOrEqual(s.truth.expected.maxFlips ?? 2);
    expect(errorCollisions(p2)).toEqual([]);
    expect(p2.stats.timeMs).toBeLessThan(4000);
  });

  it('box: four feasible steps, the last two with a punch shorter than the bend line', () => {
    const s = sampleSetup('box-4-flange');
    const t0 = Date.now();
    const p = planProgram(inputOf(s));
    const elapsed = Date.now() - t0;
    expect(p.feasible).toBe(true);
    expect(p.steps.length).toBe(4);
    expect(errorCollisions(p)).toEqual([]);
    expect(flips(p)).toBe(s.truth.expected.expectedFlips ?? 0);
    for (const st of p.steps.slice(2)) {
      expect(st.punchLength).toBeLessThan(192);
      expect(st.segments.reduce((a, b) => a + b, 0)).toBeCloseTo(st.punchLength, 6);
    }
    // every step: the punch covers at least the bend length − 2(ri + t)
    for (const st of p.steps) expect(st.punchLength).toBeGreaterThanOrEqual(st.bendLength - 8 - 1e-6);
    expect(elapsed).toBeLessThan(2000);
    expect(p.stats.sequencesEvaluated).toBeGreaterThanOrEqual(1);
  });

  it('box with 400 mm flanges and the 120 mm straight punch: clamp/ram collision on a later bend', () => {
    const s = sampleSetup('box-4-flange');
    const part = buildPartModel(makeBoxFlat(192, 142, 400));
    const p = planProgram({ ...inputOf(s), part });
    expect(p.feasible).toBe(false);
    const later = p.steps.slice(1).flatMap(st => st.collisions.filter(c => c.severity === 'error'));
    expect(later.some(c => c.with === 'clamp' || c.with === 'ram')).toBe(true);
    expect(p.warnings.some(w => w.key === 'warnings.planner.infeasible')).toBe(true);
  });

  it('acute bracket: infeasible with the 88° station (warnings.tool.angle), feasible with 30° tools', () => {
    const s = sampleSetup('acute-bracket');
    const p = planProgram(inputOf(s));
    expect(p.feasible).toBe(false);
    expect(p.steps.length).toBe(1);
    expect(p.steps[0]!.warnings.some(w => w.key === 'warnings.tool.angle' && w.severity === 'error')).toBe(true);
    expect(p.steps[0]!.bottoming).toBe(true);
    const a = sampleSetup('acute-bracket', { punchId: 'std:punch-acute-30-r0.8', dieId: 'std:die-v12-30' });
    const p2 = planProgram(inputOf(a));
    expect(p2.feasible).toBe(true);
    expect(p2.steps.length).toBe(1);
    const st = p2.steps[0]!;
    const g = a.truth.expected.perBend['B1']!;
    expect(st.includedAngle).toBe(45);
    expect(st.loadedIncludedAngle).toBeCloseTo(g.loadedIncludedAngle, 1);
    expect(st.dimensionRef).toBe('tangent');
    expect(st.bottoming).toBe(false);
    expect(Math.abs(st.forcePerMeter - g.forcePerMeter) / g.forcePerMeter).toBeLessThan(0.02);
    expect(st.collisions.filter(c => c.severity === 'error')).toEqual([]);
  });

  it('tabbed plate: one step, fingers avoid the hole, the plate beside the tab does not collide', () => {
    const s = sampleSetup('tabbed-plate');
    const p = planProgram(inputOf(s));
    expect(p.feasible).toBe(true);
    expect(p.steps.length).toBe(1);
    const st = p.steps[0]!;
    expect(st.collisions.filter(c => c.severity === 'error')).toEqual([]);
    expect(st.punchLength).toBeLessThanOrEqual(30);
    const hole = s.truth.expected.holeNearGaugedEdge!;
    const w = s.library.fingers.find(f => f.id === s.machine.backgauge.fingerId)!.width;
    if (st.placement.gaugedFlangeId === s.part.rootFlangeId) {
      const holeZ = mat4.applyToPoint(st.placement.transform, { x: hole.u, y: hole.v, z: 0 }).z;
      for (const f of st.backgauge) {
        expect(Math.abs(f.z - holeZ) >= hole.r + w / 2 - 1e-6 || Math.abs(f.x - 118) > 0.1).toBe(true);
      }
    }
    expect(st.backgauge.length).toBeGreaterThanOrEqual(1);
  });

  it('fixedOrder keeps the given order and skips the search', () => {
    const s = sampleSetup('box-4-flange');
    const p = planProgram(inputOf(s, { fixedOrder: ['B2', 'B4', 'B1', 'B3'] }));
    expect(p.steps.map(x => x.bendId)).toEqual(['B2', 'B4', 'B1', 'B3']);
    expect(p.stats.sequencesEvaluated).toBe(1);
  });

  it('reports progress and honours an AbortSignal', () => {
    const s = sampleSetup('box-4-flange');
    const phases = new Set<string>();
    planProgram(inputOf(s), undefined, pr => { phases.add(pr.phase); });
    expect(phases.has('search')).toBe(true);
    expect(phases.has('assemble')).toBe(true);
    const ac = new AbortController();
    ac.abort();
    expect(() => planProgram(inputOf(s), ac.signal)).toThrow(/abort/i);
  });

  it('defaultPlannerOptions: documented defaults', () => {
    const o = defaultPlannerOptions();
    expect(o.sweepStepDeg).toBe(5);
    expect(o.minFlangeWarnFactor).toBe(1.15);
    expect(o.weights.flip).toBeGreaterThan(o.weights.rotate);
    expect(o.maxSequences).toBeGreaterThan(100);
  });
});

describe('buildTimeline', () => {
  const s = sampleSetup('Z-bracket');
  const program = planProgram(inputOf(s));
  const frames = buildTimeline(program, s.part, s.material, s.machine, s.library);

  it('phases in order, ≥ 25 keyframes per phase, monotonic time', () => {
    expect(frames.length).toBeGreaterThan(0);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.timeS).toBeGreaterThanOrEqual(frames[i - 1]!.timeS);
    const perPhase = new Map<string, number>();
    for (const f of frames) { const k = `${f.stepIndex}:${f.phase}`; perPhase.set(k, (perPhase.get(k) ?? 0) + 1); }
    for (const [, n] of perPhase) expect(n).toBeGreaterThanOrEqual(25);
    const order = ['reposition', 'position', 'gauge', 'approach', 'bend', 'release', 'retract'];
    for (const stepIndex of [0, 1]) {
      const phases = [...new Set(frames.filter(f => f.stepIndex === stepIndex).map(f => f.phase))];
      const idx = phases.map(p => order.indexOf(p));
      for (let i = 1; i < idx.length; i++) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
      expect(phases).toContain('bend');
    }
    // the Z-bracket's second step is a flip: it has a reposition phase
    expect(frames.some(f => f.stepIndex === 1 && f.phase === 'reposition')).toBe(true);
    expect(frames.some(f => f.stepIndex === 0 && f.phase === 'reposition')).toBe(false);
  });

  it('ramY is continuous within a step (no jumps at phase boundaries, < 1 mm steps while bending) and follows punchTipY', () => {
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!, b = frames[i]!;
      if (a.stepIndex !== b.stepIndex) continue;
      if (a.phase !== b.phase) expect(Math.abs(b.ramY - a.ramY)).toBeLessThan(1e-6);
      else if (a.phase === 'bend' || a.phase === 'release') expect(Math.abs(b.ramY - a.ramY)).toBeLessThan(1);
    }
    // the part transform is continuous at every phase boundary within a step
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!, b = frames[i]!;
      if (a.stepIndex !== b.stepIndex || a.phase === b.phase) continue;
      expect(mat4.equals(a.partTransform, b.partTransform, 1e-6)).toBe(true);
    }
    const step = program.steps[0]!;
    const bendFrames = frames.filter(f => f.stepIndex === 0 && f.phase === 'bend');
    for (const f of bendFrames) {
      const frac = f.foldState[step.bendId]!;
      expect(f.ramY).toBeCloseTo(punchTipY(16, 2, step.actualInnerRadius, frac * 90, 1.5, 88) + 120, 6);
    }
    const last = bendFrames[bendFrames.length - 1]!;
    expect(last.foldState[step.bendId]).toBeCloseTo(step.overbendAngle / 90, 9);
    expect(last.ramY).toBeCloseTo(120 - step.ramDepth, 1);
  });

  it('pose matches partTransform (decompose/compose round trip) and the bend starts at the placement', () => {
    for (const f of frames) {
      const m = mat4.compose(f.pose.position, f.pose.quaternion);
      expect(mat4.equals(m, f.partTransform, 1e-6)).toBe(true);
    }
    for (const stepIndex of [0, 1]) {
      const step = program.steps[stepIndex]!;
      const first = frames.find(f => f.stepIndex === stepIndex && f.phase === 'bend')!;
      expect(mat4.equals(first.partTransform, step.placement.transform, 1e-9)).toBe(true);
      const folded = foldGeometry(s.part, first.foldState);
      const pose = bendPose(step.placement.transform, folded, step.bendId, 0, punchTipY(16, 2, step.actualInnerRadius, 0, 1.5, 88), 2);
      expect(mat4.equals(pose, step.placement.transform, 1e-9)).toBe(true);
      // the fold state during the bend keeps previous bends at 1 and the others at 0
      const flat = flatState(s.part);
      for (const id of Object.keys(flat)) {
        const v = first.foldState[id]!;
        expect(v === 0 || v === 1).toBe(true);
      }
    }
    // fingers of the step are reached at the end of the gauge phase
    const gaugeEnd = frames.filter(f => f.stepIndex === 0 && f.phase === 'gauge').at(-1)!;
    expect(gaugeEnd.backgauge).toEqual(program.steps[0]!.backgauge);
  });
});

describe('buildTimeline — every sample', () => {
  it('produces a monotonic, continuous timeline for each sample program', () => {
    for (const name of SAMPLE_NAMES) {
      const s = sampleSetup(name);
      const program = planProgram(inputOf(s));
      const frames = buildTimeline(program, s.part, s.material, s.machine, s.library);
      expect(frames.length).toBeGreaterThanOrEqual(program.steps.length * 6 * 25);
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1]!, b = frames[i]!;
        expect(b.timeS).toBeGreaterThanOrEqual(a.timeS);
        if (a.stepIndex === b.stepIndex && a.phase !== b.phase) {
          expect(Math.abs(b.ramY - a.ramY)).toBeLessThan(1e-6);
          expect(mat4.equals(a.partTransform, b.partTransform, 1e-6)).toBe(true);
        }
        for (const v of b.pose.quaternion) expect(Number.isFinite(v)).toBe(true);
      }
      // ram never goes below the deepest ram depth of the step, never above TDC
      for (const f of frames) {
        const step = program.steps[f.stepIndex]!;
        expect(f.ramY).toBeGreaterThanOrEqual(120 - step.ramDepth - 1e-6);
        expect(f.ramY).toBeLessThanOrEqual(300 + 1e-6);
      }
    }
  });
});
