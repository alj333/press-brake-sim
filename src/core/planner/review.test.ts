/**
 * Reviewer tests: degenerate inputs, non-90° angles, turns and costs, hems, timeline continuity,
 * backgauge invariances and tool orientation (see docs/specs/planner.md §9).
 */
import { describe, it, expect } from 'vitest';
import { mat4 } from '../geom';
import { buildPartModel } from '../part';
import { buildStandardLibrary } from '../tools';
import { defaultMachine } from '../machine';
import { minLeg } from '../bend';
import {
  planProgram, buildTimeline, createContext, createEvaluator, buildBendStep, classifyTurn, MAX_BENDS, TURN_NONE_MAX_DEG,
} from './index';
import type { PlannerInput } from './index';
import { sampleSetup, stationSetup } from './test-helpers';
import type { BendLine, BendProgram, FlatPattern, Machine, ToolSetup } from '../types';

const src = { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } as const;
const library = buildStandardLibrary();
const machine = defaultMachine();
const steel = library.materials.find(m => m.id === 'std:mild-steel')!;
const straight = stationSetup(machine, 'std:punch-straight-88-r0.8', 'std:die-v16-88');

/** Rectangular strip L × W with bend lines across the width at the given u positions. */
function strip(id: string, bends: Array<Partial<BendLine> & { u: number }>, L = 120, W = 60, t = 2): FlatPattern {
  return {
    id, name: id, thickness: t, materialId: 'std:mild-steel',
    outline: [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }, { x: 0, y: W }], holes: [],
    bends: bends.map((b, i) => ({
      id: b.id ?? `B${i + 1}`, p0: { x: b.u, y: 0 }, p1: { x: b.u, y: W }, direction: b.direction ?? 'up', angle: b.angle ?? 90,
      innerRadius: b.innerRadius ?? 2, kFactor: 0.44, sources: src, ...(b.angleCorrection !== undefined ? { angleCorrection: b.angleCorrection } : {}),
    })),
  };
}

/** U-channel with `wall` / `base` outside dimensions (t 2, ri 2), optionally with reversed bend lines or mirrored (u → −u, directions inverted). */
function uChannel(wall: number, base: number, opts: { reverse?: boolean; mirror?: boolean } = {}): FlatPattern {
  const t = 2, ri = 2, k = 0.44, W = 100;
  const ba = (Math.PI / 2) * (ri + k * t);
  const legFlat = wall - (ri + t), baseFlat = base - 2 * (ri + t);
  const L = 2 * legFlat + 2 * ba + baseFlat;
  const u1 = legFlat + ba / 2, u2 = legFlat + ba + baseFlat + ba / 2;
  const mk = (id: string, u: number): BendLine => ({
    id, p0: opts.reverse ? { x: u, y: W } : { x: u, y: 0 }, p1: opts.reverse ? { x: u, y: 0 } : { x: u, y: W },
    direction: 'up', angle: 90, innerRadius: ri, kFactor: k, sources: src,
  });
  const flat: FlatPattern = { id: 'u', name: 'u', thickness: t, materialId: 'std:mild-steel', outline: [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }, { x: 0, y: W }], holes: [], bends: [mk('B1', u1), mk('B2', u2)] };
  if (opts.mirror) {
    flat.outline = flat.outline.map(p => ({ x: -p.x, y: p.y })).reverse();
    flat.bends = flat.bends.map(b => ({ ...b, p0: { x: -b.p0.x, y: b.p0.y }, p1: { x: -b.p1.x, y: b.p1.y }, direction: 'down' }));
  }
  return flat;
}

function plan(flat: FlatPattern, setup: ToolSetup = straight, m: Machine = machine, options?: PlannerInput['options']): BendProgram {
  return planProgram({ part: buildPartModel(flat), material: steel, machine: m, setup, library, ...(options ? { options } : {}) });
}
const gaugeSignature = (p: BendProgram): string[] => p.steps.map(s => `${s.gaugeContact}|${s.backgauge.map(f => `${f.x},${f.r},${f.z}`).join(';')}|${s.manipulation.turn}`);
const errorKeys = (p: BendProgram): string[] => p.steps.flatMap(s => s.warnings.filter(w => w.severity === 'error').map(w => w.key));

describe('review — degenerate and non-90° inputs', () => {
  it('a bend below the straight-zone threshold is skipped instead of crashing the sweep', () => {
    const p = plan(strip('tiny', [{ u: 60, angle: 0.005 }]));
    expect(p.steps).toEqual([]);
    expect(p.warnings.some(w => w.key === 'warnings.planner.bendSkipped')).toBe(true);
    // just above the threshold it is planned; the punch tip stays above the die plane (D < 0)
    const q = plan(strip('half', [{ u: 60, angle: 0.5 }]));
    expect(q.steps.length).toBe(1);
    expect(q.feasible).toBe(true);
    expect(q.steps[0]!.ramDepth).toBeLessThan(0);
    expect(q.steps[0]!.ramDepth).toBeGreaterThanOrEqual(-2);
  });

  it(`more than ${MAX_BENDS} bends is refused explicitly (32-bit done mask)`, () => {
    const bends = Array.from({ length: MAX_BENDS + 1 }, (_, i) => ({ u: 30 * (i + 1), direction: (i % 2 ? 'down' : 'up') as 'up' | 'down' }));
    const part = buildPartModel(strip('many', bends, 30 * (MAX_BENDS + 2), 60));
    expect(part.links.length).toBe(MAX_BENDS + 1);
    expect(() => planProgram({ part, material: steel, machine, setup: straight, library })).toThrow(RangeError);
  });

  it('shallow bends (10°, 45°) are feasible with a negative or small ram depth and a continuous timeline', () => {
    for (const [angle, maxDepth] of [[10, 0], [45, 2]] as const) {
      const flat = strip(`a${angle}`, [{ u: 60, angle }]);
      const p = plan(flat);
      expect(p.feasible).toBe(true);
      const st = p.steps[0]!;
      expect(st.includedAngle).toBe(180 - angle);
      expect(st.ramDepth).toBeLessThan(maxDepth);
      expect(st.ramDepth).toBeGreaterThanOrEqual(-2);
      expect(st.dimensionRef).toBe('virtual-sharp');
      expect(st.bottoming).toBe(false);
      const frames = buildTimeline(p, buildPartModel(flat), steel, machine, library);
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1]!, b = frames[i]!;
        if (a.stepIndex === b.stepIndex && a.phase !== b.phase) expect(Math.abs(b.ramY - a.ramY)).toBeLessThan(1e-6);
      }
      const bendEnd = frames.filter(f => f.phase === 'bend').at(-1)!;
      expect(bendEnd.foldState['B1']).toBeCloseTo(st.overbendAngle / angle, 9);
    }
  });

  it('a 120° bend is angle-infeasible on 88° tools (legs steeper than the V faces also collide) and feasible on 30° tools with the tangent reference', () => {
    const flat = strip('a120', [{ u: 60, angle: 120 }]);
    const p = plan(flat);
    expect(p.feasible).toBe(false);
    expect(p.steps[0]!.warnings.some(w => w.key === 'warnings.tool.angle' && w.severity === 'error')).toBe(true);
    expect(p.steps[0]!.collisions.some(c => (c.with === 'die' || c.with === 'punch') && c.severity === 'error')).toBe(true);
    const q = plan(flat, stationSetup(machine, 'std:punch-acute-30-r0.8', 'std:die-v16-30'));
    expect(q.feasible).toBe(true);
    expect(q.steps[0]!.dimensionRef).toBe('tangent');
    expect(q.steps[0]!.includedAngle).toBe(60);
    expect(q.steps[0]!.collisions.filter(c => c.severity === 'error')).toEqual([]);
  });

  it('a non-round thickness (1/16 in) keeps the ram continuous at the approach → bend boundary', () => {
    const flat = strip('inch', [{ u: 60, innerRadius: 1.5875 }], 120, 60, 1.5875);
    const p = plan(flat);
    expect(p.feasible).toBe(true);
    const frames = buildTimeline(p, buildPartModel(flat), steel, machine, library);
    const approachEnd = frames.filter(f => f.phase === 'approach').at(-1)!;
    const bendStart = frames.find(f => f.phase === 'bend')!;
    expect(Math.abs(bendStart.ramY - approachEnd.ramY)).toBeLessThan(1e-9);
    expect(Math.abs(bendStart.ramY - (120 + 1.5875))).toBeLessThan(1e-9);
    expect(Math.abs(p.steps[0]!.pinchY - bendStart.ramY)).toBeLessThan(0.01);
  });

  it('a large angle correction that closes the tools is an angle error, a negative one lowers the overbend below the target', () => {
    const p = plan(strip('c30', [{ u: 60, angleCorrection: 30 }]));
    expect(p.feasible).toBe(false);
    expect(p.steps[0]!.overbendAngle).toBeCloseTo(121.71, 1);
    expect(errorKeys(p)).toContain('warnings.tool.angle');
    const q = plan(strip('cm5', [{ u: 60, angleCorrection: -5 }]));
    expect(q.feasible).toBe(true);
    expect(q.steps[0]!.overbendAngle).toBeLessThan(90);
    expect(q.steps[0]!.bottoming).toBe(false);
  });

  it('empty inputs: a flat plate plans nothing and no stations reports every bend as unplanned', () => {
    const p = plan(strip('flat', []));
    expect(p.steps).toEqual([]);
    expect(p.feasible).toBe(true);
    const q = plan(strip('nost', [{ u: 60 }]), { machineId: machine.id, stations: [] });
    expect(q.feasible).toBe(false);
    expect(q.warnings.some(w => w.key === 'warnings.planner.noStation')).toBe(true);
    expect(q.warnings.some(w => w.key === 'warnings.planner.infeasible')).toBe(true);
  });
});

describe('review — turns, legs and gauge costs', () => {
  const base = mat4.multiply(mat4.translationXYZ(-10, 1, 1500), mat4.fromAxisAngle({ x: 1, y: 0, z: 0 }, -90));
  const turned = (axis: { x: number; y: number; z: number }, deg: number) => mat4.multiply(mat4.fromAxisAngle(axis, deg), base);

  it(`classifyTurn: re-tilting up to ${TURN_NONE_MAX_DEG}° is 'none', larger tilts are flips, yaws are rotate180`, () => {
    expect(classifyTurn(base, turned({ x: 0, y: 0, z: 1 }, 30))).toBe('none');
    expect(classifyTurn(base, turned({ x: 1, y: 0, z: 0 }, -40))).toBe('none');
    expect(classifyTurn(base, turned({ x: 0, y: 0, z: 1 }, 60))).toBe('flip-front-back');
    expect(classifyTurn(base, turned({ x: 1, y: 0, z: 0 }, 100))).toBe('flip-end-for-end');
    expect(classifyTurn(base, turned({ x: 0, y: 1, z: 0 }, 90))).toBe('rotate180');
    expect(classifyTurn(base, turned({ x: 0, y: 1, z: 0 }, 30))).toBe('none');
  });

  it('a leg below the minimum leg is a hard error on that V and the planner moves to a narrower mounted die', () => {
    // 12 mm flat leg → 13.74 outside: below Lmin(V16) ≈ 15, above Lmin(V8) ≈ 8.7
    const flat = strip('short-leg', [{ u: 108 }]);
    const p = plan(flat);
    expect(p.feasible).toBe(false);
    expect(p.steps[0]!.warnings.some(w => w.key === 'warnings.bend.legTooShort' && w.severity === 'error')).toBe(true);
    expect(p.steps[0]!.gaugedFlangeOutside).toBeGreaterThan(100);   // the long leg is gauged, the short one still fails
    const two: ToolSetup = {
      machineId: machine.id,
      stations: [
        { id: 'V16', punchId: 'std:punch-straight-88-r0.8', dieId: 'std:die-v16-88', zStart: 0, zEnd: 1500, segments: [835, 415, 200, 50], punchFlipped: false, dieFlipped: false },
        { id: 'V8', punchId: 'std:punch-straight-88-r0.8', dieId: 'std:die-v8-88', zStart: 1600, zEnd: 3100, segments: [835, 415, 200, 50], punchFlipped: false, dieFlipped: false },
      ],
    };
    const q = plan(flat, two);
    expect(q.feasible).toBe(true);
    expect(q.steps[0]!.stationId).toBe('V8');
    expect(q.steps[0]!.dieId).toBe('std:die-v8-88');
    const lmin = minLeg(8, q.steps[0]!.loadedIncludedAngle, 1);
    expect(13.74).toBeGreaterThan(lmin);
    expect(q.steps[0]!.warnings.filter(w => w.key.startsWith('warnings.bend.leg'))).toEqual([]);
  });

  it('gaugedFlangeOutside is the caliper check dimension: virtual sharp of this bend to the gauged wall face', () => {
    const s = sampleSetup('U-channel');
    const ctx = createContext({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
    const ev = createEvaluator(ctx);
    const b1 = ctx.bends.find(b => b.id === 'B1')!, b2 = ctx.bends.find(b => b.id === 'B2')!;
    const e = ev.evaluate(b2.index, 1 << b1.index, 0, 0, true);   // root gauged against the standing B1 wall
    const { step } = buildBendStep(ctx, e, 0, { turn: 'none', stationChange: false });
    expect(step.gaugeContact).toBe('flange-face');
    expect(step.gaugedFlangeOutside).toBeCloseTo(80, 1);          // outside width of the channel base
    expect(step.backgauge[0]!.x).toBeCloseTo(78.26, 1);
    // cut-edge contact: from the virtual sharp to the far edge of the flat sheet
    const e2 = ev.evaluate(b1.index, 0, 0, 0, true);
    const s2 = buildBendStep(ctx, e2, 0, { turn: 'none', stationChange: false }).step;
    expect(s2.gaugeContact).toBe('cut-edge');
    expect(s2.gaugedFlangeOutside).toBeCloseTo(s2.backgauge[0]!.x - s.part.bendAllowance['B1']! / 2 + 4, 2);   // step numbers are rounded to 0.01
  });

  it('a finger skimming the die top to reach a short leg is reported (info) and costed: the tabbed plate gauges the plate', () => {
    const s = sampleSetup('tabbed-plate');
    const p = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
    const st = p.steps[0]!;
    expect(st.placement.gaugedFlangeId).toBe(s.part.rootFlangeId);
    expect(Math.abs(st.backgauge[0]!.x - 118)).toBeLessThan(0.1);
    expect(st.warnings.some(w => w.key === 'warnings.gauge.fingerOverDie')).toBe(false);
    // the box gauges its 30 mm walls with the fingers raised onto the die top (R = 0) rather than turning the part
    const b = sampleSetup('box-4-flange');
    const q = planProgram({ part: b.part, material: b.material, machine: b.machine, setup: b.setup, library: b.library });
    const over = q.steps.filter(x => x.backgauge.some(f => f.r === 0));
    expect(over.length).toBeGreaterThan(0);
    for (const x of over) expect(x.warnings.some(w => w.key === 'warnings.gauge.fingerOverDie' && w.severity === 'info')).toBe(true);
    expect(q.feasible).toBe(true);
  });
});

describe('review — tool orientation and invariances', () => {
  it('the gooseneck relief clears a deep channel wall that sweeps into the straight punch', () => {
    const flat = uChannel(50, 60);
    const p = plan(flat);
    expect(p.feasible).toBe(false);
    expect(p.steps[1]!.collisions.some(c => c.with === 'punch' && c.severity === 'error')).toBe(true);
    const goose = (flipped: boolean): ToolSetup => ({
      machineId: machine.id,
      stations: [{ id: 'S1', punchId: 'std:punch-gooseneck-88-r0.8', dieId: 'std:die-v16-88', zStart: 0, zEnd: 3100, segments: [835, 835, 835, 415, 100, 50, 20, 10], punchFlipped: flipped, dieFlipped: false }],
    });
    const q = plan(flat, goose(false));
    expect(q.feasible).toBe(true);
    expect(q.steps.flatMap(s => s.collisions.filter(c => c.severity === 'error'))).toEqual([]);
    // mounted reversed (relief to the back) the planner gauges the standing wall behind the fingers instead
    const r = plan(flat, goose(true));
    expect(r.feasible).toBe(true);
    expect(r.steps[1]!.gaugeContact).toBe('flange-face');
  });

  it('reversing the bend line direction or mirroring the flat pattern (directions inverted) gives the same program', () => {
    const s = sampleSetup('L-bracket');
    const rev: FlatPattern = { ...s.truth.flat, bends: s.truth.flat.bends.map(b => ({ ...b, p0: b.p1, p1: b.p0 })) };
    const a = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
    const b = planProgram({ part: buildPartModel(rev), material: s.material, machine: s.machine, setup: s.setup, library: s.library });
    expect(gaugeSignature(b)).toEqual(gaugeSignature(a));
    expect(b.steps[0]!.ramDepth).toBe(a.steps[0]!.ramDepth);
    const u = plan(uChannel(40, 80)), ur = plan(uChannel(40, 80, { reverse: true })), um = plan(uChannel(40, 80, { mirror: true }));
    expect(u.feasible && ur.feasible && um.feasible).toBe(true);
    expect(gaugeSignature(ur)).toEqual(gaugeSignature(u));
    expect(gaugeSignature(um)).toEqual(gaugeSignature(u));
    expect(um.steps.every(st => st.placement.flipped)).toBe(true);   // the mirrored (down) channel is bent face down
  });

  it('symmetric tools mounted reversed change nothing; hanging walls beside the die (both bends down) are feasible', () => {
    const s = sampleSetup('L-bracket');
    const flipped: ToolSetup = { ...s.setup, stations: s.setup.stations.map(st => ({ ...st, punchFlipped: true, dieFlipped: true })) };
    const a = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
    const b = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: flipped, library: s.library });
    expect(gaugeSignature(b)).toEqual(gaugeSignature(a));
    expect(b.feasible).toBe(true);
    const down = plan(strip('udown', [{ u: 38.26, direction: 'down' }, { u: 114.79, direction: 'down' }], 153.05, 120));
    expect(down.feasible).toBe(true);
    expect(down.steps.every(st => st.placement.flipped && st.manipulation.turn === 'none')).toBe(true);
    expect(down.steps.flatMap(st => st.collisions)).toEqual([]);
  });

  it('three fingers spread evenly over a wide edge; one finger centred on an edge narrower than two fingers', () => {
    const three = { ...machine, backgauge: { ...machine.backgauge, fingerCount: 3 } };
    const p = plan(strip('f3', [{ u: 60 }], 120, 240), straight, three);
    const zs = p.steps[0]!.backgauge.map(f => f.z);
    expect(zs.length).toBe(3);
    const [z0, z1] = [machine.bedLength / 2 - 120, machine.bedLength / 2 + 120];
    expect(zs[0]).toBeCloseTo(z0 + 240 / 6, 6);
    expect(zs[1]).toBeCloseTo((z0 + z1) / 2, 6);
    expect(zs[2]).toBeCloseTo(z1 - 240 / 6, 6);
    const narrow = plan(strip('f1', [{ u: 60 }], 120, 50), straight, three);
    expect(narrow.steps[0]!.backgauge.length).toBe(1);
    expect(narrow.steps[0]!.backgauge[0]!.z).toBeCloseTo(machine.bedLength / 2, 6);
  });
});

describe('review — punch piece convention', () => {
  it('a corner tab with one free side gets a short piece centred on the tab, not a long overhang over the free side', () => {
    const flat: FlatPattern = {
      id: 'ct', name: 'ct', thickness: 2, materialId: 'std:mild-steel',
      outline: [{ x: 0, y: 0 }, { x: 141.261947, y: 0 }, { x: 141.261947, y: 30 }, { x: 114.738053, y: 30 }, { x: 114.738053, y: 32 }, { x: 120, y: 32 }, { x: 120, y: 80 }, { x: 0, y: 80 }],
      holes: [],
      bends: [{ id: 'B1', p0: { x: 118, y: 0 }, p1: { x: 118, y: 30 }, direction: 'up', angle: 90, innerRadius: 2, kFactor: 0.44, sources: src }],
    };
    const p = plan(flat);
    expect(p.feasible).toBe(true);
    const st = p.steps[0]!;
    expect(st.punchLength).toBeLessThanOrEqual(28);
    expect(st.punchLength).toBeGreaterThanOrEqual(22);
    expect(st.collisions).toEqual([]);
  });

  it('every sample step: the piece of length punchLength centred in the station covers the bend line (minus the corner allowance)', () => {
    for (const name of ['L-bracket', 'U-channel', 'Z-bracket', 'box-4-flange', 'tabbed-plate', 'hat-channel'] as const) {
      const s = sampleSetup(name);
      const p = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
      for (const st of p.steps) {
        const station = p.setup.stations.find(x => x.id === st.stationId)!;
        const zc = (station.zStart + station.zEnd) / 2;
        const bend = s.part.flat.bends.find(b => b.id === st.bendId)!;
        const z0 = mat4.applyToPoint(st.placement.transform, { x: bend.p0.x, y: bend.p0.y, z: 0 }).z;
        const z1 = mat4.applyToPoint(st.placement.transform, { x: bend.p1.x, y: bend.p1.y, z: 0 }).z;
        const corner = bend.innerRadius + s.truth.thickness;
        expect(Math.min(z0, z1) + corner).toBeGreaterThanOrEqual(zc - st.punchLength / 2 - 1e-6);
        expect(Math.max(z0, z1) - corner).toBeLessThanOrEqual(zc + st.punchLength / 2 + 1e-6);
        // and the part sits where partZOffset says
        expect(st.partZOffset).toBeGreaterThanOrEqual(-1e-6);
      }
    }
  });
});

describe('review — timeline', () => {
  it('fingers keep their position through a hem-flatten step and the flatten collisions use fold fractions', () => {
    const hem: FlatPattern = {
      id: 'hem', name: 'hem', thickness: 2, materialId: 'std:mild-steel',
      outline: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 40 }, { x: 0, y: 40 }], holes: [],
      bends: [{ id: 'B1', p0: { x: 80, y: 0 }, p1: { x: 80, y: 40 }, direction: 'up', angle: 180, innerRadius: 1, kFactor: 0.44, sources: src, hem: 'closed' }],
    };
    const setup: ToolSetup = {
      machineId: machine.id,
      stations: [
        { id: 'S2', punchId: 'std:punch-acute-30-r0.8', dieId: 'std:die-v16-30', zStart: 0, zEnd: 1500, segments: [], punchFlipped: false, dieFlipped: false },
        { id: 'S3', punchId: 'std:punch-hemming', dieId: 'std:die-hemming', zStart: 1600, zEnd: 3100, segments: [], punchFlipped: false, dieFlipped: false },
      ],
    };
    const part = buildPartModel(hem);
    const p = planProgram({ part, material: steel, machine, setup, library });
    expect(p.feasible).toBe(true);
    expect(p.steps.map(s => s.kind)).toEqual(['bend', 'hem-flatten']);
    const preFraction = p.steps[0]!.targetAngle / 180;
    for (const c of p.steps[1]!.collisions) expect(c.atFraction).toBeGreaterThanOrEqual(preFraction - 1e-6);
    const frames = buildTimeline(p, part, steel, machine, library);
    const pre = p.steps[0]!.backgauge;
    for (const f of frames.filter(x => x.stepIndex === 1)) expect(f.backgauge).toEqual(pre);
    // the flatten closes the hem completely; the punch face follows the modelled hem top (2t + 2·ri for the
    // drawn radius) while the programmed depth is the shop number −2t for a closed hem
    const end = frames.filter(x => x.stepIndex === 1 && x.phase === 'bend').at(-1)!;
    expect(end.foldState['B1']).toBeCloseTo(1, 9);
    expect(end.ramY).toBeCloseTo(120 + 2 * 2 + 2 * 1, 6);
    expect(p.steps[1]!.ramDepth).toBeCloseTo(-4, 6);
    expect(end.ramY).toBeGreaterThanOrEqual(120 - p.steps[1]!.ramDepth - 1e-9);
  });
});
