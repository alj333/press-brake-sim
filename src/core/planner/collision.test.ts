import { describe, it, expect } from 'vitest';
import { buildPartModel, foldGeometry, partSilhouette } from '../part';
import { createContext } from './context';
import type { PlanContext } from './context';
import { computePlacementDetails } from './placement';
import { analyseStation, bendStationMaths } from './stations';
import { planBackgauge } from './backgauge';
import { cutBox, sweepCollisions } from './collision';
import { makeBoxFlat, sampleSetup } from './test-helpers';
import { area } from '../geom';
import type { SampleName } from '../testing/fixtures';
import type { PartModel } from '../types';

function prepare(ctx: PlanContext, bendId: string, done: string[], gauged: 'parent' | 'child') {
  const b = ctx.bends.find(x => x.id === bendId)!;
  const st = ctx.stations[0]!;
  let mask = 0;
  for (const id of done) mask |= 1 << ctx.bends.find(x => x.id === id)!.index;
  const folded = ctx.folded(ctx.foldStateFor(mask));
  const gaugedId = gauged === 'child' ? b.link.childFlangeId : b.link.parentFlangeId;
  const details = computePlacementDetails(ctx.part, folded, bendId, gaugedId, st.station, ctx.t);
  const pieces = partSilhouette(folded, details.placement.transform, ctx.t);
  const maths = bendStationMaths(ctx, b, st);
  const station = analyseStation(ctx, b, st, maths, details, pieces);
  const bg = planBackgauge(ctx, { bend: b, station: st, details, folded, pieces });
  return { b, st, mask, folded, details, pieces, station, bg };
}

function ctxFor(name: SampleName): PlanContext {
  const s = sampleSetup(name);
  return createContext({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
}

function ctxForPart(part: PartModel): PlanContext {
  const s = sampleSetup('box-4-flange');
  return createContext({ part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
}

describe('cutBox', () => {
  it('removes a box from a rectangle and keeps simple pieces', () => {
    const r = [{ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: -10, y: 20 }];
    const pieces = cutBox(r, -5, 5, 10, Infinity);
    // the union of the pieces covers the rectangle minus the 10 × 10 notch (pieces may overlap)
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of pieces) for (const v of p) expect(v.x < -5 + 1e-9 || v.x > 5 - 1e-9 || v.y < 10 + 1e-9).toBe(true);
    const total = pieces.reduce((s, p) => s + area(p), 0);
    expect(total).toBeGreaterThanOrEqual(300 - 1e-6);
  });
});

describe('sweepCollisions', () => {
  it('L-bracket: no collisions with either leg gauged; the part rises to ~40 mm', () => {
    const ctx = ctxFor('L-bracket');
    for (const side of ['child', 'parent'] as const) {
      const p = prepare(ctx, 'B1', [], side);
      const r = sweepCollisions(ctx, { bend: p.b, station: p.station, details: p.details, doneMask: 0, fingers: p.bg.fingers });
      expect(r.collisions).toEqual([]);
      expect(r.samples).toBe(19 + 1);
      expect(r.partHeight).toBeGreaterThan(35);
      expect(r.partHeight).toBeLessThan(60);
    }
  });

  it('Z-bracket second bend: the hanging first leg clears the die on both sides', () => {
    const ctx = ctxFor('Z-bracket');
    for (const side of ['child', 'parent'] as const) {
      const p = prepare(ctx, 'B2', ['B1'], side);
      const r = sweepCollisions(ctx, { bend: p.b, station: p.station, details: p.details, doneMask: p.mask, fingers: p.bg.fingers });
      expect(r.collisions.filter(c => c.severity === 'error')).toEqual([]);
    }
  });

  it('box B3 with the side walls standing: no collision with the shortened punch', () => {
    const ctx = ctxFor('box-4-flange');
    const p = prepare(ctx, 'B3', ['B1', 'B2', 'B4'], 'child');
    expect(p.station.punchLength).toBeLessThan(192);
    const r = sweepCollisions(ctx, { bend: p.b, station: p.station, details: p.details, doneMask: p.mask, fingers: p.bg.fingers });
    expect(r.collisions.filter(c => c.severity === 'error')).toEqual([]);
    // the same bend with a full-length punch hits the standing side walls
    const full = { ...p.station, punchZ: [p.st.zStart, p.st.zEnd] as [number, number] };
    const r2 = sweepCollisions(ctx, { bend: p.b, station: full, details: p.details, doneMask: p.mask, fingers: p.bg.fingers });
    expect(r2.collisions.some(c => c.with === 'punch' && c.severity === 'error')).toBe(true);
  });

  it('box with 400 mm flanges: the standing walls hit the clamp or the ram', () => {
    const part = buildPartModel(makeBoxFlat(192, 142, 400));
    expect(part.links.length).toBe(4);
    const ctx = ctxForPart(part);
    const p = prepare(ctx, 'B3', ['B1', 'B2', 'B4'], 'child');
    const r = sweepCollisions(ctx, { bend: p.b, station: p.station, details: p.details, doneMask: p.mask, fingers: p.bg.fingers });
    const kinds = r.collisions.filter(c => c.severity === 'error').map(c => c.with);
    expect(kinds.some(k => k === 'clamp' || k === 'ram')).toBe(true);
    for (const c of r.collisions) {
      expect(c.depth).toBeGreaterThan(0.2);
      expect(c.message.key).toBe(`collisions.${c.with}`);
      expect(Number.isFinite(c.location.x) && Number.isFinite(c.location.y) && Number.isFinite(c.location.z)).toBe(true);
    }
  });

  it('tabbed plate: the plate beside the tab is collision-free with the short punch over the tab', () => {
    const ctx = ctxFor('tabbed-plate');
    const p = prepare(ctx, 'B1', [], 'parent');
    expect(p.station.punchLength).toBeLessThanOrEqual(30);
    const r = sweepCollisions(ctx, { bend: p.b, station: p.station, details: p.details, doneMask: 0, fingers: p.bg.fingers });
    expect(r.collisions.filter(c => c.severity === 'error')).toEqual([]);
    // (a full-length punch over the flat strips is prevented by the Z-clearance analysis, not by the
    // sweep: the fold model keeps the root flange rigid, so the strips follow the leg into the V)
  });

  it('stopAtError stops early and reports at most the first error', () => {
    const part = buildPartModel(makeBoxFlat(192, 142, 400));
    const ctx = ctxForPart(part);
    const p = prepare(ctx, 'B3', ['B1', 'B2', 'B4'], 'child');
    const r = sweepCollisions(ctx, { bend: p.b, station: p.station, details: p.details, doneMask: p.mask, fingers: p.bg.fingers, stopAtError: true });
    expect(r.collisions.filter(c => c.severity === 'error').length).toBe(1);
    expect(r.samples).toBeLessThanOrEqual(20);
  });

  it('the folded geometry used for the sweep matches the fold state (bendPose consistency)', () => {
    const ctx = ctxFor('hat-channel');
    const p = prepare(ctx, 'B1', ['B2'], 'child');
    const state = ctx.foldStateFor(p.mask, p.b.index, 0.5);
    const g = foldGeometry(ctx.part, state);
    expect(g.bends.find(b => b.bendId === 'B1')!.currentAngle).toBeCloseTo(45, 9);
    const r = sweepCollisions(ctx, { bend: p.b, station: p.station, details: p.details, doneMask: p.mask, fingers: p.bg.fingers });
    expect(r.samples).toBe(20);
  });
});
