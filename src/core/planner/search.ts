/**
 * Bend order search (ARCHITECTURE "Bend-sequence planner" §5, docs/specs/planner.md §5):
 * exhaustive depth-first search with branch-and-bound for ≤ 7 bends (children ordered by cost),
 * beam search (width 40) above or once `maxSequences` complete sequences have been evaluated;
 * `fixedOrder` only chooses the gauged side and station per step.
 */
import type { Turn } from '../types';
import type { PlanContext, PlannerProgress } from './context';
import { classifyTurn } from './placement';
import type { Evaluation, Evaluator, GaugedSide } from './evaluate';

export const BEAM_WIDTH = 40;
export const EXHAUSTIVE_MAX_BENDS = 7;

export interface SequenceStep {
  evaluation: Evaluation;
  turn: Turn;
  stationChange: boolean;
  /** Cost of this step in the sequence (evaluation cost + manipulation + tie-breakers). */
  stepCost: number;
}

export interface SearchResult {
  steps: SequenceStep[];
  cost: number;
  /** Partial and complete sequences explored (DFS nodes, or beam states). */
  sequencesEvaluated: number;
  /** The exhaustive search hit maxSequences (or n > 7) and the beam search finished the job. */
  fellBackToBeam: boolean;
}

export function manipulationCost(ctx: PlanContext, turn: Turn, stationChange: boolean): number {
  const w = ctx.options.weights;
  const turnCost = turn === 'none' ? 0 : turn === 'rotate180' ? w.rotate : w.flip;
  return turnCost + (stationChange ? w.stationChange : 0);
}

/** Tie-breakers: shorter legs first, leaf bends (deeper in the tree) before root bends. */
function tieBreak(ctx: PlanContext, ev: Evaluation, position: number, maxDepth: number): number {
  const n = ctx.bends.length;
  const late = (n - position) / n;
  const leg = Math.min(ev.legs.parent.outside, ev.legs.child.outside);
  return 1e-3 * late * leg + 1e-2 * late * (maxDepth - ev.bend.depth);
}

function stepFrom(ctx: PlanContext, prev: Evaluation | null, ev: Evaluation, position: number, maxDepth: number): SequenceStep {
  const turn: Turn = prev ? classifyTurn(prev.details.placement.transform, ev.details.placement.transform) : 'none';
  const stationChange = prev ? prev.station.station.index !== ev.station.station.index : false;
  const stepCost = ev.cost + manipulationCost(ctx, turn, stationChange) + tieBreak(ctx, ev, position, maxDepth);
  return { evaluation: ev, turn, stationChange, stepCost };
}

/** Total cost of a complete sequence of evaluations (the quantity the search minimises). */
export function sequenceCost(ctx: PlanContext, evaluations: Evaluation[]): number {
  const maxDepth = ctx.bends.reduce((m, b) => Math.max(m, b.depth), 1);
  let cost = 0;
  let prev: Evaluation | null = null;
  evaluations.forEach((ev, position) => { cost += stepFrom(ctx, prev, ev, position, maxDepth).stepCost; prev = ev; });
  return cost;
}

/** Candidate (side, station) evaluations of a bend at a state, cheapest first. */
function candidatesFor(ctx: PlanContext, ev: Evaluator, bendIndex: number, doneMask: number, prev: Evaluation | null, position: number, maxDepth: number): SequenceStep[] {
  const out: SequenceStep[] = [];
  for (const st of ctx.stations) {
    if (st.isHemming) continue;
    for (const side of [0, 1] as GaugedSide[]) {
      out.push(stepFrom(ctx, prev, ev.evaluate(bendIndex, doneMask, side, st.index), position, maxDepth));
    }
  }
  out.sort((a, b) => a.stepCost - b.stepCost);
  return out;
}

export function searchSequence(ctx: PlanContext, ev: Evaluator, onProgress?: (p: PlannerProgress) => void): SearchResult {
  const n = ctx.bends.length;
  const maxDepth = ctx.bends.reduce((m, b) => Math.max(m, b.depth), 1);
  const allMask = (1 << n) - 1;
  let sequences = 0;
  const report = (): void => {
    if (onProgress) onProgress({ phase: 'search', done: ev.count(), total: Math.max(ev.count(), n * (1 << Math.max(0, n - 1)) * 2 * Math.max(1, ctx.stations.length)), sequencesEvaluated: sequences });
  };
  if (n === 0 || ctx.stations.filter(s => !s.isHemming).length === 0) return { steps: [], cost: 0, sequencesEvaluated: 0, fellBackToBeam: false };

  if (ctx.options.fixedOrder && ctx.options.fixedOrder.length > 0) {
    const order: number[] = [];
    for (const id of ctx.options.fixedOrder) {
      const b = ctx.bends.find(x => x.id === id);
      if (b && !order.includes(b.index)) order.push(b.index);
    }
    for (const b of ctx.bends) if (!order.includes(b.index)) order.push(b.index);
    const steps: SequenceStep[] = [];
    let mask = 0, prev: Evaluation | null = null, cost = 0;
    order.forEach((bi, position) => {
      const c = candidatesFor(ctx, ev, bi, mask, prev, position, maxDepth)[0]!;
      steps.push(c); cost += c.stepCost; prev = c.evaluation; mask |= 1 << bi;
    });
    sequences = 1;
    report();
    return { steps, cost, sequencesEvaluated: 1, fellBackToBeam: false };
  }

  // exhaustive DFS with branch-and-bound
  const found: { best: SequenceStep[] | null; cost: number } = { best: null, cost: Infinity };
  let exhausted = false;
  const budget = Math.max(1, ctx.options.maxSequences);
  const acc: SequenceStep[] = [];
  const dfs = (mask: number, prev: Evaluation | null, cost: number): void => {
    if (exhausted || cost >= found.cost) return;
    ctx.checkAbort();
    sequences++;
    if (sequences % 50 === 0) report();
    if (sequences >= budget) { exhausted = true; return; }
    if (mask === allMask) { found.best = acc.slice(); found.cost = cost; return; }
    const position = acc.length;
    const options: SequenceStep[] = [];
    for (let bi = 0; bi < n; bi++) {
      if (mask & (1 << bi)) continue;
      options.push(...candidatesFor(ctx, ev, bi, mask, prev, position, maxDepth));
    }
    options.sort((a, b) => a.stepCost - b.stepCost);
    for (const step of options) {
      if (exhausted) return;
      if (cost + step.stepCost >= found.cost) break;
      acc.push(step);
      dfs(mask | (1 << step.evaluation.bend.index), step.evaluation, cost + step.stepCost);
      acc.pop();
    }
  };
  if (n <= EXHAUSTIVE_MAX_BENDS) dfs(0, null, 0);
  const fellBackToBeam = n > EXHAUSTIVE_MAX_BENDS || exhausted;
  if (fellBackToBeam) {
    // beam search: keep the best BEAM_WIDTH partial sequences per level
    interface State { mask: number; steps: SequenceStep[]; cost: number; prev: Evaluation | null }
    let beam: State[] = [{ mask: 0, steps: [], cost: 0, prev: null }];
    for (let level = 0; level < n; level++) {
      ctx.checkAbort();
      const next: State[] = [];
      for (const s of beam) {
        for (let bi = 0; bi < n; bi++) {
          if (s.mask & (1 << bi)) continue;
          for (const c of candidatesFor(ctx, ev, bi, s.mask, s.prev, level, maxDepth)) {
            next.push({ mask: s.mask | (1 << bi), steps: [...s.steps, c], cost: s.cost + c.stepCost, prev: c.evaluation });
          }
        }
      }
      next.sort((a, b) => a.cost - b.cost);
      sequences += next.length;
      const seen = new Set<string>();
      beam = [];
      for (const s of next) {
        const key = `${s.mask}|${s.prev?.key ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key); beam.push(s);
        if (beam.length >= BEAM_WIDTH) break;
      }
      report();
    }
    const top = beam[0];
    if (top && top.cost < found.cost) { found.best = top.steps; found.cost = top.cost; }
  }
  report();
  return { steps: found.best ?? [], cost: found.cost === Infinity ? 0 : found.cost, sequencesEvaluated: sequences, fellBackToBeam };
}
