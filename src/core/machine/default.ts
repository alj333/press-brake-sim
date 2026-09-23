/**
 * Default machine "Generic 100t × 3100" (ARCHITECTURE "Tooling & machine") and the machine
 * Y levels derived from the tool stack. See docs/specs/tooling-machine.md §2.
 */
import type { Machine } from '../types';

export const DEFAULT_MACHINE_ID = 'std:machine-generic-100t';

export function defaultMachine(): Machine {
  return {
    id: DEFAULT_MACHINE_ID,
    name: 'Generic 100t × 3100',
    bedLength: 3100,
    capacity: 1000,
    stroke: 200,
    daylight: 420,
    throatDepth: 400,
    distanceBetweenFrames: 2600,
    ram: {
      thickness: 60,
      height: 400,
      clampThickness: 110,
      clampHeight: 90,
      clampFrontOffset: 55,
      speeds: { approach: 100, bend: 10, retract: 100 },
    },
    table: { width: 120, holderWidth: 60, holderHeight: 60, height: 500 },
    backgauge: {
      xMin: 10, xMax: 750,
      rMin: -25, rMax: 150,
      zMin: 0, zMax: 3100,
      fingerCount: 2,
      fingerId: 'std:finger-flat',
      independentX: true,
      independentR: true,
      beamDepth: 100,
      beamHeight: 60,
      retractAtPinch: 0,
      speed: 300,
    },
    yCorrection: 0,
  };
}

export interface MachineLevels {
  /** Y of the table top (die-holder seat). */
  tableTopY: number;
  /** Y of the holder top = die bottom. */
  holderTopY: number;
  /** Clamp bottom face at top-dead-centre. */
  tdcClampY: number;
  /** Clamp bottom face at bottom-dead-centre (TDC − stroke). */
  bdcClampY: number;
  /** Punch tip Y at TDC. */
  tipAtTdcY: number;
  /** Deepest reachable ram depth below the die shoulder plane (mm). */
  maxRamDepth: number;
}

/** Machine Y levels (die shoulder plane = 0) for a given tool stack. */
export function machineLevels(machine: Machine, dieHeight = 60, punchHeight = 120): MachineLevels {
  const tableTopY = -(machine.table.holderHeight + dieHeight);
  const holderTopY = -dieHeight;
  const tdcClampY = tableTopY + machine.daylight;
  const bdcClampY = tdcClampY - machine.stroke;
  return { tableTopY, holderTopY, tdcClampY, bdcClampY, tipAtTdcY: tdcClampY - punchHeight, maxRamDepth: punchHeight - bdcClampY };
}
