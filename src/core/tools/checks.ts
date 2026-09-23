/**
 * Tool / machine capacity checks used by the planner and the UI. See docs/specs/tooling-machine.md §1.6.
 */
import type { Die, Machine, Message, Punch } from '../types';

export interface ToolLoadCheck {
  ok: boolean;
  /** Load as % of the weakest tool rating. */
  percentOfTool: number;
  /** Name of the weakest tool (the one the percentage refers to). */
  limitingTool: string;
  message?: Message;
}

/** Air-bend (or hem) load per metre against the punch/die ratings (kN/m). */
export function toolLoadCheck(forcePerMeter: number, punch: Pick<Punch, 'name' | 'maxLoadPerMeter'>, die: Pick<Die, 'name' | 'maxLoadPerMeter'>): ToolLoadCheck {
  const punchRating = punch.maxLoadPerMeter > 0 ? punch.maxLoadPerMeter : Infinity;
  const dieRating = die.maxLoadPerMeter > 0 ? die.maxLoadPerMeter : Infinity;
  const limitingTool = dieRating < punchRating ? die.name : punch.name;
  const rating = Math.min(punchRating, dieRating);
  // a non-finite load (e.g. airBendForce with V = 0) can never be OK; a negative one is a caller bug → treat as 0
  const load = Number.isNaN(forcePerMeter) ? Infinity : Math.max(0, forcePerMeter);
  const percentOfTool = rating === Infinity ? (load === Infinity ? Infinity : 0) : (100 * load) / rating;
  const percent = Number.isFinite(percentOfTool) ? Math.round(percentOfTool * 10) / 10 : percentOfTool;
  if (percentOfTool > 100) {
    return { ok: false, percentOfTool, limitingTool, message: { key: 'warnings.tool.overload', severity: 'error', params: { tool: limitingTool, percent } } };
  }
  if (percentOfTool > 90) {
    return { ok: true, percentOfTool, limitingTool, message: { key: 'warnings.tool.loadNearLimit', severity: 'warning', params: { tool: limitingTool, percent } } };
  }
  return { ok: true, percentOfTool, limitingTool };
}

export interface DaylightCheck {
  ok: boolean;
  /** Tool stack height: holder + die + punch (mm). */
  stack: number;
  /** Clearance between the punch tip at top-dead-centre and the die shoulder plane (mm). */
  tipClearance: number;
  message?: Message;
}

/**
 * Can the part (height above the die plane) be inserted under the punch at TDC?
 * stack = holderHeight + die.height + punch.height ≤ daylight and daylight − stack ≥ partHeight + margin.
 */
export function daylightCheck(machine: Machine, punch: Pick<Punch, 'height'>, die: Pick<Die, 'height'>, partHeight: number, margin = 20): DaylightCheck {
  const stack = machine.table.holderHeight + die.height + punch.height;
  const tipClearance = machine.daylight - stack;
  if (stack > machine.daylight) {
    return { ok: false, stack, tipClearance, message: { key: 'warnings.machine.stackTooTall', severity: 'error', params: { stack, daylight: machine.daylight } } };
  }
  if (partHeight + margin > tipClearance) {
    return {
      ok: false, stack, tipClearance,
      message: { key: 'warnings.machine.daylight', severity: 'error', params: { partHeight: Math.round(partHeight * 10) / 10, available: Math.round((tipClearance - margin) * 10) / 10 } },
    };
  }
  return { ok: true, stack, tipClearance };
}

export interface StrokeCheck {
  ok: boolean;
  /** Deepest ram depth the stroke allows with this stack (mm below the die plane). */
  maxRamDepth: number;
  message?: Message;
}

/** Is `ramDepth` (below the die shoulder plane) reachable within the stroke? */
export function strokeCheck(machine: Machine, punch: Pick<Punch, 'height'>, die: Pick<Die, 'height'>, ramDepth: number): StrokeCheck {
  const tableTopY = -(machine.table.holderHeight + die.height);
  const bdcClampY = tableTopY + machine.daylight - machine.stroke;
  const maxRamDepth = punch.height - bdcClampY;
  if (ramDepth > maxRamDepth + 1e-9) {
    return { ok: false, maxRamDepth, message: { key: 'warnings.machine.stroke', severity: 'error', params: { ramDepth: Math.round(ramDepth * 100) / 100, maxRamDepth: Math.round(maxRamDepth * 100) / 100 } } };
  }
  return { ok: true, maxRamDepth };
}
