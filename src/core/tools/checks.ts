/**
 * Tool / machine capacity checks used by the planner and the UI. See docs/specs/tooling-machine.md §1.6.
 */
import type { Die, Machine, Message, Punch } from '../types';

export interface ToolLoadCheck {
  ok: boolean;
  /** Load as % of the weakest tool rating; null when either tool is unrated. */
  percentOfTool: number | null;
  /** Name of the weakest known-rated tool, or the first unrated tool when no rating is known. */
  limitingTool: string;
  message?: Message;
}

/** Air-bend (or hem) load per metre against the punch/die ratings (kN/m). */
export function toolLoadCheck(forcePerMeter: number, punch: Pick<Punch, 'name' | 'maxLoadPerMeter'>, die: Pick<Die, 'name' | 'maxLoadPerMeter'>): ToolLoadCheck {
  const unrated = [punch, die].filter(tool => !(tool.maxLoadPerMeter > 0));
  const rated = [punch, die].filter(tool => tool.maxLoadPerMeter > 0);
  const limitingRated = rated.reduce<(typeof rated)[number] | undefined>(
    (lowest, tool) => !lowest || tool.maxLoadPerMeter < lowest.maxLoadPerMeter ? tool : lowest,
    undefined,
  );
  const limitingTool = limitingRated?.name ?? unrated[0]?.name ?? punch.name;
  const rating = limitingRated?.maxLoadPerMeter ?? Infinity;
  // a non-finite load (e.g. airBendForce with V = 0) can never be OK; a negative one is a caller bug → treat as 0
  const load = Number.isNaN(forcePerMeter) ? Infinity : Math.max(0, forcePerMeter);
  const knownPercent = rating === Infinity ? (load === Infinity ? Infinity : 0) : (100 * load) / rating;
  const percent = Number.isFinite(knownPercent) ? Math.round(knownPercent * 10) / 10 : knownPercent;
  const percentOfTool = unrated.length > 0 ? null : knownPercent;
  if (!Number.isFinite(load) || knownPercent > 100) {
    return { ok: false, percentOfTool, limitingTool, message: { key: 'warnings.tool.overload', severity: 'error', params: { tool: limitingTool, percent } } };
  }
  if (unrated.length > 0) {
    return {
      ok: true,
      percentOfTool,
      limitingTool,
      message: { key: 'warnings.tool.loadUnverified', severity: 'warning', params: { tools: unrated.map(tool => tool.name).join(' / ') } },
    };
  }
  if (knownPercent > 90) {
    return { ok: true, percentOfTool: knownPercent, limitingTool, message: { key: 'warnings.tool.loadNearLimit', severity: 'warning', params: { tool: limitingTool, percent } } };
  }
  return { ok: true, percentOfTool: knownPercent, limitingTool };
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
