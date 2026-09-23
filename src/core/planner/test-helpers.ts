/** Shared helpers for the planner tests (Node only — loads samples through the fixtures). */
import type { BendLine, FlatPattern, Machine, Material, PartModel, ToolLibrary, ToolSetup, Vec2 } from '../types';
import { loadTruth } from '../testing/fixtures';
import type { SampleName, Truth } from '../testing/fixtures';
import { buildPartModel } from '../part';
import { buildStandardLibrary } from '../tools';
import { defaultMachine } from '../machine';

export interface SampleSetup {
  truth: Truth;
  part: PartModel;
  material: Material;
  machine: Machine;
  setup: ToolSetup;
  library: ToolLibrary;
}

/** One station over the whole bed with the given punch/die (default: the sample's expected.defaultSetup). */
export function stationSetup(machine: Machine, punchId: string, dieId: string, segments = [835, 835, 835, 415, 100, 50, 20, 10]): ToolSetup {
  return {
    machineId: machine.id,
    stations: [{ id: 'S1', punchId, dieId, zStart: 0, zEnd: machine.bedLength, segments, punchFlipped: false, dieFlipped: false }],
  };
}

export function sampleSetup(name: SampleName, tools?: { punchId: string; dieId: string }): SampleSetup {
  const truth = loadTruth(name);
  const library = buildStandardLibrary();
  const machine = defaultMachine();
  const material = library.materials.find(m => m.id === truth.material.id) ?? library.materials[0]!;
  const part = buildPartModel(truth.flat);
  const punchId = tools?.punchId ?? truth.expected.defaultSetup.punch;
  const dieId = tools?.dieId ?? truth.expected.defaultSetup.die;
  return { truth, part, material, machine, setup: stationSetup(machine, punchId, dieId), library };
}

/**
 * Box flat pattern like samples/box-4-flange (base inner U × V, four flanges of outside height H,
 * corner notches, bends B1..B4 as in the sample: B1/B3 along u, B2/B4 along v).
 */
export function makeBoxFlat(U: number, V: number, H: number, t = 2, ri = 2, k = 0.44): FlatPattern {
  const ba = (Math.PI / 2) * (ri + k * t);
  const w = H - (ri + t);
  const o = w + ba;
  const src = { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } as const;
  const bend = (id: string, p0: Vec2, p1: Vec2): BendLine => ({ id, p0, p1, direction: 'up', angle: 90, innerRadius: ri, kFactor: k, sources: src });
  return {
    id: `box-${H}`, name: `box-${H}`, thickness: t, materialId: 'std:mild-steel',
    outline: [
      { x: o, y: 0 }, { x: o + U, y: 0 }, { x: o + U, y: o }, { x: 2 * o + U, y: o }, { x: 2 * o + U, y: o + V }, { x: o + U, y: o + V },
      { x: o + U, y: 2 * o + V }, { x: o, y: 2 * o + V }, { x: o, y: o + V }, { x: 0, y: o + V }, { x: 0, y: o }, { x: o, y: o },
    ],
    holes: [],
    bends: [
      bend('B1', { x: o, y: w + ba / 2 }, { x: o + U, y: w + ba / 2 }),
      bend('B2', { x: o + U + ba / 2, y: o }, { x: o + U + ba / 2, y: o + V }),
      bend('B3', { x: o, y: o + V + ba / 2 }, { x: o + U, y: o + V + ba / 2 }),
      bend('B4', { x: w + ba / 2, y: o }, { x: w + ba / 2, y: o + V }),
    ],
  };
}
