import { describe, it, expect } from 'vitest';
import { loadTruth } from '../../testing/fixtures';
import { matchToDxf, applyFlatTransform, kabsch2d } from './match';
import type { BendLine, FlatPattern, RecognizedSheet, Vec2 } from '../../types';
import { vec2 } from '../../geom';

/** A RecognizedSheet stub around a flat (what matchToDxf reads). */
function recOf(flat: FlatPattern, source: 'step' | 'mesh' = 'step'): RecognizedSheet {
  const bends = flat.bends.map(b => ({ ...b, sources: { geometry: source, angle: source, radius: source, direction: source } }));
  return {
    thickness: flat.thickness, bendCount: bends.length, bends3d: [], faces: [],
    flat: { ...flat, bends }, meshToPart: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], confidence: 1, issues: [],
  };
}

function transformFlat(flat: FlatPattern, rot: number, tr: Vec2, mirror: boolean): FlatPattern {
  const m = (p: Vec2) => vec2.add(vec2.rotate(mirror ? { x: -p.x, y: p.y } : p, rot), tr);
  return {
    ...flat, outline: flat.outline.map(m), holes: flat.holes.map(h => h.map(m)),
    bends: flat.bends.map(b => ({ ...b, p0: m(b.p0), p1: m(b.p1), direction: mirror ? (b.direction === 'up' ? 'down' : 'up') : b.direction })),
  };
}

/** DXF-style copy: default angle / radius, geometry from the drawing. */
function asDxf(flat: FlatPattern): FlatPattern {
  return {
    ...flat,
    bends: flat.bends.map(b => ({ ...b, angle: 90, innerRadius: 1.28 * flat.thickness, sources: { geometry: 'dxf', angle: 'default', radius: 'default', direction: 'dxf' } })),
  };
}

function perpDistance(p: Vec2, line: BendLine): number {
  const n = vec2.perp(vec2.normalize(vec2.sub(line.p1, line.p0)));
  return Math.abs(vec2.dot(vec2.sub(p, line.p0), n));
}

describe('kabsch2d', () => {
  it('recovers a rotation + translation', () => {
    const a = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 3, y: 7 }];
    const b = a.map(p => vec2.add(vec2.rotate(p, 33), { x: 4, y: -9 }));
    const k = kabsch2d(a, b);
    expect(k.rotationDeg).toBeCloseTo(33, 9);
    expect(k.translation.x).toBeCloseTo(4, 9);
    expect(k.translation.y).toBeCloseTo(-9, 9);
  });
});

describe('matchToDxf', () => {
  it('identity: every bend paired, attributes copied with the rec source, geometry kept', () => {
    const truth = loadTruth('hat-channel');
    const rec = recOf(truth.flat, 'mesh');
    const dxf = asDxf(truth.flat);
    const m = matchToDxf(rec, dxf);
    expect(m.pairs.length).toBe(4);
    expect(m.unmatchedDxf).toEqual([]);
    expect(m.unmatchedRec).toEqual([]);
    expect(m.mirrored).toBe(false);
    expect(Math.abs(m.transform.rotationDeg)).toBeLessThan(1e-6);
    expect(vec2.length(m.transform.translation)).toBeLessThan(1e-6);
    for (const b of m.flat.bends) {
      const t = truth.flat.bends.find(x => x.id === b.id)!;
      expect(b.angle).toBe(t.angle);
      expect(b.innerRadius).toBe(t.innerRadius);
      expect(b.direction).toBe(t.direction);
      expect(b.sources).toEqual({ geometry: 'dxf', angle: 'mesh', radius: 'mesh', direction: 'mesh' });
      expect(b.p0).toEqual(t.p0);
      expect(b.kFactor).toBe(t.kFactor);
    }
    expect(m.warnings).toEqual([]);
    // the DXF input is not mutated
    expect(dxf.bends[0]!.angle).toBe(90);
    expect(dxf.bends[0]!.sources.angle).toBe('default');
  });

  it('rotated + translated DXF: transform recovered, midpoints map onto the DXF lines', () => {
    const truth = loadTruth('hat-channel');
    const rec = recOf(truth.flat);
    const dxf = asDxf(transformFlat(truth.flat, 37, { x: 123.4, y: -55.5 }, false));
    const m = matchToDxf(rec, dxf);
    expect(m.pairs.length).toBe(4);
    expect(m.mirrored).toBe(false);
    expect(Math.abs(m.transform.rotationDeg - 37)).toBeLessThan(1e-6);
    expect(Math.abs(m.transform.translation.x - 123.4)).toBeLessThan(1e-6);
    expect(Math.abs(m.transform.translation.y + 55.5)).toBeLessThan(1e-6);
    for (const p of m.pairs) {
      const rb = rec.flat.bends.find(b => b.id === p.recBendId)!, db = dxf.bends.find(b => b.id === p.dxfBendId)!;
      expect(perpDistance(applyFlatTransform(vec2.midpoint(rb.p0, rb.p1), m.transform), db)).toBeLessThan(1e-6);
    }
  });

  it('mirrored DXF of an asymmetric part: mirrored = true and directions inverted', () => {
    const truth = loadTruth('tabbed-plate');
    const rec = recOf(truth.flat);
    const dxf = asDxf(transformFlat(truth.flat, -120, { x: -10, y: 20 }, true));
    const m = matchToDxf(rec, dxf);
    expect(m.pairs.length).toBe(1);
    expect(m.mirrored).toBe(true);
    expect(m.transform.mirrored).toBe(true);
    expect(m.flat.bends[0]!.direction).toBe('down');     // rec 'up' inverted
    expect(m.warnings.some(w => w.key === 'warnings.recognize.matchMirrored' && w.severity === 'info')).toBe(true);
    // the outline of the rec maps onto the DXF outline
    for (const p of rec.flat.outline) {
      const q = applyFlatTransform(p, m.transform);
      expect(Math.min(...dxf.outline.map(o => vec2.dist(o, q)))).toBeLessThan(1e-6);
    }
  });

  it('mirrored DXF of a symmetric part: the DXF direction labels decide', () => {
    const truth = loadTruth('U-channel');
    const rec = recOf(truth.flat);
    const dxf = asDxf(transformFlat(truth.flat, 90, { x: 5, y: 5 }, true));   // both bends 'down' in the DXF
    const m = matchToDxf(rec, dxf);
    expect(m.pairs.length).toBe(2);
    expect(m.mirrored).toBe(true);
    expect(m.flat.bends.map(b => b.direction)).toEqual(['down', 'down']);
  });

  it('bend lines drawn across the relief slots (longer DXF lines) still pair', () => {
    const truth = loadTruth('tabbed-plate');
    const rec = recOf(truth.flat);
    const dxf = asDxf(truth.flat);
    dxf.bends[0] = { ...dxf.bends[0]!, p0: { x: 118, y: 23 }, p1: { x: 118, y: 57 } };
    const m = matchToDxf(rec, dxf);
    expect(m.pairs).toEqual([{ dxfBendId: 'B1', recBendId: 'B1' }]);
    expect(m.flat.bends[0]!.p0).toEqual({ x: 118, y: 23 });     // DXF geometry kept
    expect(m.flat.bends[0]!.angle).toBe(90);
    expect(m.flat.bends[0]!.innerRadius).toBe(2);
  });

  it('extra DXF bend and missing DXF bend are reported', () => {
    const truth = loadTruth('hat-channel');
    const rec = recOf(truth.flat);
    const extra = asDxf(truth.flat);
    extra.bends.push({ ...extra.bends[0]!, id: 'B9', p0: { x: 5, y: 0 }, p1: { x: 5, y: 100 } });
    const m1 = matchToDxf(rec, extra);
    expect(m1.pairs.length).toBe(4);
    expect(m1.unmatchedDxf).toEqual(['B9']);
    expect(m1.unmatchedRec).toEqual([]);
    expect(m1.warnings.map(w => w.key)).toEqual(['warnings.recognize.bendCountMismatch', 'warnings.recognize.unmatchedDxfBend']);
    expect(m1.flat.bends.find(b => b.id === 'B9')!.sources.angle).toBe('default');

    const missing = asDxf(truth.flat);
    missing.bends = missing.bends.filter(b => b.id !== 'B3');
    const m2 = matchToDxf(rec, missing);
    expect(m2.pairs.length).toBe(3);
    expect(m2.unmatchedRec).toEqual(['B3']);
    expect(m2.unmatchedDxf).toEqual([]);
    expect(m2.warnings.some(w => w.key === 'warnings.recognize.unmatchedRecBend' && w.params?.bendId === 'B3')).toBe(true);
  });

  it('more than 4 bends (RANSAC path) with shuffled ids and one extra line', () => {
    const base: FlatPattern = {
      id: 'six', name: 'six', thickness: 2, materialId: 'm',
      outline: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }], holes: [],
      bends: [
        { id: 'B1', p0: { x: 20, y: 30 }, p1: { x: 280, y: 30 }, direction: 'up', angle: 90, innerRadius: 2, kFactor: 0.44, sources: { geometry: 'step', angle: 'step', radius: 'step', direction: 'step' } },
        { id: 'B2', p0: { x: 20, y: 100 }, p1: { x: 200, y: 100 }, direction: 'down', angle: 45, innerRadius: 3, kFactor: 0.44, sources: { geometry: 'step', angle: 'step', radius: 'step', direction: 'step' } },
        { id: 'B3', p0: { x: 100, y: 170 }, p1: { x: 280, y: 170 }, direction: 'up', angle: 135, innerRadius: 1.5, kFactor: 0.44, sources: { geometry: 'step', angle: 'step', radius: 'step', direction: 'step' } },
        { id: 'B4', p0: { x: 250, y: 60 }, p1: { x: 250, y: 150 }, direction: 'up', angle: 90, innerRadius: 2, kFactor: 0.44, sources: { geometry: 'step', angle: 'step', radius: 'step', direction: 'step' } },
        { id: 'B5', p0: { x: 60, y: 120 }, p1: { x: 60, y: 190 }, direction: 'down', angle: 60, innerRadius: 2, kFactor: 0.44, sources: { geometry: 'step', angle: 'step', radius: 'step', direction: 'step' } },
        { id: 'B6', p0: { x: 150, y: 40 }, p1: { x: 200, y: 90 }, direction: 'up', angle: 90, innerRadius: 2, kFactor: 0.44, sources: { geometry: 'step', angle: 'step', radius: 'step', direction: 'step' } },
      ],
    };
    const rec = recOf(base);
    const moved = transformFlat(base, 123, { x: -40, y: 77 }, false);
    const dxf = asDxf(moved);
    dxf.bends = [dxf.bends[3]!, dxf.bends[5]!, dxf.bends[0]!, dxf.bends[4]!, dxf.bends[1]!, dxf.bends[2]!].map((b, i) => ({ ...b, id: `D${i + 1}` }));
    dxf.bends.push({ ...dxf.bends[0]!, id: 'D7', p0: { x: -100, y: -100 }, p1: { x: -100, y: -50 } });
    const m = matchToDxf(rec, dxf);
    expect(m.pairs.length).toBe(6);
    expect(m.unmatchedDxf).toEqual(['D7']);
    expect(m.mirrored).toBe(false);
    expect(Math.abs(m.transform.rotationDeg - 123)).toBeLessThan(1e-6);
    for (const p of m.pairs) {
      const rb = base.bends.find(b => b.id === p.recBendId)!, db = m.flat.bends.find(b => b.id === p.dxfBendId)!;
      expect(db.angle).toBe(rb.angle);
      expect(db.innerRadius).toBe(rb.innerRadius);
      expect(db.direction).toBe(rb.direction);
    }
  });

  it('no bends on either side: nothing to match', () => {
    const truth = loadTruth('L-bracket');
    const rec = recOf({ ...truth.flat, bends: [] });
    const m = matchToDxf(rec, asDxf(truth.flat));
    expect(m.pairs).toEqual([]);
    expect(m.unmatchedDxf).toEqual(['B1']);
    expect(m.warnings.map(w => w.key)).toEqual(['warnings.recognize.noBendsToMatch', 'warnings.recognize.unmatchedDxfBend']);
    expect(m.transform).toEqual({ rotationDeg: 0, translation: { x: 0, y: 0 }, mirrored: false });
    const m2 = matchToDxf(recOf(truth.flat), { ...truth.flat, bends: [] });
    expect(m2.pairs).toEqual([]);
    expect(m2.unmatchedRec).toEqual(['B1']);
  });

  it('a single bend: aligned by direction and midpoint', () => {
    const truth = loadTruth('L-bracket');
    const rec = recOf(truth.flat);
    const dxf = asDxf(transformFlat(truth.flat, 200, { x: 1, y: 2 }, false));
    const m = matchToDxf(rec, dxf);
    expect(m.pairs.length).toBe(1);
    expect(m.unmatchedDxf).toEqual([]);
    expect(perpDistance(applyFlatTransform(vec2.midpoint(rec.flat.bends[0]!.p0, rec.flat.bends[0]!.p1), m.transform), dxf.bends[0]!)).toBeLessThan(1e-6);
  });

  it('a slightly skewed / offset DXF line still pairs within the tolerances (2°, 1 mm, 50 % overlap)', () => {
    const truth = loadTruth('L-bracket');
    const rec = recOf(truth.flat);
    const dxf = asDxf(truth.flat);
    dxf.bends[0] = { ...dxf.bends[0]!, p0: { x: 58.7, y: 30 }, p1: { x: 59.5, y: 80 } };   // 0.9° skew, ≤ 1 mm off, 62 % overlap
    expect(matchToDxf(rec, dxf).pairs.length).toBe(1);
    dxf.bends[0] = { ...dxf.bends[0]!, p0: { x: 58.26, y: 50 }, p1: { x: 58.26, y: 80 } };  // overlap 30 = 100 % of the shorter line
    expect(matchToDxf(rec, dxf).pairs.length).toBe(1);
    // with several bends the transform is pinned by the others: one line 2.5 mm off / 2.9° skewed /
    // shifted along itself to a 40 % overlap stays unmatched
    const hat = loadTruth('hat-channel');
    const recHat = recOf(hat.flat);
    const shifted = asDxf(hat.flat);
    shifted.bends[2] = { ...shifted.bends[2]!, p0: vec2.add(shifted.bends[2]!.p0, { x: 0, y: 60 }), p1: vec2.add(shifted.bends[2]!.p1, { x: 0, y: 60 }) };
    const mShift = matchToDxf(recHat, shifted);
    expect(mShift.pairs.length).toBe(3);
    expect(mShift.unmatchedDxf).toEqual(['B3']);
    const off = asDxf(hat.flat);
    off.bends[2] = { ...off.bends[2]!, p0: vec2.add(off.bends[2]!.p0, { x: 2.5, y: 0 }), p1: vec2.add(off.bends[2]!.p1, { x: 2.5, y: 0 }) };
    const mOff = matchToDxf(recHat, off);
    expect(mOff.pairs.length).toBe(3);
    expect(mOff.unmatchedDxf).toEqual(['B3']);
    const skew = asDxf(hat.flat);
    skew.bends[2] = { ...skew.bends[2]!, p0: vec2.add(skew.bends[2]!.p0, { x: -2.5, y: 0 }), p1: vec2.add(skew.bends[2]!.p1, { x: 2.5, y: 0 }) };
    const mSkew = matchToDxf(recHat, skew);
    expect(mSkew.pairs.length).toBe(3);
    expect(mSkew.unmatchedRec).toEqual(['B3']);
  });
});
