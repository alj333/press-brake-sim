/**
 * Reviewer edge-case tests for src/core/machine: nested stations, odd machines, obstacle
 * placement semantics (does the clamp really hit a tall standing flange?), flipped asymmetric
 * dies, overhanging parts vs. the side frames.
 */
import { describe, it, expect } from 'vitest';
import { bounds, isCCW, polygonsIntersect, pointInPolygon } from '../geom';
import { punchTipY } from '../bend';
import { buildStandardLibrary } from '../tools/standard';
import { isSimplePolygon } from '../tools/profile';
import { defaultMachine, machineLevels } from './default';
import { validateMachine, validateSetup } from './validate';
import { machineObstacles, FRAME_THICKNESS } from './obstacles';
import type { Machine, ToolSetup, ToolStation } from '../types';

const lib = buildStandardLibrary();
const m = defaultMachine();

function station(over: Partial<ToolStation> = {}): ToolStation {
  return { id: 'S1', punchId: 'std:punch-straight-88-r0.8', dieId: 'std:die-v16-88', zStart: 0, zEnd: 835, segments: [835], punchFlipped: false, dieFlipped: false, ...over };
}
function setupOf(...stations: ToolStation[]): ToolSetup { return { machineId: m.id, stations }; }
const keys = (setup: ToolSetup, machine: Machine = m) => validateSetup(setup, machine, lib).map(x => x.key);

describe('validateSetup — overlaps and ranges', () => {
  it('a station enclosing two others is reported against each of them', () => {
    const nested = setupOf(
      station({ id: 'A', zStart: 0, zEnd: 3000, segments: [] }),
      station({ id: 'B', zStart: 100, zEnd: 200, segments: [] }),
      station({ id: 'C', zStart: 300, zEnd: 400, segments: [] }),
    );
    const overlaps = validateSetup(nested, m, lib).filter(x => x.key === 'warnings.setup.stationsOverlap').map(x => `${x.params?.a}-${x.params?.b}`);
    expect(overlaps.sort()).toEqual(['A-B', 'A-C']);
  });

  it('touching stations do not overlap; negative zStart is outside the bed; zero length is reversed', () => {
    expect(keys(setupOf(station({ id: 'A', zEnd: 835 }), station({ id: 'B', zStart: 835, zEnd: 1670, segments: [835] })))).toEqual([]);
    expect(keys(setupOf(station({ zStart: -1, zEnd: 834 })))).toContain('warnings.setup.stationOutsideBed');
    expect(keys(setupOf(station({ zStart: 100, zEnd: 100, segments: [] })))).toContain('warnings.setup.stationReversed');
    // a reversed station must not also be flagged as overlapping its neighbour
    const msgs = keys(setupOf(station({ id: 'A', zStart: 500, zEnd: 400, segments: [] }), station({ id: 'B', zStart: 600, zEnd: 700, segments: [] })));
    expect(msgs).not.toContain('warnings.setup.stationsOverlap');
  });

  it('both tools unknown → two unknownTool errors, no stack/segment checks', () => {
    const msgs = validateSetup(setupOf(station({ punchId: 'x', dieId: 'y' })), m, lib);
    expect(msgs.filter(x => x.key === 'warnings.setup.unknownTool')).toHaveLength(2);
    expect(msgs.every(x => x.severity === 'error')).toBe(true);
  });
});

describe('validateMachine — more fields', () => {
  it('rejects a zero finger count, NaN offsets, inverted R range, negative retract and a gauge below the bed start', () => {
    const bad: Machine = {
      ...m,
      backgauge: { ...m.backgauge, fingerCount: 0, rMin: 10, rMax: 5, retractAtPinch: -1, zMin: -10 },
      ram: { ...m.ram, clampFrontOffset: NaN },
    };
    const first = validateMachine(bad).map(x => x.params?.field);
    expect(first).toEqual(expect.arrayContaining(['backgauge.fingerCount', 'ram.clampFrontOffset']));
    const ranges = validateMachine({ ...bad, backgauge: { ...bad.backgauge, fingerCount: 2 }, ram: { ...m.ram } });
    expect(ranges.map(x => x.params?.field)).toEqual(expect.arrayContaining(['backgauge.r', 'backgauge.retractAtPinch']));
    expect(ranges.map(x => x.key)).toContain('warnings.machine.gaugeBeyondBed');
  });

  it('machineLevels for a non-default stack (90 die, 67 punch)', () => {
    const lv = machineLevels(m, 90, 67);
    expect(lv.tableTopY).toBe(-150); expect(lv.holderTopY).toBe(-90);
    expect(lv.tdcClampY).toBe(270); expect(lv.bdcClampY).toBe(70); expect(lv.tipAtTdcY).toBe(203); expect(lv.maxRamDepth).toBe(-3);
    // a punch too short for the stroke: the tip never reaches the die plane → validateMachine flags the nominal stack
    expect(validateMachine(m, { dieHeight: 90, punchHeight: 67 }).map(x => x.key)).toContain('warnings.machine.strokeTooShort');
  });
});

describe('machineObstacles — semantics', () => {
  const punch = lib.punches.find(p => p.id === 'std:punch-straight-88-r0.8')!;
  const t = 2, V = 16, ri = 2.56;
  const tdcRamY = machineLevels(m).tdcClampY;
  const pinchRamY = punchTipY(V, t, ri, 0, 1.5) + punch.height;

  it('every obstacle is a simple CCW polygon at TDC, at the pinch and at full depth', () => {
    for (const ramY of [tdcRamY, pinchRamY, punch.height - 20]) {
      const obs = machineObstacles(m, setupOf(station()), lib, ramY, [{ x: 100, r: -9, z: 200 }, { x: 250, r: 20, z: 600 }]);
      for (const o of obs) {
        expect(isCCW(o.polygon), `${o.id} @ ${ramY}`).toBe(true);
        expect(isSimplePolygon(o.polygon), `${o.id} @ ${ramY}`).toBe(true);
        if (o.zRange !== 'full') expect(o.zRange[0]).toBeLessThan(o.zRange[1]);
      }
      // the punch tip follows the ram: tip y = ramY − height
      expect(bounds(obs.find(o => o.id === 'punch:S1')!.polygon).min.y).toBeCloseTo(ramY - punch.height, 9);
    }
  });

  it('a 130 mm standing flange behind the bend line hits the clamp at the pinch, a 50 mm one does not', () => {
    const obs = machineObstacles(m, setupOf(station()), lib, pinchRamY, []);
    const clamp = obs.find(o => o.id === 'clamp:S1')!;
    const ram = obs.find(o => o.id === 'ram')!;
    const flange = (h: number) => [{ x: 40, y: 0 }, { x: 42, y: 0 }, { x: 42, y: h }, { x: 40, y: h }];
    expect(polygonsIntersect(flange(50), clamp.polygon)).toBe(false);
    expect(polygonsIntersect(flange(130), clamp.polygon)).toBe(true);   // clamp bottom at 122 (= t + 120)
    expect(polygonsIntersect(flange(130), ram.polygon)).toBe(false);    // ram starts 90 above the clamp bottom
    expect(polygonsIntersect(flange(230), ram.polygon)).toBe(false);    // ...and is only ±30 wide: x = 40 is beside it
    const nearFlange = [{ x: 20, y: 0 }, { x: 22, y: 0 }, { x: 22, y: 230 }, { x: 20, y: 230 }];
    expect(polygonsIntersect(nearFlange, ram.polygon)).toBe(true);
    // a flange 60 mm in front of the bend line clears the 110 mm clamp (front face at −55) and the ±30 ram
    const front = [{ x: -62, y: 0 }, { x: -60, y: 0 }, { x: -60, y: 300 }, { x: -62, y: 300 }];
    expect(polygonsIntersect(front, clamp.polygon)).toBe(false);
    expect(polygonsIntersect(front, ram.polygon)).toBe(false);
  });

  it('the gauged sheet edge meets the flat finger mid-face at R = −(stopHeight − t)/2', () => {
    const obs = machineObstacles(m, setupOf(station()), lib, tdcRamY, [{ x: 100, r: -9, z: 200 }]);
    const f = obs.find(o => o.id === 'finger:0')!;
    // stop face x = 100 from y = −9 to 11: the sheet (y ∈ [0, 2]) touches it and nothing below the die plane blocks it
    expect(pointInPolygon({ x: 100.5, y: 1 }, f.polygon)).toBe(true);
    expect(pointInPolygon({ x: 99.5, y: 1 }, f.polygon)).toBe(false);
    const sheet = [{ x: -50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 2 }, { x: -50, y: 2 }];
    for (const o of obs) if (o.kind !== 'die' && o.kind !== 'finger') expect(polygonsIntersect(sheet, o.polygon), o.id).toBe(false);
  });

  it('fingers at different R: the beam spans from the lowest to the highest finger plus its height', () => {
    const obs = machineObstacles(m, setupOf(station()), lib, tdcRamY, [{ x: 100, r: -9, z: 200 }, { x: 150, r: 30, z: 600 }]);
    const beam = obs.find(o => o.id === 'backgauge-beam')!;
    expect(bounds(beam.polygon)).toEqual({ min: { x: 210, y: -9 }, max: { x: 310, y: 90 } });
    // no fingers → no beam, no finger obstacles
    const none = machineObstacles(m, setupOf(station()), lib, tdcRamY, []);
    expect(none.some(o => o.kind === 'finger' || o.kind === 'backgauge-beam')).toBe(false);
  });

  it('a flipped multi-V die (asymmetric profile) stays CCW with the active V still at the origin', () => {
    const obs = machineObstacles(m, setupOf(station({ dieId: 'std:die-multi-v22', dieFlipped: true })), lib, tdcRamY, []);
    const die = obs.find(o => o.id === 'die:S1')!;
    expect(isCCW(die.polygon)).toBe(true);
    expect(isSimplePolygon(die.polygon)).toBe(true);
    expect(pointInPolygon({ x: 0, y: -0.5 }, die.polygon)).toBe(false);   // inside the active notch
    expect(pointInPolygon({ x: 0, y: -45 }, die.polygon)).toBe(true);     // block centre
    // V22 up ⇒ V35 on +X (18.1 deep: x = 36 is inside the notch) and V16 on −X (8.3 deep: x = −36 is material);
    // flipping swaps the sides
    const plain = machineObstacles(m, setupOf(station({ dieId: 'std:die-multi-v22' })), lib, tdcRamY, []).find(o => o.id === 'die:S1')!;
    expect(pointInPolygon({ x: 36, y: -45 }, plain.polygon)).toBe(false);
    expect(pointInPolygon({ x: -36, y: -45 }, plain.polygon)).toBe(true);
    expect(pointInPolygon({ x: 36, y: -45 }, die.polygon)).toBe(true);
    expect(pointInPolygon({ x: -36, y: -45 }, die.polygon)).toBe(false);
    // the table level follows the 90 mm block
    expect(bounds(obs.find(o => o.id === 'holder')!.polygon).max.y).toBe(-90);
  });

  it('a station with unknown tools still gets its clamp; frames catch a sheet overhanging the bed', () => {
    const obs = machineObstacles(m, setupOf(station({ punchId: 'nope', dieId: 'nope' })), lib, tdcRamY, []);
    expect(obs.some(o => o.kind === 'punch' || o.kind === 'die')).toBe(false);
    expect(obs.find(o => o.id === 'clamp:S1')!.zRange).toEqual([0, 835]);
    const left = obs.find(o => o.id === 'frame:left')!, right = obs.find(o => o.id === 'frame:right')!;
    expect(FRAME_THICKNESS).toBeGreaterThanOrEqual(2000);
    expect(left.zRange).toEqual([250 - FRAME_THICKNESS, 250]);
    expect(right.zRange).toEqual([2850, 2850 + FRAME_THICKNESS]);
    // a 4 m sheet centred on the 3.1 m bed overhangs to z = −450 / 3550: both ends are inside a frame's z range
    const lz = left.zRange as [number, number], rz = right.zRange as [number, number];
    expect(-450).toBeGreaterThan(lz[0]); expect(3550).toBeLessThan(rz[1]);
    // the frame starts at the throat depth and covers the whole machine height
    const b = bounds(left.polygon);
    expect(b.min.x).toBe(m.throatDepth);
    expect(b.min.y).toBeLessThan(-600); expect(b.max.y).toBeGreaterThan(tdcRamY + m.ram.clampHeight + m.ram.height);
  });

  it('stations given out of order are handled, with clamp gaps between them', () => {
    const obs = machineObstacles(m, setupOf(station({ id: 'B', zStart: 2000, zEnd: 2835 }), station({ id: 'A', zStart: 0, zEnd: 835 })), lib, tdcRamY, []);
    const gaps = obs.filter(o => o.id.startsWith('clamp:gap')).map(o => o.zRange);
    expect(gaps).toEqual([[835, 2000], [2835, 3100]]);
  });
});
