import { describe, expect, it } from 'vitest';
import { vDie } from '../tools';
import { planProgram } from './program';
import { recommendSetups } from './recommend';
import type { PlannerInput } from './context';
import { sampleSetup } from './test-helpers';

function inputFor(name: Parameters<typeof sampleSetup>[0]): PlannerInput {
  const setup = sampleSetup(name);
  return {
    part: setup.part,
    material: setup.material,
    machine: setup.machine,
    setup: setup.setup,
    library: setup.library,
  };
}

describe('feasibility setup advisor', () => {
  it('diagnoses the hat-channel die body and returns tested, non-applicable 48 mm concepts', () => {
    const input = inputFor('hat-channel');
    const before = JSON.stringify(input);
    const baseline = planProgram(input);
    const report = recommendSetups(input, baseline);

    expect(report.state).toBe('recommendations');
    expect(report.noLibrarySolution).toBe(true);
    expect(report.issues.hardErrors).toBe(2);
    expect(report.issues.bends).toEqual(['B2', 'B3']);
    expect(report.issues.obstacles).toEqual(['die']);
    expect(report.testedCandidates).toBeGreaterThan(20);
    expect(report.recommendations).toHaveLength(2);

    const preferred = report.recommendations[0]!;
    expect(preferred.variant).toBe('angle-margin');
    expect(preferred.outcome).toBe('custom-required');
    expect(preferred.source).toBe('geometry-hypothesis');
    expect(preferred.simulationTested).toBe(true);
    expect(preferred.productionVerified).toBe(false);
    expect(preferred.candidateSetup).toBeUndefined();
    expect(preferred.errorsAfter).toBe(0);
    expect(preferred.bottomingSteps).toBe(0);
    expect(preferred.geometry?.current.bodyWidth).toBe(60);
    expect(preferred.geometry?.firstModelPassingBodyWidth).toBe(50);
    expect(preferred.geometry?.conceptBodyWidth).toBe(48);
    expect(preferred.geometry?.proposed.vWidth).toBe(16);
    expect(preferred.geometry?.proposed.vAngle).toBe(85);
    expect(preferred.requiredLoadPerMeter).toBeCloseTo(149.1, 1);
    expect(preferred.suggestedBackgaugeRetract).toBe(5);

    const minimal = report.recommendations[1]!;
    expect(minimal.variant).toBe('minimal-change');
    expect(minimal.geometry?.proposed.vAngle).toBe(88);
    expect(minimal.geometry?.conceptBodyWidth).toBe(48);
    expect(minimal.bottomingSteps).toBe(4);
    expect(JSON.stringify(input)).toBe(before);
  }, 30_000);

  it('promotes an imported narrow die to an applicable, fully simulated library setup', () => {
    const input = inputFor('hat-channel');
    const die = vDie(
      { vWidth: 16, vAngle: 88, shoulderRadius: 1.5, bodyWidth: 48, height: 60 },
      { id: 'custom:rated-v16-narrow', name: 'Rated V16 narrow body 48', source: 'custom', maxLoadPerMeter: 300 },
    );
    input.library = { ...input.library, dies: [...input.library.dies, die] };
    const baseline = planProgram(input);
    const report = recommendSetups(input, baseline);
    const applicable = report.recommendations.find(recommendation => recommendation.changes.some(change => change.toId === die.id));

    expect(report.noLibrarySolution).toBe(false);
    expect(applicable?.outcome).toBe('feasible');
    expect(applicable?.source).toBe('library-simulated');
    expect(applicable?.candidateSetup?.stations[0]?.dieId).toBe(die.id);
    const verified = planProgram({ ...input, setup: applicable!.candidateSetup! });
    expect(verified.feasible).toBe(true);
    expect(verified.steps.flatMap(step => step.collisions.filter(collision => collision.severity === 'error'))).toEqual([]);
  }, 30_000);

  it('finds a paired acute punch and die when neither one-tool change can solve the angle', () => {
    const input = inputFor('acute-bracket');
    const baseline = planProgram(input);
    const report = recommendSetups(input, baseline);
    const recommendation = report.recommendations[0]!;

    expect(recommendation.outcome).toBe('feasible');
    expect(recommendation.source).toBe('library-simulated');
    expect(recommendation.changes.map(change => change.kind).sort()).toEqual(['die', 'punch']);
    expect(recommendation.changes.find(change => change.kind === 'punch')?.toId).toMatch(/punch-acute/);
    expect(recommendation.changes.find(change => change.kind === 'die')?.toId).toMatch(/die-v(12|16)-30/);
    expect(planProgram({ ...input, setup: recommendation.candidateSetup! }).feasible).toBe(true);
  }, 10_000);

  it('does nothing for a feasible program and honours cancellation', () => {
    const feasibleInput = inputFor('box-4-flange');
    const feasible = planProgram(feasibleInput);
    expect(recommendSetups(feasibleInput, feasible)).toMatchObject({ state: 'already-feasible', recommendations: [], testedCandidates: 0 });

    const failedInput = inputFor('hat-channel');
    const failed = planProgram(failedInput);
    const controller = new AbortController();
    controller.abort();
    expect(() => recommendSetups(failedInput, failed, controller.signal)).toThrowError(/cancelled/);
  });
});
