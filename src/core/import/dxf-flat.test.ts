import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE_NAMES, loadTruth, readSampleText, flatsEquivalent } from '../testing/fixtures';
import type { BendLine, Vec2 } from '../types';
import { bounds, isCCW, signedArea } from '../geom';
import { importDxfFlat, parseBendNote, lineOutlineCrossings, defaultInnerRadius } from './dxf-flat';
import { importToolProfileDxf } from './dxf-profile';
import { ImportError } from './errors';
import { dxfFile, line, lwpoly, circle, text, arc } from './dxf-common.test';

const OPTS = { thickness: 2, materialId: 'std:mild-steel', name: 'test' };

function sameEnds(a: BendLine, b: BendLine, tol: number): boolean {
  const d = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
  return (d(a.p0, b.p0) <= tol && d(a.p1, b.p1) <= tol) || (d(a.p0, b.p1) <= tol && d(a.p1, b.p0) <= tol);
}

describe('importDxfFlat — samples vs truth', () => {
  for (const name of SAMPLE_NAMES) {
    it(`${name}: outline bounds, bends, holes match the truth flat`, () => {
      const truth = loadTruth(name);
      const res = importDxfFlat(readSampleText(name, 'dxf'), { thickness: truth.thickness, materialId: truth.material.id, name });
      const flat = res.flat!;
      expect(flat).toBeDefined();
      expect(res.warnings.filter(w => w.severity !== 'info')).toEqual([]);
      // outline: CCW, same bounds within 0.05 mm
      expect(isCCW(flat.outline)).toBe(true);
      const bt = bounds(truth.flat.outline), bi = bounds(flat.outline);
      expect(Math.abs(bt.min.x - bi.min.x)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(bt.min.y - bi.min.y)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(bt.max.x - bi.max.x)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(bt.max.y - bi.max.y)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(signedArea(flat.outline) - signedArea(truth.flat.outline))).toBeLessThanOrEqual(0.05 * 500);
      // bends: same count, each truth bend has a matching imported bend (ends within 0.05, same direction)
      expect(flat.bends.length).toBe(truth.expected.bendCount);
      for (const tb of truth.flat.bends) {
        const match = flat.bends.find(b => sameEnds(b, tb, 0.05));
        expect(match, `bend ${tb.id} of ${name}`).toBeDefined();
        expect(match!.direction).toBe(tb.direction);
        expect(match!.sources).toEqual({ geometry: 'dxf', angle: 'default', radius: 'default', direction: 'dxf' });
        expect(match!.angle).toBe(90);
        expect(match!.kFactor).toBe(0.44);
      }
      // holes: circles flattened, CW
      expect(flat.holes.length).toBe(truth.expected.holeCount);
      for (const h of flat.holes) expect(isCCW(h)).toBe(false);
      expect(flat.sourceUnits).toBe('mm');
      expect(flat.thickness).toBe(truth.thickness);
      expect(flat.provenance?.outlineLayer).toBe('IV_OUTER_PROFILE');
      // signature-level equivalence with the truth (angles/radii are defaults here, so compare geometry only)
      const eq = flatsEquivalent({ ...flat, bends: flat.bends.map(b => ({ ...b, angle: 90 })) }, { ...truth.flat, bends: truth.flat.bends.map(b => ({ ...b, angle: 90 })) }, { tol: 0.05 });
      expect(eq.equivalent, eq.reasons.join('; ')).toBe(true);
      expect(eq.mirrored).toBe(false);
    });
  }

  it('every imported sample builds a PartModel with the expected flange count and no warnings', async () => {
    const { buildPartModel } = await import('../part');
    for (const name of SAMPLE_NAMES) {
      const truth = loadTruth(name);
      const flat = importDxfFlat(readSampleText(name, 'dxf'), { thickness: truth.thickness, materialId: truth.material.id, name, defaultRadius: 2 }).flat!;
      const part = buildPartModel(flat);
      expect(part.warnings, name).toEqual([]);
      expect(part.flanges.length, name).toBe(truth.expected.flangeCount);
      expect(part.links.length, name).toBe(truth.expected.bendCount);
    }
  });

  it('L-bracket: hole is the Ø10 circle at (25, 40) flattened at ≤ 0.05 mm chord error', () => {
    const flat = importDxfFlat(readSampleText('L-bracket', 'dxf'), OPTS).flat!;
    const h = flat.holes[0]!;
    expect(h.length).toBeGreaterThanOrEqual(16);
    for (const p of h) expect(Math.hypot(p.x - 25, p.y - 40)).toBeCloseTo(5, 9);
    expect(Math.abs(signedArea(h))).toBeGreaterThan(Math.PI * 25 * 0.98);
  });

  it('tabbed-plate: the short bend line keeps its relief-slot ends (no trim/extend)', () => {
    const flat = importDxfFlat(readSampleText('tabbed-plate', 'dxf'), OPTS).flat!;
    const b = flat.bends[0]!;
    expect(b.p0).toEqual({ x: 118, y: 25 });
    expect(b.p1).toEqual({ x: 118, y: 55 });
    expect(flat.outline.length).toBe(12);
  });

  it('default inner radius follows the air-bend rule (V = 8t) and options override it', () => {
    expect(defaultInnerRadius(2)).toBeCloseTo(2.56, 9);
    expect(defaultInnerRadius(1)).toBeCloseTo(1.28, 9);
    expect(defaultInnerRadius(2, { tensileStrength: 620, minInnerRadiusFactor: 1.5 })).toBeCloseTo(3.78, 9);
    const flat = importDxfFlat(readSampleText('L-bracket', 'dxf'), { ...OPTS, defaultAngle: 120, defaultRadius: 1.5, kFactor: 0.4 }).flat!;
    expect(flat.bends[0]!.angle).toBe(120);
    expect(flat.bends[0]!.innerRadius).toBe(1.5);
    expect(flat.bends[0]!.kFactor).toBe(0.4);
    const def = importDxfFlat(readSampleText('L-bracket', 'dxf'), OPTS).flat!;
    expect(def.bends[0]!.innerRadius).toBeCloseTo(2.56, 9);
  });
});

describe('importDxfFlat — synthetic files', () => {
  const rect = (w: number, h: number, layer = '0') => lwpoly([[0, 0], [w, 0], [w, h], [0, h]], true, layer);

  it('chains an outline of LINEs and ARCs on generic layers and finds bend lines on BEND / BEND_DOWN', () => {
    const ents = line(0, 0, 100, 0, 'CUT') + line(100, 0, 100, 50, 'CUT') + line(100, 50, 0, 50, 'CUT') + line(0, 50, 0, 0, 'CUT') +
      line(30, 0, 30, 50, 'BEND') + line(70, 0, 70, 50, 'BEND_DOWN') + circle(50, 25, 3, 'CUTOUT');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    const flat = res.flat!;
    expect(flat.outline.length).toBe(4);
    expect(isCCW(flat.outline)).toBe(true);
    expect(flat.holes.length).toBe(1);
    expect(flat.bends.map(b => b.direction)).toEqual(['up', 'down']);
    expect(flat.bends.map(b => b.id)).toEqual(['B1', 'B2']);
    expect(flat.provenance?.outlineLayer).toBe('CUT');
    expect(res.warnings).toEqual([]);
  });

  it('INSERT: outline and bend line inside a block, inserted with translation + rotation', () => {
    const blocks = `0\nBLOCK\n8\n0\n2\nPART\n70\n0\n10\n0\n20\n0\n30\n0\n3\nPART\n${rect(60, 40, 'IV_OUTER_PROFILE')}${line(30, 0, 30, 40, 'IV_BEND')}0\nENDBLK\n`;
    const ins = `0\nINSERT\n8\n0\n2\nPART\n10\n100\n20\n100\n30\n0\n50\n90\n`;
    const flat = importDxfFlat(dxfFile(ins, { blocks }), OPTS).flat!;
    const b = bounds(flat.outline);
    // rotated 90° about the insert point: 60×40 → x ∈ [60, 100], y ∈ [100, 160]
    expect(b.min.x).toBeCloseTo(60, 9); expect(b.max.x).toBeCloseTo(100, 9);
    expect(b.min.y).toBeCloseTo(100, 9); expect(b.max.y).toBeCloseTo(160, 9);
    expect(isCCW(flat.outline)).toBe(true);
    expect(flat.bends.length).toBe(1);
    const bl = flat.bends[0]!;
    expect(Math.min(bl.p0.x, bl.p1.x)).toBeCloseTo(60, 9);
    expect(Math.max(bl.p0.x, bl.p1.x)).toBeCloseTo(100, 9);
    expect(bl.p0.y).toBeCloseTo(130, 9);
    expect(bl.p1.y).toBeCloseTo(130, 9);
  });

  it('$INSUNITS = 1: converts inches to mm and reports sourceUnits', () => {
    const ents = rect(4, 2, 'OUTLINE') + line(2, 0, 2, 2, 'BEND') + circle(1, 1, 0.25, '0');
    const flat = importDxfFlat(dxfFile(ents, { insunits: 1 }), OPTS).flat!;
    expect(flat.sourceUnits).toBe('in');
    expect(flat.provenance?.units).toBe('in');
    const b = bounds(flat.outline);
    expect(b.max.x).toBeCloseTo(101.6, 9);
    expect(b.max.y).toBeCloseTo(50.8, 9);
    expect(flat.bends[0]!.p0.x).toBeCloseTo(50.8, 9);
    expect(Math.abs(flat.bends[0]!.p1.y - flat.bends[0]!.p0.y)).toBeCloseTo(50.8, 9);
    // the hole radius is 6.35 mm and its chord error is evaluated in mm (≥ 25 points)
    expect(flat.holes[0]!.length).toBeGreaterThanOrEqual(20);
    for (const p of flat.holes[0]!) expect(Math.hypot(p.x - 25.4, p.y - 25.4)).toBeCloseTo(6.35, 9);
  });

  it('trims a bend line that overshoots the outline and extends one that stops short (with warnings)', () => {
    const ents = rect(100, 50, 'OUTLINE') + line(30, -5, 30, 57, 'BEND') + line(70, 2, 70, 48, 'BEND');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    const [b1, b2] = res.flat!.bends;
    expect(b1!.p0).toEqual({ x: 30, y: 0 });
    expect(b1!.p1).toEqual({ x: 30, y: 50 });
    expect(b2!.p0).toEqual({ x: 70, y: 0 });
    expect(b2!.p1).toEqual({ x: 70, y: 50 });
    const keys = res.warnings.map(w => `${w.key}:${w.params?.bendId}:${w.params?.end}`);
    expect(keys).toEqual([
      'warnings.dxf.bendTrimmed:B1:0', 'warnings.dxf.bendTrimmed:B1:1',
      'warnings.dxf.bendExtended:B2:0', 'warnings.dxf.bendExtended:B2:1',
    ]);
    expect(res.warnings[0]!.params?.amount).toBe(5);
    expect(res.warnings[3]!.params?.amount).toBe(2);
  });

  it('snaps ends within 0.1 mm silently and keeps the tab-relief semantics for lines ending inside material', () => {
    // plate 50×30 with a tab x ∈ [12, 50] × [11, 19] between relief slots (x ∈ [8, 12]); bend line at x = 10
    const outline = lwpoly([[0, 0], [50, 0], [50, 10], [8, 10], [8, 11], [50, 11], [50, 19], [8, 19], [8, 20], [50, 20], [50, 30], [0, 30]], true, 'OUTLINE');
    // (a) drawn across the slots exactly: unchanged
    const a = importDxfFlat(dxfFile(outline + line(10, 10, 10, 20, 'BEND')), OPTS);
    expect(a.flat!.bends[0]!.p0).toEqual({ x: 10, y: 10 });
    expect(a.flat!.bends[0]!.p1).toEqual({ x: 10, y: 20 });
    expect(a.warnings).toEqual([]);
    // (b) slightly short (0.05): snapped silently to the slot edges
    const b = importDxfFlat(dxfFile(outline + line(10, 10.05, 10, 19.95, 'BEND')), OPTS);
    expect(b.flat!.bends[0]!.p0.y).toBeCloseTo(10, 9);
    expect(b.flat!.bends[0]!.p1.y).toBeCloseTo(20, 9);
    expect(b.warnings).toEqual([]);
    // (c) overshooting into the plate arms by 2 mm: moved to the nearest crossing (the slot edge), not the plate edge
    const c = importDxfFlat(dxfFile(outline + line(10, 8, 10, 22, 'BEND')), OPTS);
    expect(c.flat!.bends[0]!.p0.y).toBeCloseTo(10, 9);
    expect(c.flat!.bends[0]!.p1.y).toBeCloseTo(20, 9);
    expect(c.warnings.map(w => w.key)).toEqual(['warnings.dxf.bendTrimmed', 'warnings.dxf.bendTrimmed']);
  });

  it('parses bend notes on the bend layer and assigns them to the nearest bend line', () => {
    const ents = rect(100, 50, 'OUTLINE') + line(30, 0, 30, 50, 'IV_BEND') + line(70, 0, 70, 50, 'IV_BEND') +
      text(31, 25, 2.5, 'UP 135.00%%d R 1.00', 'IV_BEND') + text(71, 20, 2.5, 'DOWN 90.00%%d R 2.50', 'IV_BEND');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    const [b1, b2] = res.flat!.bends;
    expect(b1!.angle).toBe(135);
    expect(b1!.innerRadius).toBe(1);
    expect(b1!.direction).toBe('up');
    expect(b1!.sources).toEqual({ geometry: 'dxf', angle: 'dxf', radius: 'dxf', direction: 'dxf' });
    expect(b2!.angle).toBe(90);
    expect(b2!.innerRadius).toBe(2.5);
    expect(b2!.direction).toBe('down');                     // note overrides the (up) layer
    expect(res.warnings.map(w => w.key)).toEqual(['warnings.dxf.bendTextConflict']);
    expect(res.warnings[0]!.params).toEqual({ bendId: 'B2' });
  });

  it('parseBendNote understands the common formats', () => {
    expect(parseBendNote('UP 90.00° R 1.00')).toEqual({ direction: 'up', angle: 90, radius: 1 });
    expect(parseBendNote('DOWN 45 R2')).toEqual({ direction: 'down', angle: 45, radius: 2 });
    expect(parseBendNote('A=135 R=1.5 K=0.44')).toEqual({ angle: 135, radius: 1.5, kFactor: 0.44 });
    expect(parseBendNote('90,00 DEG')).toEqual({ angle: 90 });
    expect(parseBendNote('UP 180° R 0.5')).toEqual({ direction: 'up', angle: 180, radius: 0.5 });
    expect(parseBendNote('PART NO 1234')).toBeNull();
    expect(parseBendNote('BEND HERE')).toBeNull();
  });

  it('hem notes (180°) set hem = closed', () => {
    const ents = rect(100, 50, 'OUTLINE') + line(30, 0, 30, 50, 'BEND') + text(31, 25, 2.5, 'UP 180%%d R 0.5', 'BEND');
    const b = importDxfFlat(dxfFile(ents), OPTS).flat!.bends[0]!;
    expect(b.angle).toBe(180);
    expect(b.hem).toBe('closed');
  });

  it('warns for bend text that matches no line, ignores bent polylines on bend layers, dedupes duplicate bend lines', () => {
    const ents = rect(100, 50, 'OUTLINE') + line(30, 0, 30, 50, 'BEND') + line(30, 50, 30, 0, 'BEND') +
      lwpoly([[60, 0], [65, 25], [60, 50]], false, 'BEND') + text(90, 45, 2.5, 'UP 90%%d', 'BEND');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    expect(res.flat!.bends.length).toBe(1);
    expect(res.warnings.map(w => w.key).sort()).toEqual(['warnings.dxf.bendEntityIgnored', 'warnings.dxf.bendTextUnassigned']);
    // a straight (collinear) polyline on a bend layer is a bend line drawn as a polyline
    const poly = importDxfFlat(dxfFile(rect(100, 50, 'OUTLINE') + lwpoly([[60, 0], [60, 25], [60, 50]], false, 'BEND')), OPTS);
    expect(poly.flat!.bends.length).toBe(1);
    expect(poly.flat!.bends[0]!.p0).toEqual({ x: 60, y: 0 });
    expect(poly.flat!.bends[0]!.p1).toEqual({ x: 60, y: 50 });
    expect(poly.warnings).toEqual([]);
  });

  it('prefers the outline-hint layer over a larger frame on layer 0, drops loops outside the outline', () => {
    const ents = rect(200, 150, '0') + rect(100, 50, 'IV_OUTER_PROFILE') + circle(150, 100, 5, '0');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    const b = bounds(res.flat!.outline);
    expect(b.max.x).toBe(100);
    expect(res.flat!.holes.length).toBe(0);
    expect(res.warnings.map(w => w.key)).toEqual(['warnings.dxf.loopOutsideOutline', 'warnings.dxf.loopOutsideOutline', 'warnings.dxf.noBendLines']);
  });

  it('never picks a hole-hint loop as the outline, even when it is the only hinted layer', () => {
    // outline on layer 0, a big cutout on CUTOUTS (larger than nothing else hinted)
    const ents = rect(100, 50, '0') + circle(50, 25, 20, 'CUTOUTS') + line(20, 0, 20, 50, 'BEND');
    const flat = importDxfFlat(dxfFile(ents), OPTS).flat!;
    expect(bounds(flat.outline).max.x).toBe(100);
    expect(flat.holes.length).toBe(1);
    expect(flat.provenance?.outlineLayer).toBe('0');
  });

  it('without a hint layer the largest loop is the outline; a rounded outline of arcs works', () => {
    const ents = line(2, 0, 18, 0) + arc(18, 2, 2, 270, 360) + line(20, 2, 20, 8) + arc(18, 8, 2, 0, 90) +
      line(18, 10, 2, 10) + arc(2, 8, 2, 90, 180) + line(0, 8, 0, 2) + arc(2, 2, 2, 180, 270) + circle(10, 5, 1) + line(10, 0, 10, 10, 'BEND');
    const flat = importDxfFlat(dxfFile(ents), OPTS).flat!;
    expect(flat.holes.length).toBe(1);
    expect(flat.bends.length).toBe(1);
    expect(flat.outline.length).toBeGreaterThan(8);
    const b = bounds(flat.outline);
    expect(b.min.x).toBeCloseTo(0, 9); expect(b.max.x).toBeCloseTo(20, 9);
  });

  it('no bend lines ⇒ info warning; no closed loop ⇒ ImportError', () => {
    const res = importDxfFlat(dxfFile(rect(100, 50)), OPTS);
    expect(res.flat!.bends).toEqual([]);
    expect(res.warnings.map(w => `${w.key}/${w.severity}`)).toEqual(['warnings.dxf.noBendLines/info']);
    expect(() => importDxfFlat(dxfFile(line(0, 0, 10, 0) + line(10, 0, 10, 10)), OPTS)).toThrow(ImportError);
    try { importDxfFlat(dxfFile(line(0, 0, 10, 0)), OPTS); } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as ImportError).key).toBe('errors.import.dxfNoOutline');
      expect((e as ImportError).toMessage()).toEqual({ key: 'errors.import.dxfNoOutline', params: undefined, severity: 'error' });
    }
    expect(() => importDxfFlat(dxfFile(rect(100, 50)), { ...OPTS, thickness: 0 })).toThrow(ImportError);
  });

  it('lineOutlineCrossings counts vertices on the line once', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(lineOutlineCrossings({ x: 5, y: -1 }, { x: 0, y: 1 }, sq)).toEqual([1, 11]);
    expect(lineOutlineCrossings({ x: 0, y: -1 }, { x: 0, y: 1 }, sq)).toEqual([1, 11]);   // along the left edge: the two corners
    expect(lineOutlineCrossings({ x: -5, y: -5 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, sq).length).toBe(2); // diagonal through two corners
  });
});

describe('importToolProfileDxf', () => {
  const tools = join(process.cwd(), 'samples/tools');
  const cases: Array<[string, number, [number, number], [number, number]]> = [
    ['custom-finger.dxf', 6, [0, 60], [0, 35]],
    ['custom-gooseneck-punch.dxf', 11, [-12, 26], [0, 120]],
    ['custom-v16-die.dxf', 7, [-30, 30], [-60, 0]],
  ];
  for (const [file, count, xr, yr] of cases) {
    it(`${file}: closed CCW profile with ${count} points`, () => {
      const res = importToolProfileDxf(readFileSync(join(tools, file), 'utf8'));
      expect(res.points.length).toBe(count);
      expect(isCCW(res.points)).toBe(true);
      const b = bounds(res.points);
      expect(b.min.x).toBeCloseTo(xr[0], 6); expect(b.max.x).toBeCloseTo(xr[1], 6);
      expect(b.min.y).toBeCloseTo(yr[0], 6); expect(b.max.y).toBeCloseTo(yr[1], 6);
      expect(res.units).toBe('mm');
      expect(res.warnings).toEqual([]);
    });
  }

  it('finger profile keeps the stop face (0,0)–(0,20) and the notch', () => {
    const res = importToolProfileDxf(readFileSync(join(tools, 'custom-finger.dxf'), 'utf8'));
    const has = (x: number, y: number) => res.points.some(p => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
    for (const [x, y] of [[0, 0], [0, 20], [25, 20], [25, 35], [60, 35], [60, 0]]) expect(has(x!, y!)).toBe(true);
  });

  it('several loops ⇒ largest + warning; open lines ⇒ error; inches converted', () => {
    const two = importToolProfileDxf(dxfFile(lwpoly([[0, 0], [10, 0], [10, 10], [0, 10]], true) + circle(5, 5, 1)));
    expect(two.points.length).toBe(4);
    expect(two.warnings.map(w => w.key)).toEqual(['warnings.dxf.multipleProfiles']);
    expect(() => importToolProfileDxf(dxfFile(line(0, 0, 10, 0)))).toThrow(ImportError);
    const inch = importToolProfileDxf(dxfFile(lwpoly([[0, 0], [1, 0], [1, 1], [0, 1]], true), { insunits: 1 }));
    expect(inch.units).toBe('in');
    expect(bounds(inch.points).max.x).toBeCloseTo(25.4, 9);
    // chained open segments with a collinear mid vertex → simplified to the 4 corners
    const chained = importToolProfileDxf(dxfFile(line(0, 0, 5, 0) + line(5, 0, 10, 0) + line(10, 0, 10, 10) + line(10, 10, 0, 10) + line(0, 10, 0, 0)));
    expect(chained.points.length).toBe(4);
    expect(isCCW(chained.points)).toBe(true);
  });
});
