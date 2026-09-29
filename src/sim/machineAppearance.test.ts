import { describe, expect, it } from 'vitest';
import { defaultMachine, machineLevels } from '../core/machine';
import type { Machine } from '../core/types';
import { deriveMachineAppearance } from './machineAppearance';

function expectFiniteLayout(machine: Machine): void {
  const levels = machineLevels(machine, 60, 120);
  const layout = deriveMachineAppearance(machine, levels, levels.tdcClampY);
  const ids = [...layout.boxes.map(x => x.id), ...layout.cylinders.map(x => x.id)];
  expect(new Set(ids).size).toBe(ids.length);
  expect(layout.boxes.length).toBeGreaterThanOrEqual(10);
  expect(layout.cylinders).toHaveLength(2);
  for (const box of layout.boxes) {
    for (const value of [box.x0, box.x1, box.y0, box.y1, box.z0, box.z1]) expect(Number.isFinite(value), box.id).toBe(true);
    expect(box.x1, box.id).toBeGreaterThan(box.x0);
    expect(box.y1, box.id).toBeGreaterThan(box.y0);
    expect(box.z1, box.id).toBeGreaterThan(box.z0);
  }
  for (const cylinder of layout.cylinders) {
    for (const value of [cylinder.x, cylinder.y, cylinder.z, cylinder.radius, cylinder.height]) expect(Number.isFinite(value), cylinder.id).toBe(true);
    expect(cylinder.radius, cylinder.id).toBeGreaterThan(0);
    expect(cylinder.height, cylinder.id).toBeGreaterThan(0);
  }
}

describe('deriveMachineAppearance', () => {
  it('builds finite, uniquely named geometry for default and custom machine dimensions', () => {
    const standard = defaultMachine();
    expectFiniteLayout(standard);
    expectFiniteLayout({
      ...standard,
      id: 'custom:test',
      bedLength: 2200,
      distanceBetweenFrames: 1700,
      throatDepth: 520,
      stroke: 260,
      ram: { ...standard.ram, thickness: 80, height: 460, clampThickness: 130 },
      table: { ...standard.table, width: 150, height: 620 },
      backgauge: { ...standard.backgauge, xMax: 900, zMax: 2200 },
    });
  });

  it('keeps every decorative primitive outside the active tooling gap', () => {
    const machine = defaultMachine();
    const levels = machineLevels(machine, 60, 120);
    const ramY = levels.tdcClampY - machine.stroke * 0.4;
    const layout = deriveMachineAppearance(machine, levels, ramY);
    const frameLeft = (machine.bedLength - machine.distanceBetweenFrames) / 2;
    const frameRight = machine.bedLength - frameLeft;

    // Conservative active volume: front face of table through max backgauge travel, table top
    // through clamp top, and the clear distance between frames. Every decoration must be
    // separated from it on at least one axis.
    const active = {
      x0: -machine.table.width / 2,
      x1: machine.backgauge.xMax,
      y0: levels.tableTopY,
      y1: ramY + machine.ram.clampHeight,
      z0: frameLeft,
      z1: frameRight,
    };
    const separated = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean =>
      x1 <= active.x0 || x0 >= active.x1 || y1 <= active.y0 || y0 >= active.y1 || z1 <= active.z0 || z0 >= active.z1;

    for (const box of layout.boxes) {
      expect(separated(box.x0, box.x1, box.y0, box.y1, box.z0, box.z1), box.id).toBe(true);
    }
    for (const cylinder of layout.cylinders) {
      expect(
        separated(
          cylinder.x - cylinder.radius,
          cylinder.x + cylinder.radius,
          cylinder.y - cylinder.height / 2,
          cylinder.y + cylinder.height / 2,
          cylinder.z - cylinder.radius,
          cylinder.z + cylinder.radius,
        ),
        cylinder.id,
      ).toBe(true);
    }
  });

  it('moves only the ram fascia with ramY and scales bed/frame details with machine dimensions', () => {
    const machine = defaultMachine();
    const levels = machineLevels(machine, 60, 120);
    const atTop = deriveMachineAppearance(machine, levels, levels.tdcClampY);
    const lower = deriveMachineAppearance(machine, levels, levels.tdcClampY - 75);
    const topRam = atTop.boxes.find(x => x.id === 'ram:front-fascia')!;
    const lowRam = lower.boxes.find(x => x.id === 'ram:front-fascia')!;
    expect(lowRam.y0 - topRam.y0).toBe(-75);
    expect(lowRam.y1 - topRam.y1).toBe(-75);
    expect(lower.boxes.find(x => x.id === 'bed:front-fascia')).toEqual(atTop.boxes.find(x => x.id === 'bed:front-fascia'));

    const longer = { ...machine, bedLength: 4100, distanceBetweenFrames: 3500, backgauge: { ...machine.backgauge, zMax: 4100 } };
    const longerLevels = machineLevels(longer, 60, 120);
    const longLayout = deriveMachineAppearance(longer, longerLevels, longerLevels.tdcClampY);
    expect(longLayout.boxes.find(x => x.id === 'bed:front-fascia')!.z1).toBe(4100);
    expect(longLayout.boxes.find(x => x.id === 'frame:right:column')!.z0).toBe((4100 + 3500) / 2);
  });
});
