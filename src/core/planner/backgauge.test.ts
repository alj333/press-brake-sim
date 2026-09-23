import { describe, it, expect } from 'vitest';
import { mat4 } from '../geom';
import { foldGeometry, partSilhouette } from '../part';
import { createContext } from './context';
import { computePlacementDetails } from './placement';
import { maxXInBand, planBackgauge } from './backgauge';
import { sampleSetup } from './test-helpers';
import type { SampleName } from '../testing/fixtures';

function gauge(name: SampleName, bendId: string, done: string[], gauged: 'parent' | 'child', tools?: { punchId: string; dieId: string }) {
  const s = sampleSetup(name, tools);
  const ctx = createContext({ part: s.part, material: s.material, machine: s.machine, setup: s.setup, library: s.library });
  const b = ctx.bends.find(x => x.id === bendId)!;
  const st = ctx.stations[0]!;
  const folded = foldGeometry(s.part, Object.fromEntries(done.map(id => [id, 1])));
  const gaugedId = gauged === 'child' ? b.link.childFlangeId : b.link.parentFlangeId;
  const details = computePlacementDetails(s.part, folded, bendId, gaugedId, st.station, ctx.t);
  const pieces = partSilhouette(folded, details.placement.transform, ctx.t);
  const result = planBackgauge(ctx, { bend: b, station: st, details, folded, pieces });
  return { s, ctx, b, st, details, pieces, result };
}

describe('maxXInBand', () => {
  it('restricts the max x to the y band', () => {
    const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(maxXInBand(tri, -1, 11)).toBeCloseTo(10, 9);
    expect(maxXInBand(tri, 5, 11)).toBeCloseTo(5, 9);
    expect(maxXInBand(tri, 20, 30)).toBe(-Infinity);
  });
});

describe('planBackgauge', () => {
  it('L-bracket, short leg gauged: cut edge at X = 38.26, R = −9, two fingers at ¼ / ¾', () => {
    const { result, details, s } = gauge('L-bracket', 'B1', [], 'child');
    expect(result.contact).toBe('cut-edge');
    expect(Math.abs(result.contactX - 38.26)).toBeLessThan(0.1);
    expect(result.fingers.length).toBe(2);
    for (const f of result.fingers) {
      expect(Math.abs(f.x - 38.26)).toBeLessThan(0.1);
      expect(f.r).toBeCloseTo(-(20 - s.truth.thickness) / 2, 6);
    }
    const [z0, z1] = details.bendZ;
    expect(result.fingers[0]!.z).toBeCloseTo(z0 + 20, 6);
    expect(result.fingers[1]!.z).toBeCloseTo(z0 + 60, 6);
    expect(z1 - z0).toBeCloseTo(80, 6);
    expect(result.hardErrors).toBe(0);
    expect(result.warnings.filter(w => w.severity === 'error')).toEqual([]);
  });

  it('L-bracket, long leg gauged: X = 58.26', () => {
    const { result } = gauge('L-bracket', 'B1', [], 'parent');
    expect(result.contact).toBe('cut-edge');
    expect(Math.abs(result.contactX - 58.26)).toBeLessThan(0.1);
    expect(result.fingers.every(f => Math.abs(f.x - 58.26) < 0.1)).toBe(true);
  });

  it('U-channel second bend gauging on the standing flange: flange-face at the outer face, R = ri + t + 2', () => {
    const { result, s } = gauge('U-channel', 'B2', ['B1'], 'parent');
    expect(result.contact).toBe('flange-face');
    // root flat extent from B2 = 114.79 − 40.52 = 74.27; outer face at + ri + t
    const b1 = s.part.flat.bends.find(b => b.id === 'B1')!, b2 = s.part.flat.bends.find(b => b.id === 'B2')!;
    const ba = s.part.bendAllowance['B1']!;
    const expectedX = b2.p0.x - (b1.p0.x + ba / 2) + b1.innerRadius + s.truth.thickness;
    expect(Math.abs(result.contactX - expectedX)).toBeLessThan(0.1);
    expect(result.fingers[0]!.r).toBeCloseTo(b1.innerRadius + s.truth.thickness + 2, 6);
    expect(result.hardErrors).toBe(0);
  });

  it('U-channel second bend gauging the free leg: cut edge at 38.26', () => {
    const { result } = gauge('U-channel', 'B2', ['B1'], 'child');
    expect(result.contact).toBe('cut-edge');
    expect(Math.abs(result.contactX - 38.26)).toBeLessThan(0.1);
  });

  it('Z-bracket second bend with the first leg hanging down: gauging the flat leg is a cut edge', () => {
    const { result } = gauge('Z-bracket', 'B2', ['B1'], 'child');
    expect(result.contact).toBe('cut-edge');
    expect(Math.abs(result.contactX - 38.26)).toBeLessThan(0.1);
    expect(result.hardErrors).toBe(0);
  });

  it('tabbed plate, plate gauged: fingers stay away from the hole at v = 60', () => {
    const { result, details, s, ctx } = gauge('tabbed-plate', 'B1', [], 'parent');
    expect(result.contact).toBe('cut-edge');
    expect(Math.abs(result.contactX - 118)).toBeLessThan(0.1);
    const hole = s.truth.expected.holeNearGaugedEdge!;
    const holeZ = mat4.applyToPoint(details.placement.transform, { x: hole.u, y: hole.v, z: 0 }).z;
    const w = ctx.finger.width;
    expect(result.fingers.length).toBeGreaterThanOrEqual(1);
    for (const f of result.fingers) {
      expect(Math.abs(f.z - holeZ)).toBeGreaterThanOrEqual(hole.r + w / 2 - 1e-6);
      // stays on the plate edge
      const edge0 = mat4.applyToPoint(details.placement.transform, { x: 0, y: 0, z: 0 }).z;
      const edge1 = mat4.applyToPoint(details.placement.transform, { x: 0, y: 80, z: 0 }).z;
      expect(f.z - w / 2).toBeGreaterThanOrEqual(Math.min(edge0, edge1) - 1e-6);
      expect(f.z + w / 2).toBeLessThanOrEqual(Math.max(edge0, edge1) + 1e-6);
    }
    expect(result.warnings.some(w => w.key === 'warnings.gauge.fingerMoved' || w.key === 'warnings.gauge.singleFinger')).toBe(true);
  });

  it('tabbed plate, tab gauged: one finger centred on the 30 mm tab', () => {
    const { result, details } = gauge('tabbed-plate', 'B1', [], 'child');
    expect(result.contact).toBe('cut-edge');
    expect(Math.abs(result.contactX - 23.26)).toBeLessThan(0.1);
    expect(result.fingers.length).toBe(1);
    expect(result.fingers[0]!.z).toBeCloseTo((details.bendZ[0] + details.bendZ[1]) / 2, 6);
  });

  it('box B3 with the side walls standing: gauging the base contacts the B1 wall face', () => {
    const { result } = gauge('box-4-flange', 'B3', ['B1', 'B2', 'B4'], 'parent');
    expect(result.contact).toBe('flange-face');
    expect(result.hardErrors).toBe(0);
    expect(result.fingers.length).toBe(2);
  });
});
