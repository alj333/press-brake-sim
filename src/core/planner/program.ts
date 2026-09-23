/**
 * Program assembly (ARCHITECTURE "Bend-sequence planner" §6, docs/specs/planner.md §6): every
 * BendStep field from the chosen evaluations, hems expanded into pre-bend + hem-flatten, program
 * feasibility and statistics. `planProgram` is the planner's entry point.
 */
import type { BendProgram, BendStep, Message, Turn } from '../types';
import { mat4 } from '../geom';
import { bendAllowance, bendDeduction, outsideSetback } from '../bend';
import { partSilhouette } from '../part';
import { daylightCheck, strokeCheck } from '../tools';
import { machineLevels, validateSetup } from '../machine';
import { createContext } from './context';
import type { PlanContext, PlannerInput, PlannerProgress, StationInfo } from './context';
import { createEvaluator } from './evaluate';
import type { Evaluation } from './evaluate';
import { searchSequence } from './search';
import { analyseStation, bendStationMaths, centrePunchInStation } from './stations';
import { sweepCollisions } from './collision';
import type { PlacementDetails } from './placement';

/** Ram clearance above the part when retracted (mm). */
export const RETRACT_MARGIN = 20;

const r2 = (v: number): number => Math.round(v * 100) / 100;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

interface StepExtras { turn: Turn; stationChange: boolean }

/**
 * Pinch / retract levels and the machine checks: the part must fit under the punch at TDC when it
 * is inserted (`insertionHeight`, hard); when the finished part is taller than the daylight it can
 * only be removed tilted (warning). The ram retracts to clear the taller of the two when it can.
 */
function ramLimits(ctx: PlanContext, st: StationInfo, insertionHeight: number, finishedHeight: number, ramDepth: number): { pinchY: number; ramUpperLimit: number; warnings: Message[]; errors: number } {
  const warnings: Message[] = [];
  let errors = 0;
  const levels = machineLevels(ctx.machine, st.die.height, st.punch.height);
  const pinchY = st.punch.height + ctx.t;
  const ramUpperLimit = Math.max(pinchY + 5, Math.min(levels.tdcClampY, Math.max(insertionHeight, finishedHeight) + RETRACT_MARGIN + st.punch.height));
  const dl = daylightCheck(ctx.machine, st.punch, st.die, insertionHeight, RETRACT_MARGIN);
  if (dl.message) { warnings.push(dl.message); if (dl.message.severity === 'error') errors++; }
  else if (finishedHeight + RETRACT_MARGIN > dl.tipClearance) {
    const dl2 = daylightCheck(ctx.machine, st.punch, st.die, finishedHeight, RETRACT_MARGIN);
    if (dl2.message) warnings.push({ ...dl2.message, severity: 'warning' });
  }
  const sc = strokeCheck(ctx.machine, st.punch, st.die, ramDepth);
  if (sc.message) { warnings.push(sc.message); if (sc.message.severity === 'error') errors++; }
  return { pinchY, ramUpperLimit, warnings, errors };
}

/** BendStep for an air-bend evaluation (a hem's pre-bend included). */
export function buildBendStep(ctx: PlanContext, ev: Evaluation, index: number, extras: StepExtras): { step: BendStep; errors: number } {
  const b = ev.bend, st = ev.station.station, m = ev.station.maths;
  const t = ctx.t;
  const warnings: Message[] = [...ev.warnings];
  let errors = ev.hardErrors;
  const lim = ramLimits(ctx, st, ev.details.bounds.max.y, ev.sweep.partHeight, m.ramDepth);
  warnings.push(...lim.warnings); errors += lim.errors;

  const ri = b.bend.innerRadius;
  if (Math.abs(m.riActual - ri) > Math.max(0.25 * t, 0.2 * ri)) {
    const dBA = bendAllowance(m.formAngle, m.riActual, b.bend.kFactor, t) - bendAllowance(m.formAngle, ri, b.bend.kFactor, t);
    warnings.push({ key: 'warnings.bend.radiusMismatch', severity: 'warning', params: { bendId: b.id, drawing: r2(ri), actual: r2(m.riActual), flangeError: r2(dBA / 2) } });
  }
  const gaugedLeg = ev.gaugedSide === 1 ? ev.legs.child : ev.legs.parent;
  const ossb = outsideSetback(b.bend.angle, ri, t);
  // check dimension: from this bend's virtual sharp / tangent to what the fingers touch (cut edge,
  // standing-wall face or radius extreme); the flange's own extent when nothing is gauged
  const ba = ctx.part.bendAllowance[b.id] ?? 0;
  const gaugedOutside = ev.backgauge.contact !== 'none' && Number.isFinite(ev.backgauge.contactX)
    ? ev.backgauge.contactX - ba / 2 + ossb.value
    : gaugedLeg.outside;
  const step: BendStep = {
    index,
    kind: 'bend',
    bendId: b.id,
    stationId: st.station.id,
    punchId: st.punch.id, dieId: st.die.id,
    punchName: st.punch.name, dieName: st.die.name,
    placement: ev.details.placement,
    targetAngle: r2(m.formAngle),
    includedAngle: r2(180 - m.formAngle),
    springback: r2(m.springback),
    overbendAngle: r2(m.overbendAngle),
    loadedIncludedAngle: r2(m.loadedIncludedAngle),
    actualInnerRadius: r2(m.riActual),
    ramDepth: r2(m.ramDepth),
    pinchY: r2(lim.pinchY),
    ramUpperLimit: r2(lim.ramUpperLimit),
    force: r2(m.force),
    forcePerMeter: r2(m.forcePerMeter),
    loadPercentOfTool: Number.isFinite(m.load.percentOfTool) ? Math.round(m.load.percentOfTool * 10) / 10 : m.load.percentOfTool,
    bendLength: r2(b.length),
    punchLength: r2(ev.station.punchLength),
    segments: ev.station.segments.slice(),
    partZOffset: r2(ev.details.placement.partZOffset),
    backgauge: ev.backgauge.fingers.map(f => ({ x: r2(f.x), r: r2(f.r), z: r2(f.z) })),
    gaugeContact: ev.backgauge.contact,
    gaugedFlangeOutside: r2(gaugedOutside),
    bendDeduction: r2(bendDeduction(b.bend.angle, ri, b.bend.kFactor, t)),
    dimensionRef: ossb.ref,
    orientation: { faceUp: ev.details.placement.flipped ? 'bottom' : 'top', backFlangeId: ev.details.placement.gaugedFlangeId },
    manipulation: { turn: extras.turn, stationChange: extras.stationChange },
    bottoming: !m.angleOk,
    collisions: ev.sweep.collisions,
    warnings,
  };
  return { step, errors };
}

/** Hem-flatten step following a hem's pre-bend evaluation. */
export function buildHemFlattenStep(ctx: PlanContext, pre: Evaluation, index: number): { step: BendStep; errors: number } {
  const b = pre.bend;
  const t = ctx.t;
  const hemStation = ctx.stations.find(s => s.isHemming && s.die.family === 'hemming') ?? ctx.stations.find(s => s.isHemming);
  const warnings: Message[] = [];
  let errors = 0;
  const st = hemStation ?? pre.station.station;
  if (!hemStation) { warnings.push({ key: 'warnings.tool.noHemmingStation', severity: 'error', params: { bendId: b.id } }); errors++; }
  const stationChange = st.index !== pre.station.station.index;

  // same orientation as the pre-bend, re-centred in the hemming station
  const preT = pre.details.placement.transform;
  const dz = (st.zStart + st.zEnd) / 2 - (pre.station.station.zStart + pre.station.station.zEnd) / 2;
  const transform = mat4.multiply(mat4.translationXYZ(0, 0, dz), preT);
  const doneMask = pre.doneMask | (1 << b.index);
  const folded = ctx.folded(ctx.foldStateFor(doneMask));
  const pieces0 = partSilhouette(folded, transform, t);
  let zMin = Infinity, maxY = -Infinity;
  for (const p of pieces0) { if (p.zRange[0] < zMin) zMin = p.zRange[0]; for (const v of p.polygon) if (v.y > maxY) maxY = v.y; }
  const details0: PlacementDetails = {
    ...pre.details,
    placement: { ...pre.details.placement, transform, partZOffset: (Number.isFinite(zMin) ? zMin : pre.details.bounds.min.z + dz) - st.zStart },
    bendZ: [pre.details.bendZ[0] + dz, pre.details.bendZ[1] + dz],
    bendZ01: [pre.details.bendZ01[0] + dz, pre.details.bendZ01[1] + dz],
    bounds: { min: { ...pre.details.bounds.min, z: pre.details.bounds.min.z + dz }, max: { ...pre.details.bounds.max, z: pre.details.bounds.max.z + dz } },
  };
  // hem numbers (hemFlattenForce, ramDepth −(2t + gap)) — from the pre-bend's tools when no hemming station exists
  const hmaths = bendStationMaths(ctx, b, hemStation ?? { ...pre.station.station, isHemming: true });
  const { details, analysis } = hemStation
    ? centrePunchInStation(hemStation, details0, pieces0, analyseStation(ctx, b, hemStation, hmaths, details0, pieces0))
    : { details: details0, analysis: { ...pre.station, maths: hmaths, warnings: [], hardErrors: 0 } };
  const hm = analysis.maths;
  const preFraction = b.bend.angle > 0 ? pre.station.maths.formAngle / b.bend.angle : 1;
  const sweep = hemStation
    ? sweepCollisions(ctx, { bend: b, station: analysis, details, doneMask: pre.doneMask, fingers: [], startFraction: preFraction })
    : { collisions: [], partHeight: maxY, samples: 0 };
  warnings.push(...analysis.warnings);
  errors += analysis.hardErrors + sweep.collisions.filter(c => c.severity === 'error').length;
  if (hm.load.message) warnings.push(hm.load.message);
  if (!hm.load.ok) errors++;
  const lim = ramLimits(ctx, st, Number.isFinite(maxY) ? maxY : 0, sweep.partHeight, hm.ramDepth);
  warnings.push(...lim.warnings); errors += lim.errors;
  const hemHeight = Number.isFinite(maxY) ? maxY : 2 * t;
  const ri = b.bend.innerRadius;
  const step: BendStep = {
    index,
    kind: 'hem-flatten',
    bendId: b.id,
    stationId: st.station.id,
    punchId: st.punch.id, dieId: st.die.id,
    punchName: st.punch.name, dieName: st.die.name,
    placement: details.placement,
    targetAngle: 180, includedAngle: 0, springback: 0, overbendAngle: 180, loadedIncludedAngle: 0,
    actualInnerRadius: r2(ri),
    ramDepth: r2(hm.ramDepth),
    pinchY: r2(st.punch.height + hemHeight),
    ramUpperLimit: r2(lim.ramUpperLimit),
    force: r2(hm.force), forcePerMeter: r2(hm.forcePerMeter),
    loadPercentOfTool: Number.isFinite(hm.load.percentOfTool) ? Math.round(hm.load.percentOfTool * 10) / 10 : hm.load.percentOfTool,
    bendLength: r2(b.length),
    punchLength: r2(analysis.punchLength), segments: analysis.segments.slice(), partZOffset: r2(details.placement.partZOffset),
    backgauge: [], gaugeContact: 'none',
    gaugedFlangeOutside: r2((pre.gaugedSide === 1 ? pre.legs.child : pre.legs.parent).outside),
    bendDeduction: r2(bendDeduction(180, ri, b.bend.kFactor, t)), dimensionRef: 'tangent',
    orientation: { faceUp: details.placement.flipped ? 'bottom' : 'top', backFlangeId: details.placement.gaugedFlangeId },
    manipulation: { turn: 'none', stationChange },
    bottoming: false,
    collisions: sweep.collisions,
    warnings,
  };
  return { step, errors };
}

export function planProgram(input: PlannerInput, signal?: AbortSignal, onProgress?: (p: PlannerProgress) => void): BendProgram {
  const start = nowMs();
  const ctx = createContext(input, signal);
  const evaluator = createEvaluator(ctx, count => { if (onProgress && count % 25 === 0) onProgress({ phase: 'evaluate', done: count, total: count, sequencesEvaluated: 0 }); });
  const search = searchSequence(ctx, evaluator, onProgress);

  const steps: BendStep[] = [];
  const warnings: Message[] = [...ctx.part.warnings, ...ctx.warnings];
  let errors = 0;
  if (onProgress) onProgress({ phase: 'assemble', done: 0, total: search.steps.length, sequencesEvaluated: search.sequencesEvaluated });
  search.steps.forEach((s, i) => {
    const e = s.evaluation;
    const full = evaluator.evaluate(e.bend.index, e.doneMask, e.gaugedSide, e.station.station.index, true);
    const built = buildBendStep(ctx, full, steps.length, { turn: s.turn, stationChange: s.stationChange });
    steps.push(built.step); errors += built.errors;
    if (e.bend.isHem) {
      const hem = buildHemFlattenStep(ctx, full, steps.length);
      steps.push(hem.step); errors += hem.errors;
    }
    if (onProgress) onProgress({ phase: 'assemble', done: i + 1, total: search.steps.length, sequencesEvaluated: search.sequencesEvaluated });
  });

  const planned = new Set(steps.map(s => s.bendId));
  for (const b of ctx.bends) {
    if (!planned.has(b.id)) { warnings.push({ key: 'warnings.planner.noStation', severity: 'error', params: { bendId: b.id } }); errors++; }
  }
  const seen = new Set(warnings.map(w => `${w.key}|${JSON.stringify(w.params ?? {})}`));
  for (const msg of validateSetup(ctx.setup, ctx.machine, ctx.library)) {
    const key = `${msg.key}|${JSON.stringify(msg.params ?? {})}`;
    if (!seen.has(key)) { seen.add(key); warnings.push(msg); }
  }
  const feasible = errors === 0 && steps.every(s => s.collisions.every(c => c.severity !== 'error'));
  if (!feasible) warnings.push({ key: 'warnings.planner.infeasible', severity: 'error' });
  const maxForce = steps.reduce((m, s) => Math.max(m, s.force), 0);
  return {
    partId: ctx.part.flat.id,
    partName: ctx.part.flat.name,
    machineId: ctx.machine.id,
    setup: ctx.setup,
    materialId: ctx.material.id,
    thickness: ctx.t,
    steps,
    maxForce: r2(maxForce),
    feasible,
    warnings,
    stats: { sequencesEvaluated: search.sequencesEvaluated, timeMs: Math.round(nowMs() - start) },
  };
}
