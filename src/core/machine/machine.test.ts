import { describe, it, expect } from 'vitest';
import { bounds, isCCW, pointInPolygon, polygonsIntersect } from '../geom';
import { punchTipY } from '../bend';
import { buildStandardLibrary } from '../tools/standard';
import { defaultMachine, machineLevels } from './default';
import { validateMachine, validateSetup } from './validate';
import { machineObstacles } from './obstacles';
import type { Machine, ToolSetup } from '../types';

const lib = buildStandardLibrary();

function setup(overrides: Partial<ToolSetup['stations'][number]> = {}, machineId = 'std:machine-generic-100t'): ToolSetup {
  return {
    machineId,
    stations: [{ id: 'S1', punchId: 'std:punch-straight-88-r0.8', dieId: 'std:die-v16-88', zStart: 0, zEnd: 835, segments: [835], punchFlipped: false, dieFlipped: false, ...overrides }],
  };
}

describe('defaultMachine / machineLevels', () => {
  it('matches ARCHITECTURE and passes validation', () => {
    const m = defaultMachine();
    expect(m.id).toBe('std:machine-generic-100t');
    expect([m.capacity, m.bedLength, m.stroke, m.daylight, m.throatDepth, m.distanceBetweenFrames]).toEqual([1000, 3100, 200, 420, 400, 2600]);
    expect(m.ram).toMatchObject({ thickness: 60, height: 400, clampThickness: 110, clampHeight: 90, clampFrontOffset: 55, speeds: { approach: 100, bend: 10, retract: 100 } });
    expect(m.table).toEqual({ width: 120, holderWidth: 60, holderHeight: 60, height: 500 });
    expect(m.backgauge).toMatchObject({ xMin: 10, xMax: 750, rMin: -25, rMax: 150, zMin: 0, zMax: 3100, fingerCount: 2, fingerId: 'std:finger-flat', independentX: true, independentR: true, beamDepth: 100, beamHeight: 60, retractAtPinch: 0 });
    expect(validateMachine(m)).toEqual([]);
    const lv = machineLevels(m);
    expect(lv).toEqual({ tableTopY: -120, holderTopY: -60, tdcClampY: 300, bdcClampY: 100, tipAtTdcY: 180, maxRamDepth: 20 });
  });

  it('rejects a daylight too small and a stroke too short', () => {
    const small = validateMachine({ ...defaultMachine(), daylight: 200 });
    expect(small.some(x => x.key === 'warnings.machine.stackTooTall' && x.severity === 'error')).toBe(true);
    const short = validateMachine({ ...defaultMachine(), stroke: 150 });
    expect(short.some(x => x.key === 'warnings.machine.strokeTooShort')).toBe(true);
    // a taller stack needs more daylight; a deeper nominal ram depth needs more stroke
    expect(validateMachine(defaultMachine(), { dieHeight: 250 }).some(x => x.key === 'warnings.machine.stackTooTall')).toBe(true);
    expect(validateMachine(defaultMachine(), { maxRamDepth: 30 }).some(x => x.key === 'warnings.machine.strokeTooShort')).toBe(true);
    expect(validateMachine({ ...defaultMachine(), daylight: 460, stroke: 240 }, { dieHeight: 100 })).toEqual([]);
  });

  it('range and structure errors', () => {
    const m = defaultMachine();
    const bad: Machine = { ...m, backgauge: { ...m.backgauge, xMin: 800 }, ram: { ...m.ram, clampFrontOffset: 200 } };
    const msgs = validateMachine(bad);
    expect(msgs.map(x => x.params?.field)).toEqual(expect.arrayContaining(['ram.clampFrontOffset', 'backgauge.x']));
    const nan = validateMachine({ ...m, capacity: NaN, table: { ...m.table, holderHeight: 0 } });
    expect(nan.map(x => x.params?.field)).toEqual(expect.arrayContaining(['capacity', 'table.holderHeight']));
    const wide = validateMachine({ ...m, distanceBetweenFrames: 3500 });
    expect(wide.some(x => x.key === 'warnings.machine.framesWiderThanBed' && x.severity === 'warning')).toBe(true);
  });
});

describe('validateSetup', () => {
  const m = defaultMachine();

  it('accepts a good single-station setup', () => {
    expect(validateSetup(setup(), m, lib)).toEqual([]);
    expect(validateSetup(setup({ segments: [] }), m, lib)).toEqual([]);
    expect(validateSetup(setup({ segments: [415, 300, 100, 20] }), m, lib)).toEqual([]);
  });

  it('reports unknown tools, bed overflow, overlap, segment mismatch and stack', () => {
    expect(validateSetup(setup({ punchId: 'std:nope' }), m, lib).map(x => x.key)).toContain('warnings.setup.unknownTool');
    expect(validateSetup(setup({ zEnd: 3200 }), m, lib).map(x => x.key)).toContain('warnings.setup.stationOutsideBed');
    expect(validateSetup(setup({ zStart: 100, zEnd: 50 }), m, lib).map(x => x.key)).toContain('warnings.setup.stationReversed');
    expect(validateSetup(setup({ segments: [835, 100] }), m, lib).map(x => x.key)).toContain('warnings.setup.segmentsMismatch');
    const odd = validateSetup(setup({ segments: [800, 35] }), m, lib);
    expect(odd.filter(x => x.key === 'warnings.setup.segmentNotAvailable')).toHaveLength(2);
    const two: ToolSetup = { machineId: m.id, stations: [setup().stations[0]!, { ...setup().stations[0]!, id: 'S2', zStart: 800, zEnd: 1600, segments: [] }] };
    expect(validateSetup(two, m, lib).map(x => x.key)).toContain('warnings.setup.stationsOverlap');
    const dup: ToolSetup = { machineId: m.id, stations: [setup().stations[0]!, { ...setup().stations[0]!, zStart: 1000, zEnd: 1500, segments: [] }] };
    expect(validateSetup(dup, m, lib).map(x => x.key)).toContain('warnings.setup.duplicateStation');
    const mixed: ToolSetup = { machineId: m.id, stations: [setup().stations[0]!, { ...setup().stations[0]!, id: 'S2', dieId: 'std:die-v50-88', zStart: 1000, zEnd: 1500, segments: [] }] };
    expect(validateSetup(mixed, m, lib).map(x => x.key)).toContain('warnings.setup.mixedDieHeights');
    const tall = validateSetup(setup(), { ...m, daylight: 230 }, lib);
    expect(tall.map(x => x.key)).toContain('warnings.setup.stackTooTall');
    expect(validateSetup({ machineId: m.id, stations: [] }, m, lib).map(x => x.key)).toEqual(['warnings.setup.noStations']);
    expect(validateSetup(setup({}, 'other'), m, lib).map(x => x.key)).toContain('warnings.setup.machineMismatch');
    expect(validateSetup(setup(), { ...m, backgauge: { ...m.backgauge, fingerId: 'x' } }, lib).map(x => x.key)).toContain('warnings.setup.unknownFinger');
  });
});

describe('machineObstacles', () => {
  const m = defaultMachine();
  const punch = lib.punches.find(p => p.id === 'std:punch-straight-88-r0.8')!;
  const finger = lib.fingers.find(f => f.id === 'std:finger-flat')!;
  const ramY = 180 + punch.height; // tip 180 above the die (TDC)
  const fingers = [{ x: 100, r: -9, z: 200 }, { x: 100, r: -9, z: 600 }];
  const obs = machineObstacles(m, setup(), lib, ramY, fingers);
  const byId = (id: string) => obs.find(o => o.id === id)!;

  it('produces every kind with CCW polygons and plausible extents', () => {
    const kinds = new Set(obs.map(o => o.kind));
    for (const k of ['punch', 'clamp', 'ram', 'die', 'holder', 'table', 'finger', 'backgauge-beam', 'frame']) expect(kinds.has(k as never), k).toBe(true);
    for (const o of obs) { expect(isCCW(o.polygon), o.id).toBe(true); expect(o.polygon.length).toBeGreaterThanOrEqual(3); }
    // punch above: tip at ramY − height, tang top at ramY
    const p = byId('punch:S1');
    expect(bounds(p.polygon).min.y).toBeCloseTo(ramY - punch.height, 9);
    expect(bounds(p.polygon).max.y).toBeCloseTo(ramY, 9);
    expect(p.zRange).toEqual([0, 835]);
    // clamp from −55 to +55 at ramY..ramY+90, ram beam above it
    const c = byId('clamp:S1');
    expect(bounds(c.polygon)).toEqual({ min: { x: -55, y: ramY }, max: { x: 55, y: ramY + 90 } });
    const r = byId('ram');
    expect(bounds(r.polygon)).toEqual({ min: { x: -30, y: ramY + 90 }, max: { x: 30, y: ramY + 490 } });
    expect(r.zRange).toBe('full');
    // die below at the origin, holder and table under it
    const d = byId('die:S1');
    expect(bounds(d.polygon).max.y).toBe(0); expect(bounds(d.polygon).min.y).toBe(-60);
    expect(pointInPolygon({ x: 0, y: -0.5 }, d.polygon)).toBe(false);
    expect(bounds(byId('holder').polygon)).toEqual({ min: { x: -30, y: -120 }, max: { x: 30, y: -60 } });
    expect(bounds(byId('table').polygon)).toEqual({ min: { x: -60, y: -620 }, max: { x: 60, y: -120 } });
    // fingers: stop face at x = X, from R up to R + stopHeight, z ± width/2
    const f0 = byId('finger:0');
    expect(bounds(f0.polygon).min.x).toBe(100);
    expect(bounds(f0.polygon).min.y).toBe(-9); expect(bounds(f0.polygon).max.y).toBe(-9 + finger.height);
    expect(f0.zRange).toEqual([185, 215]);
    expect(f0.polygon.some(q => q.x === 100 && q.y === -9)).toBe(true);
    expect(f0.polygon.some(q => q.x === 100 && q.y === -9 + finger.stopHeight)).toBe(true);
    expect(byId('finger:1').zRange).toEqual([585, 615]);
    // beam behind the fingers
    const b = byId('backgauge-beam');
    expect(bounds(b.polygon)).toEqual({ min: { x: 160, y: -9 }, max: { x: 260, y: 51 } });
    expect(b.zRange).toBe('full');
    // frames: X ≥ throatDepth, outside the 2600 between frames centred on the 3100 bed
    expect(byId('frame:left').zRange).toEqual([250 - 5000, 250]);
    expect(byId('frame:right').zRange).toEqual([2850, 2850 + 5000]);
    expect(bounds(byId('frame:left').polygon).min.x).toBe(400);
    // clamp gap covers the rest of the bed centred on the bend line
    const gap = byId('clamp:gap-0');
    expect(gap.zRange).toEqual([835, 3100]);
    expect(bounds(gap.polygon).min.x).toBe(-55);
  });

  it('a flat sheet on the die touches neither punch (at TDC) nor obstacles except the die top', () => {
    const sheet = [{ x: -100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 2 }, { x: -100, y: 2 }];
    for (const o of obs) {
      if (o.kind === 'die') continue; // intended contact
      if (o.kind === 'finger') continue; // fingers at x = 100 touch the sheet edge — intended gauge contact
      expect(polygonsIntersect(sheet, o.polygon), o.id).toBe(false);
    }
    // at the pinch (ramY = punchTipY(0) + height = t + height) the punch tip touches the sheet top
    const pinch = machineObstacles(m, setup(), lib, punchTipY(16, 2, 2.56, 0) + punch.height, []);
    const p = pinch.find(o => o.id === 'punch:S1')!;
    expect(bounds(p.polygon).min.y).toBeCloseTo(2, 9);
  });

  it('flipped tools mirror in X and the clamp follows the gooseneck tang', () => {
    const gn: ToolSetup = setup({ punchId: 'std:punch-gooseneck-88-r0.8' });
    const o1 = machineObstacles(m, gn, lib, ramY, []);
    const c1 = o1.find(o => o.id === 'clamp:S1')!;
    expect(bounds(c1.polygon).min.x).toBe(7 - 55); expect(bounds(c1.polygon).max.x).toBe(7 + 55);
    const p1 = o1.find(o => o.id === 'punch:S1')!;
    expect(bounds(p1.polygon).min.x).toBe(-12); expect(bounds(p1.polygon).max.x).toBe(26);
    const o2 = machineObstacles(m, setup({ punchId: 'std:punch-gooseneck-88-r0.8', punchFlipped: true, dieFlipped: true }), lib, ramY, []);
    const c2 = o2.find(o => o.id === 'clamp:S1')!;
    expect(bounds(c2.polygon).min.x).toBe(-7 - 55); expect(bounds(c2.polygon).max.x).toBe(-7 + 55);
    const p2 = o2.find(o => o.id === 'punch:S1')!;
    expect(bounds(p2.polygon).min.x).toBe(-26); expect(bounds(p2.polygon).max.x).toBe(12);
    expect(isCCW(p2.polygon)).toBe(true);
    expect(isCCW(o2.find(o => o.id === 'die:S1')!.polygon)).toBe(true);
  });

  it('no stations: full-length clamp, default die height, unknown finger falls back', () => {
    const o = machineObstacles({ ...m, backgauge: { ...m.backgauge, fingerId: 'nope' } }, { machineId: m.id, stations: [] }, lib, ramY, [{ x: 50, r: 0, z: 100 }]);
    expect(o.find(x => x.id === 'clamp:gap-0')!.zRange).toBe('full');
    expect(o.some(x => x.kind === 'punch')).toBe(false);
    expect(bounds(o.find(x => x.id === 'holder')!.polygon).min.y).toBe(-120);
    expect(bounds(o.find(x => x.id === 'finger:0')!.polygon).max.y).toBe(35);
    // taller dies push the table down
    const o2 = machineObstacles(m, setup({ dieId: 'std:die-v50-88' }), lib, ramY, []);
    expect(bounds(o2.find(x => x.id === 'holder')!.polygon).max.y).toBe(-90);
    expect(bounds(o2.find(x => x.id === 'table')!.polygon).max.y).toBe(-150);
  });
});
