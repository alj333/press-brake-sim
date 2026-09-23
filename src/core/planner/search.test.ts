import { describe, it, expect } from 'vitest';
import { buildPartModel } from '../part';
import { planProgram } from './index';
import { sampleSetup } from './test-helpers';
import type { FlatPattern } from '../types';

/** Corrugated strip: n parallel 90° bends alternating up/down, 40 mm pitch, 60 mm wide. */
function corrugation(n: number, pitch = 40, width = 60): FlatPattern {
  const src = { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } as const;
  const bends: FlatPattern['bends'] = [];
  for (let i = 0; i < n; i++) {
    const u = pitch * (i + 1);
    bends.push({ id: `B${i + 1}`, p0: { x: u, y: 0 }, p1: { x: u, y: width }, direction: i % 2 === 0 ? 'up' : 'down', angle: 90, innerRadius: 2, kFactor: 0.44, sources: src });
  }
  const L = pitch * (n + 1);
  return { id: `corr-${n}`, name: `corr-${n}`, thickness: 2, materialId: 'std:mild-steel', outline: [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: width }, { x: 0, y: width }], holes: [], bends };
}

describe('search modes', () => {
  it('beam search (maxSequences exhausted) still plans the whole box', () => {
    const s = sampleSetup('box-4-flange');
    const p = planProgram({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library, options: { maxSequences: 3 } });
    expect(p.steps.length).toBe(4);
    expect(new Set(p.steps.map(x => x.bendId)).size).toBe(4);
    expect(p.feasible).toBe(true);
    expect(p.stats.sequencesEvaluated).toBeGreaterThan(3);
  });

  it('an 8-bend corrugation goes through the beam search and plans every bend in reasonable time', () => {
    const s = sampleSetup('L-bracket');
    const part = buildPartModel(corrugation(8));
    expect(part.links.length).toBe(8);
    const t0 = Date.now();
    const p = planProgram({ part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
    const elapsed = Date.now() - t0;
    expect(p.steps.length).toBe(8);
    expect(new Set(p.steps.map(x => x.bendId)).size).toBe(8);
    expect(elapsed).toBeLessThan(20000);
    // eslint-disable-next-line no-console
    console.log(`8-bend corrugation: ${elapsed} ms, feasible=${p.feasible}, sequences=${p.stats.sequencesEvaluated}, flips=${p.steps.filter(x => x.manipulation.turn !== 'none').length}`);
  });

  it('a 5-bend corrugation is planned exhaustively', () => {
    const s = sampleSetup('L-bracket');
    const part = buildPartModel(corrugation(5));
    const t0 = Date.now();
    const p = planProgram({ part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
    const elapsed = Date.now() - t0;
    expect(p.steps.length).toBe(5);
    expect(elapsed).toBeLessThan(10000);
    // eslint-disable-next-line no-console
    console.log(`5-bend corrugation: ${elapsed} ms, feasible=${p.feasible}, sequences=${p.stats.sequencesEvaluated}`);
  });
});

import { createContext, createEvaluator, searchSequence, sequenceCost } from './index';
import type { Evaluation } from './index';

describe('exhaustive search optimality', () => {
  it('matches a brute-force enumeration on the 4-bend box and a 4-bend corrugation', () => {
    const s = sampleSetup('box-4-flange');
    for (const part of [s.part, buildPartModel(corrugation(4))]) {
      const ctx = createContext({ part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
      const ev = createEvaluator(ctx);
      const result = searchSequence(ctx, ev);
      const n = ctx.bends.length;
      let best = Infinity;
      const perms = (arr: number[]): number[][] => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map(p => [x, ...p]));
      for (const order of perms([...Array(n).keys()])) {
        for (let sides = 0; sides < 1 << n; sides++) {
          const evs: Evaluation[] = [];
          let mask = 0;
          order.forEach((bi, k) => { evs.push(ev.evaluate(bi, mask, ((sides >> k) & 1) as 0 | 1, 0)); mask |= 1 << bi; });
          best = Math.min(best, sequenceCost(ctx, evs));
        }
      }
      expect(result.steps.length).toBe(n);
      expect(sequenceCost(ctx, result.steps.map(st => st.evaluation))).toBeCloseTo(result.cost, 9);
      expect(result.cost).toBeCloseTo(best, 9);
    }
  });
});
