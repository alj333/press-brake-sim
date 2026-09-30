import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth } from '../testing/fixtures';
import { buildStandardLibrary } from './standard';
import { defaultToolSetup, pickDieForThickness, segmentsForLength } from './setup';
import { defaultMachine } from '../machine/default';
import { validateSetup } from '../machine/validate';
import { MOTIONX_DIE_SLOT_IDS, MOTIONX_PUNCH_ID, MOTIONX_PUNCH_INVENTORY } from './factory';
import { vDie } from './dies';

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
    expect(segmentsForLength(300, [100, 100], false)).toEqual([100, 100]);
    expect(segmentsForLength(250, [100, 100, 50], false)).toEqual([100, 100, 50]);
    expect(segmentsForLength(400, [100, 100, 50], false)).toEqual([100, 100, 50]);
  });

  it('picks only in-stock V grooves closest to recommendedV(t)', () => {
    expect(pickDieForThickness(lib.dies, 2, null)!.id).toBe(MOTIONX_DIE_SLOT_IDS[1]);
    expect(pickDieForThickness(lib.dies, 1.5, null)!.id).toBe(MOTIONX_DIE_SLOT_IDS[7]);
    expect(pickDieForThickness(lib.dies, 1, null)!.id).toBe(MOTIONX_DIE_SLOT_IDS[4]);
    expect(pickDieForThickness(lib.dies, 3, null)!.id).toBe(MOTIONX_DIE_SLOT_IDS[2]);
    expect(pickDieForThickness(lib.dies, 6, null)!.id).toBe(MOTIONX_DIE_SLOT_IDS[6]);
    expect(pickDieForThickness(lib.dies, 8, null)!.id).toBe(MOTIONX_DIE_SLOT_IDS[6]);
    expect(pickDieForThickness(lib.dies, 1.5, 30)).toBeUndefined();
    expect(pickDieForThickness([vDie({ vWidth: 12, vAngle: 30 })], 1.5, 30)!.id).toBe('std:die-v12-30');
    expect(pickDieForThickness([], 2)).toBeUndefined();
  });

  it('mounts the real factory punch and an in-stock groove with bounded physical segments', () => {
    for (const name of SAMPLE_NAMES) {
      const truth = loadTruth(name);
      const setup = defaultToolSetup(lib, m, truth.thickness)!;
      expect(setup, name).not.toBeNull();
      const st = setup.stations[0]!;
      expect(st.punchId).toBe(MOTIONX_PUNCH_ID);
      expect(lib.dies.find(die => die.id === st.dieId)?.stockStatus).toBe('in-stock');
      expect(st.zStart).toBe(317.5); expect(st.zEnd).toBe(2782.5);
      expect(st.segments.reduce((a, b) => a + b, 0)).toBe(2465);
      for (const item of MOTIONX_PUNCH_INVENTORY) {
        expect(st.segments.filter(length => length === item.length)).toHaveLength(item.quantity);
      }
      const setupMessages = validateSetup(setup, m, lib);
      expect(setupMessages.map(message => message.key)).toEqual([
        'warnings.setup.controllerCadGeometryMismatch',
        'warnings.setup.dieLengthUnverified',
      ]);
      expect(setupMessages[0]?.severity).toBe('warning');
    }
    expect(defaultToolSetup({ punches: [], dies: lib.dies }, m, 2)).toBeNull();
    const custom = defaultToolSetup(lib, m, 2, { dieId: 'std:die-v20-88', zStart: 100, zEnd: 600, stationId: 'A' })!;
    expect(custom.stations[0]).toMatchObject({ id: 'A', dieId: 'std:die-v20-88', zStart: 100, zEnd: 600 });
    expect(custom.stations[0]!.segments.reduce((a, b) => a + b, 0)).toBe(500);
  });

  it('keeps the MotionX core die as the automatic default when another stocked die is imported', () => {
    const competing = {
      ...vDie({ vWidth: 16, vAngle: 88 }),
      id: 'custom:stocked-v16', name: 'Imported stocked V16', source: 'custom' as const,
      stockStatus: 'in-stock' as const,
    };
    const setup = defaultToolSetup({ punches: lib.punches, dies: [competing, ...lib.dies] }, m, 2)!;
    expect(setup.stations[0]!.punchId).toBe(MOTIONX_PUNCH_ID);
    expect(setup.stations[0]!.dieId).toBe(MOTIONX_DIE_SLOT_IDS[1]);
  });
});
