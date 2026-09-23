import { describe, it, expect } from 'vitest';
import { foldGeometry, partSilhouette } from '../part';
import { createContext } from './context';
import { computePlacementDetails } from './placement';
import { analyseStation, bendStationMaths, bestSegmentsWithin, flatMaterialLimits } from './stations';
import { sampleSetup } from './test-helpers';
import type { SampleName } from '../testing/fixtures';

function analyse(name: SampleName, bendId: string, done: string[], gauged: 'parent' | 'child') {
  const s = sampleSetup(name);
  const ctx = createContext({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
  const b = ctx.bends.find(x => x.id === bendId)!;
  const st = ctx.stations[0]!;
  const state = Object.fromEntries(done.map(id => [id, 1]));
  const folded = foldGeometry(s.part, state);
  const gaugedId = gauged === 'child' ? b.link.childFlangeId : b.link.parentFlangeId;
  const details = computePlacementDetails(s.part, folded, bendId, gaugedId, st.station, ctx.t);
  const pieces = partSilhouette(folded, details.placement.transform, ctx.t);
  const maths = bendStationMaths(ctx, b, st);
  return { ctx, b, st, details, maths, analysis: analyseStation(ctx, b, st, maths, details, pieces), truth: s.truth };
}

describe('bendStationMaths', () => {
  it('reproduces the L-bracket goldens (radius, springback, ram depth, force)', () => {
    const { maths, truth } = analyse('L-bracket', 'B1', [], 'child');
    const g = truth.expected.perBend['B1']!;
    expect(maths.riActual).toBeCloseTo(g.actualInnerRadius, 6);
    expect(maths.springback).toBeCloseTo(g.springback, 6);
    expect(maths.overbendAngle).toBeCloseTo(g.overbendAngle, 6);
    expect(maths.loadedIncludedAngle).toBeCloseTo(g.loadedIncludedAngle, 6);
    expect(Math.abs(maths.ramDepth - g.ramDepthSharpShoulder)).toBeLessThan(0.3);
    expect(Math.abs(maths.forcePerMeter - g.forcePerMeter) / g.forcePerMeter).toBeLessThan(0.02);
    expect(Math.abs(maths.force - g.force) / g.force).toBeLessThan(0.02);
    expect(maths.minLeg).toBeCloseTo(g.minLegOutside, 6);
    // 88° tools with a loaded angle of 88.29°: they fit (feasible) but violate the 1° margin (bottoming)
    expect(maths.angleFits).toBe(true);
    expect(maths.angleOk).toBe(false);
    expect(maths.load.percentOfTool).toBeCloseTo(14.91, 1);
  });
  it('acute bracket: 88° tools are angle-infeasible, 30° tools are feasible', () => {
    const a = analyse('acute-bracket', 'B1', [], 'child');
    expect(a.maths.angleOk).toBe(false);
    expect(a.maths.angleFits).toBe(false);
    expect(a.analysis.warnings.some(w => w.key === 'warnings.tool.angle' && w.severity === 'error')).toBe(true);
    expect(a.analysis.hardErrors).toBeGreaterThan(0);
    const s = sampleSetup('acute-bracket', { punchId: 'std:punch-acute-30-r0.8', dieId: 'std:die-v12-30' });
    const ctx = createContext({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
    const m = bendStationMaths(ctx, ctx.bends[0]!, ctx.stations[0]!);
    expect(m.angleOk).toBe(true);
    expect(m.angleFits).toBe(true);
    expect(m.loadedIncludedAngle).toBeCloseTo(s.truth.expected.perBend['B1']!.loadedIncludedAngle, 3);
  });
});

describe('flatMaterialLimits', () => {
  it('L-bracket: no material beyond the bend line ends', () => {
    const s = sampleSetup('L-bracket');
    const b = s.part.flat.bends[0]!;
    const lim = flatMaterialLimits(s.part.flat.outline, s.part.flat.holes, b.p0, b.p1, 9);
    expect(lim.sLeft).toBe(-Infinity);
    expect(lim.sRight).toBe(Infinity);
  });
  it('tabbed plate: the plate beside the reliefs limits the punch to the tab', () => {
    const s = sampleSetup('tabbed-plate');
    const b = s.part.flat.bends[0]!;
    const lim = flatMaterialLimits(s.part.flat.outline, s.part.flat.holes, b.p0, b.p1, 9);
    expect(lim.sLeft).toBeCloseTo(0, 1);
    expect(lim.sRight).toBeCloseTo(30, 1);
  });
  it('box B3: the side flanges limit the punch to the bend line', () => {
    const s = sampleSetup('box-4-flange');
    const b = s.part.flat.bends.find(x => x.id === 'B3')!;
    const lim = flatMaterialLimits(s.part.flat.outline, s.part.flat.holes, b.p0, b.p1, 9);
    expect(Math.abs(lim.sLeft)).toBeLessThan(0.6);
    expect(Math.abs(lim.sRight - 192)).toBeLessThan(0.6);
  });
});

describe('analyseStation', () => {
  it('L-bracket uses the whole station', () => {
    const { analysis, st } = analyse('L-bracket', 'B1', [], 'child');
    expect(analysis.punchLength).toBe(st.length);
    expect(analysis.segments).toEqual(st.station.segments);
    expect(analysis.tooShort).toBe(false);
    expect(analysis.hardErrors).toBe(0);
    expect(analysis.punchZ[0]).toBeCloseTo(0, 6);
    expect(analysis.punchZ[1]).toBeCloseTo(3100, 6);
  });
  it('tabbed plate: a short punch over the tab', () => {
    const { analysis, details } = analyse('tabbed-plate', 'B1', [], 'parent');
    expect(analysis.punchLength).toBeLessThanOrEqual(28);
    expect(analysis.punchLength).toBeGreaterThanOrEqual(22);
    expect(analysis.tooShort).toBe(false);
    const zc = (details.bendZ[0] + details.bendZ[1]) / 2;
    expect((analysis.punchZ[0] + analysis.punchZ[1]) / 2).toBeCloseTo(zc, 6);
    expect(analysis.segments.reduce((a, b) => a + b, 0)).toBeCloseTo(analysis.punchLength, 9);
  });
  it('box B3 with the side walls standing: punch shorter than the bend line', () => {
    const { analysis, b } = analyse('box-4-flange', 'B3', ['B2', 'B4'], 'child');
    expect(analysis.punchLength).toBeLessThan(192);
    expect(analysis.punchLength).toBeGreaterThanOrEqual(b.length - 8);
    expect(analysis.tooShort).toBe(false);
    expect(analysis.usable[1] - analysis.usable[0]).toBeLessThanOrEqual(192);
  });
  it('box B3 with the side flanges flat: still limited to the bend line (flat material)', () => {
    const { analysis } = analyse('box-4-flange', 'B3', [], 'child');
    expect(analysis.punchLength).toBeLessThan(192);
    expect(analysis.tooShort).toBe(false);
  });
});

describe('bestSegmentsWithin', () => {
  const std = [10, 15, 20, 40, 50, 100, 200, 300, 415, 835, 3000];
  it('unbounded: 28 → 15 + 10, 190 → 100 + 50 + 40, 3100 exact', () => {
    expect(bestSegmentsWithin(28, std, true)).toEqual([15, 10]);
    expect(bestSegmentsWithin(190, std, true)).toEqual([100, 50, 40]);
    expect(bestSegmentsWithin(140, std, true)).toEqual([100, 40]);
    expect(bestSegmentsWithin(3100, std, true)).toEqual([3000, 100]);
    const pieces = bestSegmentsWithin(3100, std.filter(l => l <= 835), true);
    expect(pieces.reduce((a, b) => a + b, 0)).toBe(3100);
    expect(pieces.length).toBeLessThanOrEqual(8);
    expect(bestSegmentsWithin(7, std, true)).toEqual([]);
  });
  it('mounted pieces each once: 190 from the default station → 180', () => {
    const st = [835, 835, 835, 415, 100, 50, 20, 10];
    expect(bestSegmentsWithin(190, st, false)).toEqual([100, 50, 20, 10]);
    expect(bestSegmentsWithin(1700, st, false)).toEqual([835, 835, 20, 10]);
    expect(bestSegmentsWithin(28, st, false)).toEqual([20]);
  });
});
