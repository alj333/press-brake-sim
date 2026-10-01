import { describe, expect, it } from 'vitest';
import { bounds, isCCW } from '../geom';
import { deriveDieParams, derivePunchParams } from './derive';
import {
  MOTIONX_DIE_PHYSICAL_ID,
  MOTIONX_DIE_SLOT_IDS,
  MOTIONX_PUNCH_DRAWING_SOURCE_SHA256,
  MOTIONX_PUNCH_CAD_SPEC,
  MOTIONX_PUNCH_ID,
  MOTIONX_PUNCH_INVENTORY,
  MOTIONX_PUNCH_SPEC,
  motionXDieGeometryDiscrepancy,
  motionXFactoryDies,
  motionXFactoryPunch,
  motionXPunchGeometryDiscrepancy,
} from './factory';
import { isSimplePolygon } from './profile';

describe('MotionX factory tooling', () => {
  it('uses the selected 86° / R0.6 drawing geometry and bounded 10-piece inventory with a conservative A360 outline', () => {
    const punch = motionXFactoryPunch();
    const derived = derivePunchParams(punch.profile.points);
    const ext = bounds(punch.profile.points);

    expect(punch.id).toBe(MOTIONX_PUNCH_ID);
    expect(punch.stockStatus).toBe('in-stock');
    expect(punch.maxLoadPerMeter).toBe(0);
    expect(punch.segmentInventory).toEqual(MOTIONX_PUNCH_INVENTORY);
    expect(punch.segmentInventory).toEqual([
      { length: 10, quantity: 1 },
      { length: 15, quantity: 1 },
      { length: 20, quantity: 1 },
      { length: 50, quantity: 1 },
      { length: 100, quantity: 2 },
      { length: 200, quantity: 1 },
      { length: 300, quantity: 1 },
      { length: 835, quantity: 2 },
    ]);
    expect(punch.segmentInventory!.reduce((total, item) => total + item.length * item.quantity, 0)).toBe(2465);
    expect(punch.segmentInventory!.reduce((total, item) => total + item.quantity, 0)).toBe(10);
    expect(punch.name).toBe('MotionX core punch 86° R0.6');
    expect({ tipAngle: punch.tipAngle, tipRadius: punch.tipRadius }).toEqual(MOTIONX_PUNCH_SPEC);
    expect(isCCW(punch.profile.points)).toBe(true);
    expect(isSimplePolygon(punch.profile.points)).toBe(true);
    expect(ext.min.x).toBeCloseTo(-20.145096, 6);
    expect(ext.max.x).toBeCloseTo(4.981456, 6);
    expect(ext.min.y).toBe(0);
    expect(ext.max.y).toBeCloseTo(148.062248, 6);
    expect(derived.tipAngle).toBeCloseTo(MOTIONX_PUNCH_CAD_SPEC.tipAngle, 2);
    expect(derived.tipRadius).toBeCloseTo(MOTIONX_PUNCH_CAD_SPEC.tipRadius, 3);
    expect(derived.tangCentreX).toBeCloseTo(-13.895097, 6);
    expect(motionXPunchGeometryDiscrepancy(punch)).toEqual({
      calculation: MOTIONX_PUNCH_SPEC,
      cad: MOTIONX_PUNCH_CAD_SPEC,
    });
    expect(motionXPunchGeometryDiscrepancy({ id: 'other' })).toBeNull();
    expect(MOTIONX_PUNCH_DRAWING_SOURCE_SHA256).toBe('8e12200492c6563e6827744519ca864651d686dfaf0946fd6f696fad97a14d52');
    expect(punch.notes).toContain('sets calculation geometry to 86° / R0.6');
    expect(punch.notes).toContain('approximately 90° / R0.2 collision outline');
    expect(punch.notes).toContain('fitted-tool identity');
  });

  it('creates all seven controller slots from one complete mesh-derived 65 mm multi-V body', () => {
    const dies = motionXFactoryDies();
    expect(dies.map(die => die.id)).toEqual(Object.values(MOTIONX_DIE_SLOT_IDS));
    expect(dies.map(die => [die.slotNumber, die.vWidth, die.vAngle, die.shoulderRadius])).toEqual([
      ['1', 16, 86, 0.5],
      ['2', 24, 86, 4],
      ['3', 10, 86, 0.5],
      ['4', 8, 86, 0.5],
      ['5', 32, 86, 4],
      ['6', 36, 86, 4],
      ['7', 12, 86, 2],
    ]);
    expect(dies.map(die => [
      die.slotNumber,
      die.slotPosition,
      Number(die.notes?.match(/stopper reference (\d+) mm/i)?.[1]),
    ])).toEqual([
      ['1', 'top-right', 50],
      ['2', 'bottom-centre', 33],
      ['3', 'bottom-right', 52],
      ['4', 'bottom-left', 8],
      ['5', 'right', 34],
      ['6', 'left', 33],
      ['7', 'top-left', 53],
    ]);
    for (const die of dies) {
      const ext = bounds(die.profile.points);
      expect(die.stockStatus, die.id).toBe('in-stock');
      expect(die.physicalToolId, die.id).toBe(MOTIONX_DIE_PHYSICAL_ID);
      expect(die.maxLoadPerMeter, die.id).toBe(0);
      expect(die.height, die.id).toBe(65);
      expect(die.bodyWidth, die.id).toBe(65);
      expect(ext.max.y, die.id).toBeCloseTo(0, 6);
      expect(ext.min.y, die.id).toBeCloseTo(-65, 6);
      expect(ext.max.x - ext.min.x, die.id).toBeCloseTo(65, 6);
      expect(isCCW(die.profile.points), die.id).toBe(true);
      expect(isSimplePolygon(die.profile.points), die.id).toBe(true);
      expect(die.notes, die.id).not.toMatch(/safe zone/i);
      expect(die.notes, die.id).toMatch(/stopper reference \d+ mm/i);
    }
  });

  it('retains the measured A360 mesh-derived groove geometry beneath each controller slot record', () => {
    const expected = new Map([
      ['1', { vWidth: 20, vAngle: 90, shoulderRadius: 1, minX: -50, maxX: 15 }],
      ['2', { vWidth: 17.480002, vAngle: 111.060899, shoulderRadius: 0.999996, minX: -33.260001, maxX: 31.739999 }],
      ['3', { vWidth: 16.259999, vAngle: 89.999975, shoulderRadius: 1.000007, minX: -9.5, maxX: 55.5 }],
      ['4', { vWidth: 8.000004, vAngle: 90.000041, shoulderRadius: 0.799978, minX: -59, maxX: 6 }],
      ['5', { vWidth: 31.999997, vAngle: 89.999992, shoulderRadius: 3.000033, minX: -30.8, maxX: 34.2 }],
      ['6', { vWidth: 36.000002, vAngle: 90.000004, shoulderRadius: 2.999994, minX: -32.8, maxX: 32.2 }],
      ['7', { vWidth: 11.999997, vAngle: 89.999976, shoulderRadius: 1.000028, minX: -12, maxX: 53 }],
    ]);

    for (const die of motionXFactoryDies()) {
      const wanted = expected.get(die.slotNumber!)!;
      const derived = deriveDieParams(die.profile.points);
      const ext = bounds(die.profile.points);
      expect(derived.vWidth, die.id).toBeCloseTo(wanted.vWidth, 4);
      expect(derived.vAngle, die.id).toBeCloseTo(wanted.vAngle, 3);
      expect(derived.shoulderRadius, die.id).toBeCloseTo(wanted.shoulderRadius, 3);
      expect(derived.vCentreX, die.id).toBeCloseTo(0, 5);
      expect(ext.min.x, die.id).toBeCloseTo(wanted.minX, 5);
      expect(ext.max.x, die.id).toBeCloseTo(wanted.maxX, 5);
    }
  });

  it('reports the controller-to-mesh discrepancy without conflating the two data sources', () => {
    const bySlot = new Map(motionXFactoryDies().map(die => [die.slotNumber, motionXDieGeometryDiscrepancy(die)]));
    expect(bySlot.get('1')).toMatchObject({
      slotNumber: '1', risk: 'review',
      controller: { vWidth: 16, vAngle: 86, shoulderRadius: 0.5 },
      cad: { vWidth: 20, vAngle: 90, shoulderRadius: 1 },
    });
    expect(bySlot.get('2')).toMatchObject({
      slotNumber: '2', risk: 'high',
      controller: { vWidth: 24, vAngle: 86, shoulderRadius: 4 },
      cad: { vWidth: 17.48, vAngle: 111.06, shoulderRadius: 1 },
    });
    expect(bySlot.get('3')).toMatchObject({
      slotNumber: '3', risk: 'high',
      controller: { vWidth: 10, vAngle: 86, shoulderRadius: 0.5 },
      cad: { vWidth: 16.26, vAngle: 90, shoulderRadius: 1 },
    });
    expect([...bySlot.values()].filter(Boolean)).toHaveLength(7);
    expect(motionXDieGeometryDiscrepancy({
      physicalToolId: 'other', slotNumber: '3', vWidth: 10, vAngle: 86, shoulderRadius: 0.5,
    })).toBeNull();
  });
});
