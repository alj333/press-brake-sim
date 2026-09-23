import { describe, it, expect } from 'vitest';
import { buildPartModel } from '../part';
import { buildStandardLibrary } from '../tools';
import { defaultMachine } from '../machine';
import { hemFlattenForce } from '../bend';
import { planProgram, buildTimeline, HEM_PREBEND } from './index';
import type { FlatPattern, ToolSetup } from '../types';

/** 80 mm base + a 40 mm hem leg (a pre-bend to ~146° on V16 needs an outside leg ≥ minLeg ≈ 33 mm). */
function hemFlat(): FlatPattern {
  const src = { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } as const;
  return {
    id: 'hem', name: 'hem', thickness: 2, materialId: 'std:mild-steel',
    outline: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 40 }, { x: 0, y: 40 }],
    holes: [],
    bends: [{ id: 'B1', p0: { x: 80, y: 0 }, p1: { x: 80, y: 40 }, direction: 'up', angle: 180, innerRadius: 1, kFactor: 0.44, sources: src, hem: 'closed' }],
  };
}

function setupWith(stations: Array<{ id: string; punchId: string; dieId: string; z: [number, number] }>): ToolSetup {
  return {
    machineId: 'std:machine-generic-100t',
    stations: stations.map(s => ({ id: s.id, punchId: s.punchId, dieId: s.dieId, zStart: s.z[0], zEnd: s.z[1], segments: [], punchFlipped: false, dieFlipped: false })),
  };
}

describe('hems', () => {
  const library = buildStandardLibrary();
  const machine = defaultMachine();
  const material = library.materials.find(m => m.id === 'std:mild-steel')!;
  const part = buildPartModel(hemFlat());

  it('expands a 180° bend into an acute pre-bend and a hem-flatten step on the hemming station', () => {
    const setup = setupWith([
      { id: 'S1', punchId: 'std:punch-straight-88-r0.8', dieId: 'std:die-v16-88', z: [0, 1000] },
      { id: 'S2', punchId: 'std:punch-acute-30-r0.8', dieId: 'std:die-v16-30', z: [1100, 2000] },
      { id: 'S3', punchId: 'std:punch-hemming', dieId: 'std:die-hemming', z: [2100, 3000] },
    ]);
    const p = planProgram({ part, material, machine, setup, library });
    expect(p.steps.length).toBe(2);
    const [pre, flat] = p.steps as [typeof p.steps[0], typeof p.steps[0]];
    expect(pre.kind).toBe('bend');
    expect(pre.stationId).toBe('S2');
    expect(pre.targetAngle).toBeLessThanOrEqual(HEM_PREBEND);
    expect(pre.targetAngle).toBeGreaterThan(140);
    expect(pre.warnings.filter(w => w.key === 'warnings.tool.angle')).toEqual([]);
    expect(flat.kind).toBe('hem-flatten');
    expect(flat.stationId).toBe('S3');
    expect(flat.manipulation.stationChange).toBe(true);
    expect(flat.manipulation.turn).toBe('none');
    expect(flat.force).toBeCloseTo(hemFlattenForce(material.tensileStrength, 2, 40), 1);
    expect(flat.backgauge).toEqual([]);
    expect(flat.gaugeContact).toBe('none');
    expect(flat.ramDepth).toBeCloseTo(-4, 6);
    expect(flat.targetAngle).toBe(180);
    expect(p.feasible).toBe(true);
    // timeline: the flatten starts where the pre-bend ended
    const frames = buildTimeline(p, part, material, machine, library);
    const preEnd = frames.filter(f => f.stepIndex === 0 && f.phase === 'retract').at(-1)!;
    const flatStart = frames.find(f => f.stepIndex === 1 && f.phase === 'bend')!;
    expect(flatStart.foldState['B1']).toBeCloseTo(preEnd.foldState['B1']!, 9);
    const flatEnd = frames.filter(f => f.stepIndex === 1 && f.phase === 'bend').at(-1)!;
    expect(flatEnd.foldState['B1']).toBeCloseTo(1, 9);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.timeS).toBeGreaterThanOrEqual(frames[i - 1]!.timeS);
  });

  it('without a hemming station the program is infeasible with warnings.tool.noHemmingStation', () => {
    const setup = setupWith([
      { id: 'S1', punchId: 'std:punch-straight-88-r0.8', dieId: 'std:die-v16-88', z: [0, 1000] },
      { id: 'S2', punchId: 'std:punch-acute-30-r0.8', dieId: 'std:die-v16-30', z: [1100, 2000] },
    ]);
    const p = planProgram({ part, material, machine, setup, library });
    expect(p.feasible).toBe(false);
    expect(p.steps.some(s => s.warnings.some(w => w.key === 'warnings.tool.noHemmingStation'))).toBe(true);
  });

  it('with only 88° tools the pre-bend is angle-infeasible', () => {
    const setup = setupWith([{ id: 'S1', punchId: 'std:punch-straight-88-r0.8', dieId: 'std:die-v16-88', z: [0, 3100] }]);
    const p = planProgram({ part, material, machine, setup, library });
    expect(p.feasible).toBe(false);
    expect(p.steps[0]!.warnings.some(w => w.key === 'warnings.tool.angle' && w.severity === 'error')).toBe(true);
  });
});

describe('retractAtPinch', () => {
  it('fingers retract after the pinch in the timeline', () => {
    const library = buildStandardLibrary();
    const machine = { ...defaultMachine(), backgauge: { ...defaultMachine().backgauge, retractAtPinch: 25 } };
    const material = library.materials[0]!;
    const flat: FlatPattern = { ...hemFlat(), id: 'L', name: 'L', bends: [{ ...hemFlat().bends[0]!, angle: 90, innerRadius: 2, hem: undefined }] };
    const part = buildPartModel(flat);
    const setup = setupWith([{ id: 'S1', punchId: 'std:punch-straight-88-r0.8', dieId: 'std:die-v16-88', z: [0, 3100] }]);
    const p = planProgram({ part, material, machine, setup, library });
    expect(p.feasible).toBe(true);
    const frames = buildTimeline(p, part, material, machine, library);
    const bend = frames.filter(f => f.stepIndex === 0 && f.phase === 'bend');
    const x0 = bend[0]!.backgauge[0]!.x, x1 = bend.at(-1)!.backgauge[0]!.x;
    expect(x1 - x0).toBeCloseTo(25, 6);
    expect(x0).toBeCloseTo(p.steps[0]!.backgauge[0]!.x, 6);
  });
});
