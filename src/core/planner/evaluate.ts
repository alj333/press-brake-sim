/**
 * Memoised step evaluation (ARCHITECTURE "Bend-sequence planner" §5): placement → station analysis
 * → backgauge → collision sweep → order-independent cost. See docs/specs/planner.md §5.
 */
import type { Message } from '../types';
import { partSilhouette, flangeExtentFromBend } from '../part';
import { legCheck, outsideSetback } from '../bend';
import type { LegStatus } from '../bend';
import type { BendInfo, PlanContext, StationInfo } from './context';
import { computePlacementDetails } from './placement';
import type { PlacementDetails } from './placement';
import { analyseStation, bendStationMaths, centrePunchInStation } from './stations';
import type { BendStationMaths, StationAnalysis } from './stations';
import { planBackgauge } from './backgauge';
import type { BackgaugeResult } from './backgauge';
import { sweepCollisions } from './collision';
import type { SweepResult } from './collision';

/** Cost added per hard error (an infeasible step is never preferred to a feasible one). */
export const HARD_ERROR_COST = 1e6;
/** Tie-breaker weights (all far below the primary weights). */
export const PREFER_LARGER_GAUGED = 0.05;
export const STANDING_DOWN_COST = 0.2;
export const BOTTOMING_COST = 0.5;
/** Gauge quality: a radius / non-straight / missing contact, a finger skimming the die top, a single-finger gauge. */
export const GAUGE_WARNING_COST = 1;
export const FINGER_OVER_DIE_COST = 0.75;
export const SINGLE_FINGER_COST = 0.5;
const GAUGE_WARNING_KEYS = new Set(['warnings.gauge.radiusContact', 'warnings.gauge.contactNotStraight', 'warnings.gauge.noContact']);

export type GaugedSide = 0 | 1;   // 0 = parent gauged, 1 = child gauged

export interface LegInfo { flangeId: string; outside: number; status: LegStatus }

export interface Evaluation {
  key: string;
  bend: BendInfo;
  doneMask: number;
  gaugedSide: GaugedSide;
  station: StationAnalysis;
  details: PlacementDetails;
  backgauge: BackgaugeResult;
  sweep: SweepResult;
  legs: { parent: LegInfo; child: LegInfo };
  /** Flanges already bent that point below the die plane in this placement. */
  standingDown: number;
  warnings: Message[];
  hardErrors: number;
  /** Order-independent cost (includes HARD_ERROR_COST per hard error). */
  cost: number;
  /** Full sweep (every obstacle kind) — false in search mode (stops at the first error). */
  full: boolean;
}

export interface Evaluator {
  evaluate: (bendIndex: number, doneMask: number, side: GaugedSide, stationIndex: number, full?: boolean) => Evaluation;
  maths: (bendIndex: number, stationIndex: number) => BendStationMaths;
  /** Number of evaluations performed so far. */
  count: () => number;
}

function legOutside(ctx: PlanContext, b: BendInfo, flangeId: string): number {
  const ext = flangeExtentFromBend(ctx.part, flangeId, b.id);
  const ba = ctx.part.bendAllowance[b.id] ?? 0;
  return ext.max + outsideSetback(b.bend.angle, b.bend.innerRadius, ctx.t).value - ba / 2;
}

export function createEvaluator(ctx: PlanContext, onEvaluate?: (count: number) => void): Evaluator {
  const memo = new Map<string, Evaluation>();
  const mathsMemo = new Map<string, BendStationMaths>();
  let count = 0;
  const w = ctx.options.weights;
  const partArea = ctx.part.flanges.reduce((s, f) => s + f.area, 0) || 1;

  const maths = (bendIndex: number, stationIndex: number): BendStationMaths => {
    const key = `${bendIndex}:${stationIndex}`;
    let m = mathsMemo.get(key);
    if (!m) { m = bendStationMaths(ctx, ctx.bends[bendIndex]!, ctx.stations[stationIndex]!); mathsMemo.set(key, m); }
    return m;
  };

  const evaluate = (bendIndex: number, doneMask: number, side: GaugedSide, stationIndex: number, full = false): Evaluation => {
    const key = `${bendIndex}|${doneMask}|${side}|${stationIndex}|${full ? 1 : 0}`;
    const hit = memo.get(key);
    if (hit) return hit;
    ctx.checkAbort();
    const b = ctx.bends[bendIndex]!;
    const st: StationInfo = ctx.stations[stationIndex]!;
    const t = ctx.t;
    const folded = ctx.folded(ctx.foldStateFor(doneMask));
    const gaugedId = side === 1 ? b.link.childFlangeId : b.link.parentFlangeId;
    const details0 = computePlacementDetails(ctx.part, folded, b.id, gaugedId, st.station, t);
    const pieces0 = partSilhouette(folded, details0.placement.transform, t);
    const m = maths(bendIndex, stationIndex);
    // the punch piece is mounted centred in the station; the part moves relative to it when the
    // Z-clearance analysis placed the piece off the bend line's centre
    const { details, pieces, analysis: station } = centrePunchInStation(st, details0, pieces0, analyseStation(ctx, b, st, m, details0, pieces0));
    const backgauge = planBackgauge(ctx, { bend: b, station: st, details, folded, pieces });
    const sweep = sweepCollisions(ctx, { bend: b, station, details, doneMask, fingers: backgauge.fingers, stopAtError: !full, stepFactor: full ? 1 : ctx.searchSweepFactor });

    const warnings: Message[] = [...station.warnings, ...backgauge.warnings];
    let hardErrors = station.hardErrors + backgauge.hardErrors;
    const errorCollisions = sweep.collisions.filter(c => c.severity === 'error').length;
    const warningCollisions = sweep.collisions.length - errorCollisions;
    hardErrors += errorCollisions;
    if (sweep.collisions.some(c => c.with === 'finger')) warnings.push({ key: 'warnings.gauge.retractSuggested', severity: 'warning', params: { bendId: b.id } });

    // legs (outside dimension to the virtual sharp / tangent, both sides)
    const factor = ctx.options.minFlangeWarnFactor;
    const mkLeg = (flangeId: string): LegInfo => {
      const outside = legOutside(ctx, b, flangeId);
      return { flangeId, outside, status: legCheck(outside, m.minLeg, factor) };
    };
    const legs = { parent: mkLeg(b.link.parentFlangeId), child: mkLeg(b.link.childFlangeId) };
    let legWarn = 0, legErr = 0;
    for (const leg of [legs.parent, legs.child]) {
      if (leg.status === 'ok') continue;
      if (leg.status === 'error') legErr++; else legWarn++;
      warnings.push({
        key: leg.status === 'error' ? 'warnings.bend.legTooShort' : 'warnings.bend.legShort', severity: leg.status,
        params: { bendId: b.id, flangeId: leg.flangeId, outside: Math.round(leg.outside * 100) / 100, minLeg: Math.round(m.minLeg * 100) / 100 },
      });
    }
    // a leg below Lmin slips off the die shoulder before the loaded angle: not bendable on this V
    hardErrors += legErr;

    // force vs machine capacity and tool ratings
    const cap = ctx.machine.capacity;
    if (cap > 0) {
      const percent = (100 * m.force) / cap;
      if (percent > 100) {
        warnings.push({ key: 'warnings.machine.capacity', severity: 'error', params: { force: Math.round(m.force * 10) / 10, capacity: cap, percent: Math.round(percent * 10) / 10 } });
        hardErrors++;
      } else if (percent > 90) {
        warnings.push({ key: 'warnings.machine.capacity', severity: 'warning', params: { force: Math.round(m.force * 10) / 10, capacity: cap, percent: Math.round(percent * 10) / 10 } });
      }
    }
    if (m.load.message) warnings.push(m.load.message);
    if (!m.load.ok) hardErrors++;

    // previously bent flanges pointing below the die plane
    const down = new Set<string>();
    for (const p of pieces) {
      if (p.source.kind !== 'flange' || p.source.flangeId === b.link.parentFlangeId || p.source.flangeId === b.link.childFlangeId) continue;
      let minY = Infinity;
      for (const v of p.polygon) if (v.y < minY) minY = v.y;
      if (minY < -0.5) down.add(p.source.flangeId);
    }
    const standingDown = down.size;

    const gaugedArea = ctx.part.flanges.find(f => f.id === gaugedId)?.area ?? 0;
    let gaugeQuality = 0;
    for (const msg of backgauge.warnings) {
      if (GAUGE_WARNING_KEYS.has(msg.key)) gaugeQuality += GAUGE_WARNING_COST;
      else if (msg.key === 'warnings.gauge.fingerOverDie') gaugeQuality += FINGER_OVER_DIE_COST;
      else if (msg.key === 'warnings.gauge.singleFinger') gaugeQuality += SINGLE_FINGER_COST;
    }
    const cost =
      w.shortFlange * (legWarn + 2 * legErr) +
      w.collisionWarning * warningCollisions +
      m.vPreference +
      (m.angleOk ? 0 : BOTTOMING_COST) +
      gaugeQuality +
      PREFER_LARGER_GAUGED * (1 - gaugedArea / partArea) +
      STANDING_DOWN_COST * standingDown +
      HARD_ERROR_COST * hardErrors;

    const ev: Evaluation = { key, bend: b, doneMask, gaugedSide: side, station, details, backgauge, sweep, legs, standingDown, warnings, hardErrors, cost, full };
    memo.set(key, ev);
    count++;
    if (onEvaluate) onEvaluate(count);
    return ev;
  };

  return { evaluate, maths, count: () => count };
}
