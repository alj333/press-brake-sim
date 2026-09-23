import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth } from '../testing/fixtures';
import { buildStandardLibrary } from './standard';
import { defaultToolSetup, pickDieForThickness, segmentsForLength } from './setup';
import { defaultMachine } from '../machine/default';
import { validateSetup } from '../machine/validate';

const lib = buildStandardLibrary();
const m = defaultMachine();

describe('default tool setup', () => {
  it('segmentsForLength composes exact lengths from the standard pieces', () => {
    const pieces = [10, 15, 20, 40, 50, 100, 200, 300, 415, 835];
    for (const L of [10, 15, 25, 35, 100, 835, 1000, 2500, 3100, 4085]) {
      const segs = segmentsForLength(L, pieces);
      expect(segs.reduce((a, b) => a + b, 0), `L=${L}`).toBe(L);
      for (const s of segs) expect(pieces).toContain(s);
    }
    expect(segmentsForLength(25, pieces)).toEqual([15, 10]);
    expect(segmentsForLength(3100, pieces)).toEqual([835, 835, 835, 415, 100, 50, 20, 10]);
  });

  it('picks the V closest to recommendedV(t)', () => {
    expect(pickDieForThickness(lib.dies, 2)!.id).toBe('std:die-v16-88');
    expect(pickDieForThickness(lib.dies, 1.5)!.id).toBe('std:die-v12-88');
    expect(pickDieForThickness(lib.dies, 1)!.id).toBe('std:die-v8-88');
    expect(pickDieForThickness(lib.dies, 3)!.id).toBe('std:die-v25-88');
    expect(pickDieForThickness(lib.dies, 6)!.id).toBe('std:die-v63-88');
    expect(pickDieForThickness(lib.dies, 8)!.id).toBe('std:die-v80-88');
    expect(pickDieForThickness(lib.dies, 1.5, 30)!.id).toBe('std:die-v12-30');
    expect(pickDieForThickness([], 2)).toBeUndefined();
  });

  it('matches every sample truth defaultSetup and validates on the default machine', () => {
    for (const name of SAMPLE_NAMES) {
      const truth = loadTruth(name);
      const setup = defaultToolSetup(lib, m, truth.thickness)!;
      expect(setup, name).not.toBeNull();
      const st = setup.stations[0]!;
      expect(st.punchId).toBe(truth.expected.defaultSetup.punch);
      expect(st.dieId).toBe(truth.expected.defaultSetup.die);
      expect(st.zStart).toBe(0); expect(st.zEnd).toBe(3100);
      expect(st.segments.reduce((a, b) => a + b, 0)).toBe(3100);
      expect(validateSetup(setup, m, lib)).toEqual([]);
    }
    expect(defaultToolSetup({ punches: [], dies: lib.dies }, m, 2)).toBeNull();
    const custom = defaultToolSetup(lib, m, 2, { dieId: 'std:die-v20-88', zStart: 100, zEnd: 600, stationId: 'A' })!;
    expect(custom.stations[0]).toMatchObject({ id: 'A', dieId: 'std:die-v20-88', zStart: 100, zEnd: 600 });
    expect(custom.stations[0]!.segments.reduce((a, b) => a + b, 0)).toBe(500);
  });
});
