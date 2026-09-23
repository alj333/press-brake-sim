import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth } from '../testing/fixtures';
import { isCCW, bounds } from '../geom';
import { airBendForcePerMeter, ramDepth } from '../bend';
import { buildStandardLibrary, standardDieId, STANDARD_PUNCH_ID, STANDARD_FINGER_ID, STANDARD_MATERIAL_ID, LIBRARY_VERSION } from './standard';
import { toolLoadCheck, daylightCheck, strokeCheck } from './checks';
import { isSimplePolygon } from './profile';
import { deriveDieParams, derivePunchParams } from './derive';
import type { Tool } from '../types';

function profileOk(t: Tool): void {
  const pts = t.profile.points;
  expect(pts.length, t.id).toBeGreaterThanOrEqual(3);
  expect(isCCW(pts), t.id).toBe(true);
  expect(isSimplePolygon(pts), t.id).toBe(true);
  const b = bounds(pts);
  if (t.kind === 'die') { expect(b.max.y, t.id).toBeCloseTo(0, 9); expect(b.min.y, t.id).toBeCloseTo(-t.height, 9); }
  else { expect(b.min.y, t.id).toBeCloseTo(0, 9); expect(b.max.y, t.id).toBeCloseTo(t.height, 9); }
  if (t.kind === 'finger') {
    expect(b.min.x, t.id).toBeCloseTo(0, 9);
    // stop face: (0,0)–(0,stopHeight) is on the boundary as a vertical edge
    expect(pts.some(p => p.x === 0 && p.y === 0), t.id).toBe(true);
    expect(pts.some(p => p.x === 0 && Math.abs(p.y - t.stopHeight) < 1e-9), t.id).toBe(true);
  }
}

describe('standard library', () => {
  const lib = buildStandardLibrary();

  it('contains everything ARCHITECTURE lists with stable ids', () => {
    const ids = (arr: { id: string }[]): string[] => arr.map(x => x.id);
    expect(ids(lib.punches)).toEqual([
      'std:punch-straight-88-r0.8', 'std:punch-straight-88-r0.2', 'std:punch-straight-85-r0.8', 'std:punch-gooseneck-88-r0.8',
      'std:punch-acute-30-r0.8', 'std:punch-acute-28-r1', 'std:punch-radius-r3', 'std:punch-radius-r5', 'std:punch-radius-r10', 'std:punch-hemming',
    ]);
    for (const v of [6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80]) expect(ids(lib.dies)).toContain(`std:die-v${v}-88`);
    for (const id of ['std:die-v12-85', 'std:die-v16-85', 'std:die-v12-30', 'std:die-v16-30', 'std:die-multi-v16', 'std:die-multi-v22', 'std:die-multi-v35', 'std:die-multi-v50', 'std:die-hemming']) {
      expect(ids(lib.dies)).toContain(id);
    }
    expect(ids(lib.fingers)).toEqual(['std:finger-flat', 'std:finger-stepped']);
    expect(ids(lib.materials)).toEqual(['std:mild-steel', 'std:stainless-304', 'std:aluminium-5052-h32', 'std:aluminium-6061-t6', 'std:galvanised-steel']);
    expect(ids(lib.machines)).toEqual(['std:machine-generic-100t']);
    expect(lib.version).toBe(LIBRARY_VERSION); expect(lib.revision).toBe(0);
    expect(new Date(lib.updatedAt).toISOString()).toBe(lib.updatedAt);
    // ids unique across all collections
    const all = [...ids(lib.punches), ...ids(lib.dies), ...ids(lib.fingers), ...ids(lib.materials), ...ids(lib.machines)];
    expect(new Set(all).size).toBe(all.length);
    for (const t of [...lib.punches, ...lib.dies, ...lib.fingers]) expect(t.source).toBe('standard');
  });

  it('every profile is closed, CCW, simple and respects its y-extent rule', () => {
    for (const t of [...lib.punches, ...lib.dies, ...lib.fingers]) profileOk(t);
  });

  it('punch tips at the origin, die notches at the origin with the stated V/angle', () => {
    for (const p of lib.punches) {
      const d = derivePunchParams(p.profile.points);
      expect(d.tipAngle, p.id).toBeCloseTo(p.tipAngle, 2);
      expect(d.tipRadius, p.id).toBeCloseTo(p.tipRadius, 3);
      expect(p.profile.points.some(q => q.x === 0 && q.y === 0), p.id).toBe(true);
    }
    for (const d of lib.dies) {
      if (d.family === 'hemming') continue;
      const r = deriveDieParams(d.profile.points);
      expect(r.vWidth, d.id).toBeCloseTo(d.vWidth, 3);
      expect(r.vAngle, d.id).toBeCloseTo(d.vAngle, 3);
      expect(r.vCentreX, d.id).toBeCloseTo(0, 6);
    }
  });

  it('ratings and dimensions follow the formulas', () => {
    const die = (id: string) => lib.dies.find(d => d.id === id)!;
    expect(die('std:die-v6-88').maxLoadPerMeter).toBe(300);
    expect(die('std:die-v8-88').maxLoadPerMeter).toBe(400);
    expect(die('std:die-v10-88').maxLoadPerMeter).toBe(600);
    expect(die('std:die-v12-88').maxLoadPerMeter).toBe(1000);
    expect(die('std:die-v80-88').maxLoadPerMeter).toBe(1000);
    expect(die('std:die-v16-88').shoulderRadius).toBe(1.5);
    expect(die('std:die-v12-88').shoulderRadius).toBe(1);
    expect(die('std:die-v50-88').bodyWidth).toBe(80); expect(die('std:die-v50-88').height).toBe(90);
    expect(die('std:die-v80-88').bodyWidth).toBe(120); expect(die('std:die-v80-88').height).toBe(100);
    expect(die('std:die-v25-88').height).toBe(60);
    expect(die('std:die-multi-v35').vWidth).toBe(35); expect(die('std:die-multi-v35').bodyWidth).toBe(90);
    const punch = (id: string) => lib.punches.find(p => p.id === id)!;
    expect(punch('std:punch-straight-88-r0.8').maxLoadPerMeter).toBe(1000);
    expect(punch('std:punch-gooseneck-88-r0.8').maxLoadPerMeter).toBe(600);
    expect(punch('std:punch-gooseneck-88-r0.8').tangCentreX).toBe(7);
    expect(punch('std:punch-acute-30-r0.8').maxLoadPerMeter).toBe(400);
    expect(punch('std:punch-radius-r5').maxLoadPerMeter).toBe(800);
    expect(punch('std:punch-hemming').maxLoadPerMeter).toBe(800);
    for (const p of lib.punches) { expect(p.height).toBe(120); expect(p.segmentLengths).toEqual([10, 15, 20, 40, 50, 100, 200, 300, 415, 835, 3000]); }
    const f = lib.fingers.find(x => x.id === 'std:finger-flat')!;
    expect([f.stopHeight, f.bodyDepth, f.width, f.height]).toEqual([20, 60, 30, 35]);
    const m = lib.materials.find(x => x.id === 'std:mild-steel')!;
    expect([m.tensileStrength, m.kFactor, m.springbackDeg, m.minInnerRadiusFactor]).toEqual([420, 0.44, 1.5, 0.8]);
    const s = lib.materials.find(x => x.id === 'std:stainless-304')!;
    expect([s.tensileStrength, s.kFactor, s.springbackDeg, s.minInnerRadiusFactor]).toEqual([620, 0.45, 3, 1.5]);
  });

  it('samples: expected.defaultSetup tools exist with the truth parameters', () => {
    for (const name of SAMPLE_NAMES) {
      const truth = loadTruth(name);
      const setup = truth.expected.defaultSetup;
      expect(setup.punch).toBe(STANDARD_PUNCH_ID);
      expect(setup.die).toBe(standardDieId(setup.dieV, setup.dieAngle));
      const punch = lib.punches.find(p => p.id === setup.punch)!;
      const die = lib.dies.find(d => d.id === setup.die)!;
      expect(punch, name).toBeDefined(); expect(die, name).toBeDefined();
      expect(die.vWidth).toBe(setup.dieV); expect(die.vAngle).toBe(setup.dieAngle);
      expect(die.shoulderRadius).toBe(setup.shoulderRadius);
      expect(punch.tipRadius).toBe(setup.punchTipRadius);
      const mat = lib.materials.find(x => x.id === truth.material.id)!;
      expect(mat.tensileStrength).toBe(truth.material.Rm); expect(mat.kFactor).toBe(truth.material.k);
      expect(mat.springbackDeg).toBe(truth.material.sb); expect(mat.minInnerRadiusFactor).toBe(truth.material.minR);
      // the truth's force per metre is well inside the tool ratings
      const golden = Object.values(truth.expected.perBend)[0]!;
      const fpm = airBendForcePerMeter(mat.tensileStrength, truth.thickness, die.vWidth);
      expect(fpm).toBeCloseTo(golden.forcePerMeter, 6);
      const chk = toolLoadCheck(fpm, punch, die);
      expect(chk.ok).toBe(true); expect(chk.percentOfTool).toBeCloseTo((100 * fpm) / Math.min(punch.maxLoadPerMeter, die.maxLoadPerMeter), 9);
      // the ram depth of every sample bend fits the default machine stroke
      const machine = lib.machines[0]!;
      expect(strokeCheck(machine, punch, die, golden.ramDepthSharpShoulder).ok).toBe(true);
      expect(ramDepth(die.vWidth, truth.thickness, golden.actualInnerRadius, golden.loadedIncludedAngle)).toBeCloseTo(golden.ramDepthSharpShoulder, 6);
    }
    expect(lib.fingers.some(f => f.id === STANDARD_FINGER_ID)).toBe(true);
    expect(lib.materials.some(m => m.id === STANDARD_MATERIAL_ID)).toBe(true);
  });
});

describe('checks', () => {
  const lib = buildStandardLibrary();
  const machine = lib.machines[0]!;
  const punch = lib.punches[0]!;
  const die = lib.dies.find(d => d.id === 'std:die-v16-88')!;

  it('toolLoadCheck: percent of the weakest rating, overload and near-limit messages', () => {
    const gooseneck = lib.punches.find(p => p.id === 'std:punch-gooseneck-88-r0.8')!;
    expect(toolLoadCheck(300, gooseneck, die)).toMatchObject({ ok: true, percentOfTool: 50, limitingTool: gooseneck.name });
    const near = toolLoadCheck(570, gooseneck, die);
    expect(near.ok).toBe(true); expect(near.message?.key).toBe('warnings.tool.loadNearLimit');
    const over = toolLoadCheck(700, gooseneck, die);
    expect(over.ok).toBe(false); expect(over.message?.key).toBe('warnings.tool.overload'); expect(over.message?.severity).toBe('error');
    expect(over.message?.params).toMatchObject({ tool: gooseneck.name });
    const v6 = lib.dies.find(d => d.id === 'std:die-v6-88')!;
    expect(toolLoadCheck(150, punch, v6)).toMatchObject({ ok: true, percentOfTool: 50, limitingTool: v6.name });
  });

  it('daylightCheck: stack 240 under a 420 daylight leaves 180 for the part (+20 margin)', () => {
    expect(daylightCheck(machine, punch, die, 100)).toMatchObject({ ok: true, stack: 240, tipClearance: 180 });
    expect(daylightCheck(machine, punch, die, 160).ok).toBe(true);
    const tall = daylightCheck(machine, punch, die, 170);
    expect(tall.ok).toBe(false); expect(tall.message?.key).toBe('warnings.machine.daylight');
    const small = daylightCheck({ ...machine, daylight: 200 }, punch, die, 10);
    expect(small.ok).toBe(false); expect(small.message?.key).toBe('warnings.machine.stackTooTall');
  });

  it('strokeCheck: 20 mm max depth on the default machine with the 60 + 120 stack', () => {
    const s = strokeCheck(machine, punch, die, 13.2);
    expect(s.ok).toBe(true); expect(s.maxRamDepth).toBeCloseTo(20, 9);
    const deep = strokeCheck(machine, punch, die, 25);
    expect(deep.ok).toBe(false); expect(deep.message?.key).toBe('warnings.machine.stroke');
  });
});
