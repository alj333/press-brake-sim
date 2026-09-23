/**
 * The standard tool library (ids `std:<slug>`), materials and the default machine.
 * See docs/specs/tooling-machine.md §1.5.
 */
import type { Die, Finger, Material, Punch, ToolLibrary } from '../types';
import { defaultMachine } from '../machine/default';
import { straightPunch, gooseneckPunch, acutePunch, radiusPunch, hemmingPunch } from './punches';
import { vDie, multiVDie, hemmingDie } from './dies';
import { flatFinger, steppedFinger } from './fingers';

/** Persistence schema version of ToolLibrary. */
export const LIBRARY_VERSION = 1;

export const STANDARD_V_WIDTHS: readonly number[] = [6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80];
export const MULTI_V_WIDTHS: readonly [number, number, number, number] = [16, 22, 35, 50];

export function standardPunches(): Punch[] {
  return [
    straightPunch({ tipRadius: 0.8, tipAngle: 88 }),
    straightPunch({ tipRadius: 0.2, tipAngle: 88 }),
    straightPunch({ tipRadius: 0.8, tipAngle: 85 }),
    gooseneckPunch({ tipRadius: 0.8, tipAngle: 88 }),
    acutePunch({ tipAngle: 30, tipRadius: 0.8 }),
    acutePunch({ tipAngle: 28, tipRadius: 1.0 }),
    radiusPunch({ radius: 3 }),
    radiusPunch({ radius: 5 }),
    radiusPunch({ radius: 10 }),
    hemmingPunch(),
  ];
}

export function standardDies(): Die[] {
  const dies: Die[] = STANDARD_V_WIDTHS.map(v => vDie({ vWidth: v, vAngle: 88 }));
  dies.push(vDie({ vWidth: 12, vAngle: 85 }), vDie({ vWidth: 16, vAngle: 85 }));
  dies.push(vDie({ vWidth: 12, vAngle: 30 }), vDie({ vWidth: 16, vAngle: 30 }));
  for (let a = 0; a < 4; a++) dies.push(multiVDie({ vWidths: [...MULTI_V_WIDTHS], active: a }));
  dies.push(hemmingDie());
  return dies;
}

export function standardFingers(): Finger[] {
  return [flatFinger(), steppedFinger()];
}

export function standardMaterials(): Material[] {
  return [
    { id: 'std:mild-steel', name: 'Mild steel (S235/S275)', tensileStrength: 420, kFactor: 0.44, springbackDeg: 1.5, minInnerRadiusFactor: 0.8, density: 7850 },
    { id: 'std:stainless-304', name: 'Stainless steel 304', tensileStrength: 620, kFactor: 0.45, springbackDeg: 3, minInnerRadiusFactor: 1.5, density: 7930 },
    { id: 'std:aluminium-5052-h32', name: 'Aluminium 5052-H32', tensileStrength: 230, kFactor: 0.42, springbackDeg: 2, minInnerRadiusFactor: 1.5, density: 2680 },
    { id: 'std:aluminium-6061-t6', name: 'Aluminium 6061-T6', tensileStrength: 310, kFactor: 0.42, springbackDeg: 4.5, minInnerRadiusFactor: 3.0, density: 2700 },
    { id: 'std:galvanised-steel', name: 'Galvanised steel', tensileStrength: 420, kFactor: 0.44, springbackDeg: 1.5, minInnerRadiusFactor: 0.8, density: 7850 },
  ];
}

/** Everything the app ships with: punches, dies, fingers, materials and the default machine. */
export function buildStandardLibrary(now: Date = new Date()): ToolLibrary {
  return {
    punches: standardPunches(),
    dies: standardDies(),
    fingers: standardFingers(),
    materials: standardMaterials(),
    machines: [defaultMachine()],
    version: LIBRARY_VERSION,
    revision: 0,
    updatedAt: now.toISOString(),
  };
}

/** Standard id of the 88° V die for a given opening (as the samples' expected.defaultSetup names it). */
export function standardDieId(vWidth: number, vAngle = 88): string {
  return `std:die-v${vWidth}-${vAngle}`;
}

export const STANDARD_PUNCH_ID = 'std:punch-straight-88-r0.8';
export const STANDARD_FINGER_ID = 'std:finger-flat';
export const STANDARD_MATERIAL_ID = 'std:mild-steel';
