import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE_NAMES, readSampleText } from '../testing/fixtures';
import { parseDxf, chainLoops, classifyLayer, cleanText, douglasPeucker } from './dxf-common';
import { ImportError } from './errors';
import { signedArea } from '../geom';

const DXF_HEADER = (insunits: number | null) => `0\nSECTION\n2\nHEADER\n${insunits === null ? '' : `9\n$INSUNITS\n70\n${insunits}\n`}0\nENDSEC\n`;
const DXF_TAIL = '0\nEOF\n';

/** Minimal DXF writer for tests: entities as raw group-code text. */
export function dxfFile(entities: string, opts: { insunits?: number | null; blocks?: string } = {}): string {
  const blocks = opts.blocks ? `0\nSECTION\n2\nBLOCKS\n${opts.blocks}0\nENDSEC\n` : '';
  return `${DXF_HEADER(opts.insunits === undefined ? 4 : opts.insunits)}${blocks}0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n${DXF_TAIL}`;
}
export const line = (x0: number, y0: number, x1: number, y1: number, layer = '0') =>
  `0\nLINE\n8\n${layer}\n10\n${x0}\n20\n${y0}\n30\n0\n11\n${x1}\n21\n${y1}\n31\n0\n`;
export const arc = (cx: number, cy: number, r: number, a0: number, a1: number, layer = '0') =>
  `0\nARC\n8\n${layer}\n10\n${cx}\n20\n${cy}\n30\n0\n40\n${r}\n50\n${a0}\n51\n${a1}\n`;
export const circle = (cx: number, cy: number, r: number, layer = '0') =>
  `0\nCIRCLE\n8\n${layer}\n10\n${cx}\n20\n${cy}\n30\n0\n40\n${r}\n`;
export const lwpoly = (pts: Array<[number, number, number?]>, closed: boolean, layer = '0') =>
  `0\nLWPOLYLINE\n8\n${layer}\n90\n${pts.length}\n70\n${closed ? 1 : 0}\n` +
  pts.map(([x, y, b]) => `10\n${x}\n20\n${y}\n${b ? `42\n${b}\n` : ''}`).join('');
export const text = (x: number, y: number, h: number, s: string, layer = '0') =>
  `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n0\n40\n${h}\n1\n${s}\n`;

describe('classifyLayer', () => {
  it('maps Inventor / generic layer names (case-insensitive prefix)', () => {
    expect(classifyLayer('IV_BEND')).toBe('bend-up');
    expect(classifyLayer('iv_bend_down')).toBe('bend-down');
    expect(classifyLayer('BEND_DOWN')).toBe('bend-down');
    expect(classifyLayer('BendDown')).toBe('bend-down');
    expect(classifyLayer('BEND LINES')).toBe('bend-up');
    expect(classifyLayer('BEND_UP')).toBe('bend-up');
    expect(classifyLayer('Bendline')).toBe('bend-up');
    expect(classifyLayer('IV_ARC_CENTERS')).toBe('ignore');
    expect(classifyLayer('IV_ALTREP_FRONT')).toBe('ignore');
    expect(classifyLayer('Dimensions')).toBe('ignore');
    expect(classifyLayer('IV_OUTER_PROFILE')).toBe('outline-hint');
    expect(classifyLayer('Cut')).toBe('outline-hint');
    expect(classifyLayer('IV_INTERIOR_PROFILES')).toBe('hole-hint');
    expect(classifyLayer('CUTOUTS')).toBe('hole-hint');
    expect(classifyLayer('Holes')).toBe('hole-hint');
    expect(classifyLayer('BendLinesDown')).toBe('bend-down');
    expect(classifyLayer('BEND LINES DOWN')).toBe('bend-down');
    expect(classifyLayer('0')).toBe('geometry');
    expect(classifyLayer(undefined)).toBe('geometry');
  });
});

describe('parseDxf', () => {
  it('parses every sample flat DXF (mm, IV_ layers)', () => {
    for (const name of SAMPLE_NAMES) {
      const doc = parseDxf(readSampleText(name, 'dxf'));
      expect(doc.units).toBe('mm');
      expect(doc.scale).toBe(1);
      expect(doc.insunits).toBe(4);
      expect(doc.paths.some(p => p.cls === 'outline-hint' && p.closed)).toBe(true);
      expect(doc.paths.filter(p => p.cls === 'bend-up' || p.cls === 'bend-down').length).toBeGreaterThan(0);
      expect(doc.warnings).toEqual([]);
    }
  });

  it('parses the tool profile DXFs (layer 0, closed polyline)', () => {
    const doc = parseDxf(readFileSync(join(process.cwd(), 'samples/tools/custom-finger.dxf'), 'utf8'));
    expect(doc.paths).toHaveLength(1);
    expect(doc.paths[0]!.closed).toBe(true);
    expect(doc.paths[0]!.points).toHaveLength(6);
  });

  it('scales inches to mm and reports the units', () => {
    const doc = parseDxf(dxfFile(lwpoly([[0, 0], [4, 0], [4, 3], [0, 3]], true), { insunits: 1 }));
    expect(doc.units).toBe('in');
    expect(doc.scale).toBe(25.4);
    expect(doc.paths[0]!.points[1]).toEqual({ x: 101.6, y: 0 });
  });

  it('guesses inches for a small unitless drawing and keeps mm for a large one', () => {
    const small = parseDxf(dxfFile(lwpoly([[0, 0], [4, 0], [4, 3], [0, 3]], true), { insunits: 0 }));
    expect(small.units).toBe('in');
    expect(small.unitsGuessed).toBe(true);
    expect(small.warnings.map(w => w.key)).toContain('warnings.dxf.unitsGuessed');
    const large = parseDxf(dxfFile(lwpoly([[0, 0], [40, 0], [40, 30], [0, 30]], true), { insunits: null }));
    expect(large.units).toBe('mm');
    expect(large.unitsGuessed).toBe(false);
  });

  it('flattens arcs at 0.05 mm chord error and circles as closed loops', () => {
    const doc = parseDxf(dxfFile(arc(0, 0, 10, 0, 90) + circle(50, 50, 5)));
    const a = doc.paths.find(p => p.type === 'ARC')!;
    expect(a.closed).toBe(false);
    expect(a.points[0]!.x).toBeCloseTo(10, 9);
    expect(a.points[a.points.length - 1]!.y).toBeCloseTo(10, 9);
    for (const p of a.points) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 9);
    // chord error of every segment ≤ 0.05
    for (let i = 1; i < a.points.length; i++) {
      const m = { x: (a.points[i]!.x + a.points[i - 1]!.x) / 2, y: (a.points[i]!.y + a.points[i - 1]!.y) / 2 };
      expect(10 - Math.hypot(m.x, m.y)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
    const c = doc.paths.find(p => p.type === 'CIRCLE')!;
    expect(c.closed).toBe(true);
    expect(c.points.length).toBeGreaterThanOrEqual(8);
    // inscribed polygon: slightly less than the circle area (23 segments at r = 5 → −1.2 %)
    const ca = Math.abs(signedArea(c.points));
    expect(ca).toBeLessThan(Math.PI * 25);
    expect(ca).toBeGreaterThan(Math.PI * 25 * 0.98);
    for (const q of c.points) expect(Math.hypot(q.x - 50, q.y - 50)).toBeCloseTo(5, 9);
  });

  it('expands LWPOLYLINE bulges (positive bulge = CCW arc, below a left-to-right chord)', () => {
    const doc = parseDxf(dxfFile(lwpoly([[0, 0, 1], [10, 0]], false)));
    const p = doc.paths[0]!;
    expect(p.points.length).toBeGreaterThan(4);
    expect(p.points[0]).toEqual({ x: 0, y: 0 });
    expect(p.points[p.points.length - 1]).toEqual({ x: 10, y: 0 });
    const bottom = p.points.reduce((m, q) => Math.min(m, q.y), Infinity);
    expect(bottom).toBeCloseTo(-5, 2);
    for (const q of p.points) expect(Math.hypot(q.x - 5, q.y)).toBeCloseTo(5, 6);
    // closed polyline with a bulge on the closing segment: a "D" shape
    const d = parseDxf(dxfFile(lwpoly([[0, 0], [0, 10, -1]], true))).paths[0]!;
    expect(d.closed).toBe(true);
    expect(Math.abs(signedArea(d.points))).toBeGreaterThan(Math.PI * 25 * 0.49);
    // a circle drawn as a closed 2-vertex polyline with bulge 1 on both segments (common CAD output)
    const c = parseDxf(dxfFile(lwpoly([[0, 0, 1], [10, 0, 1]], true))).paths[0]!;
    expect(c.closed).toBe(true);
    expect(c.points.length).toBeGreaterThanOrEqual(8);
    for (const q of c.points) expect(Math.hypot(q.x - 5, q.y)).toBeCloseTo(5, 6);
    expect(Math.abs(signedArea(c.points))).toBeGreaterThan(Math.PI * 25 * 0.98);
  });

  it('accepts CRLF line endings', () => {
    const doc = parseDxf(dxfFile(lwpoly([[0, 0], [40, 0], [40, 30], [0, 30]], true)).replace(/\n/g, '\r\n'));
    expect(doc.paths).toHaveLength(1);
    expect(doc.paths[0]!.points).toHaveLength(4);
  });

  it('applies INSERT transforms (position, rotation, scale) and inherits the layer for layer-0 block entities', () => {
    const blocks = `0\nBLOCK\n8\n0\n2\nSQ\n70\n0\n10\n0\n20\n0\n30\n0\n3\nSQ\n${lwpoly([[0, 0], [1, 0], [1, 1], [0, 1]], true)}0\nENDBLK\n`;
    const ins = `0\nINSERT\n8\nOUTLINE\n2\nSQ\n10\n100\n20\n50\n30\n0\n41\n20\n42\n10\n50\n90\n`;
    const doc = parseDxf(dxfFile(ins, { blocks }));
    expect(doc.paths).toHaveLength(1);
    const p = doc.paths[0]!;
    expect(p.layer).toBe('OUTLINE');
    expect(p.cls).toBe('outline-hint');
    expect(p.closed).toBe(true);
    // (1,0) scaled → (20,0), rotated 90° → (0,20), translated → (100,70)
    expect(p.points[1]!.x).toBeCloseTo(100, 9);
    expect(p.points[1]!.y).toBeCloseTo(70, 9);
    // (1,1) → (20,10) → (-10,20) → (90,70)
    expect(p.points[2]!.x).toBeCloseTo(90, 9);
    expect(p.points[2]!.y).toBeCloseTo(70, 9);
  });

  it('warns about a missing block', () => {
    const doc = parseDxf(dxfFile(`0\nINSERT\n8\n0\n2\nNOPE\n10\n0\n20\n0\n30\n0\n`));
    expect(doc.warnings.map(w => w.key)).toContain('warnings.dxf.blockMissing');
  });

  it('evaluates SPLINE control points/knots with De Boor', () => {
    // Quadratic B-spline (clamped) through 3 control points = a parabola from (0,0) to (10,0) via (5,10)
    const spline = `0\nSPLINE\n8\n0\n70\n8\n71\n2\n72\n6\n73\n3\n40\n0\n40\n0\n40\n0\n40\n1\n40\n1\n40\n1\n` +
      `10\n0\n20\n0\n30\n0\n10\n5\n20\n10\n30\n0\n10\n10\n20\n0\n30\n0\n`;
    const doc = parseDxf(dxfFile(spline));
    const p = doc.paths[0]!;
    expect(p.type).toBe('SPLINE');
    expect(p.points[0]).toEqual({ x: 0, y: 0 });
    const last = p.points[p.points.length - 1]!;
    expect(last.x).toBeCloseTo(10, 9);
    expect(last.y).toBeCloseTo(0, 9);
    // apex of the quadratic Bezier at t = 0.5 → (5, 5)
    const apex = p.points.reduce((m, q) => (q.y > m.y ? q : m), p.points[0]!);
    expect(apex.y).toBeCloseTo(5, 2);
    expect(apex.x).toBeCloseTo(5, 1);
    // every sample lies on the parabola y = 2·x·(10−x)/10 → y = x(10 − x)/5
    for (const q of p.points) expect(q.y).toBeCloseTo(q.x * (10 - q.x) / 5, 6);
  });

  it('collects TEXT / MTEXT with formatting stripped', () => {
    const doc = parseDxf(dxfFile(text(5, 6, 2.5, 'UP 90.00%%d R 1.00', 'IV_BEND') + `0\nMTEXT\n8\n0\n10\n1\n20\n2\n30\n0\n40\n3\n1\n{\\fArial|b0;DOWN 45\\P R2}\n`));
    expect(doc.texts).toHaveLength(2);
    expect(doc.texts[0]!.text).toBe('UP 90.00° R 1.00');
    expect(doc.texts[0]!.cls).toBe('bend-up');
    expect(doc.texts[0]!.height).toBe(2.5);
    expect(doc.texts[1]!.text).toBe('DOWN 45 R2');
  });

  it('throws a typed ImportError on garbage', () => {
    expect(() => parseDxf('')).toThrow(ImportError);
    expect(() => parseDxf('hello world')).toThrow(ImportError);
    try { parseDxf('hello'); } catch (e) { expect((e as ImportError).key).toBe('errors.import.dxfParse'); }
  });
});

describe('chainLoops', () => {
  it('chains LINE + ARC segments into one closed loop', () => {
    // rounded rectangle 20×10 with R2 corners drawn as 4 lines + 4 arcs, in random order
    const ents = [
      line(2, 0, 18, 0), arc(18, 2, 2, 270, 360), line(20, 2, 20, 8), arc(18, 8, 2, 0, 90),
      line(18, 10, 2, 10), arc(2, 8, 2, 90, 180), line(0, 8, 0, 2), arc(2, 2, 2, 180, 270),
    ];
    const shuffled = [ents[5], ents[0], ents[7], ents[2], ents[4], ents[1], ents[6], ents[3]].join('');
    const doc = parseDxf(dxfFile(shuffled));
    const { loops, warnings } = chainLoops(doc.paths);
    expect(warnings).toEqual([]);
    expect(loops).toHaveLength(1);
    const expected = 20 * 10 - (4 - Math.PI) * 4;   // area minus the four corner cut-offs
    expect(loops[0]!.area).toBeLessThan(expected);             // inscribed arcs
    expect(loops[0]!.area).toBeGreaterThan(expected - 0.5);
    expect(loops[0]!.points.length).toBeGreaterThan(8);
  });

  it('closes a small gap with a warning and drops an open chain', () => {
    const doc = parseDxf(dxfFile(line(0, 0, 10, 0) + line(10, 0, 10, 10) + line(10, 10, 0, 10) + line(0, 10, 0, 0.3)));
    const { loops, warnings } = chainLoops(doc.paths);
    expect(loops).toHaveLength(1);
    expect(warnings.map(w => w.key)).toEqual(['warnings.dxf.loopClosed']);
    const open = chainLoops(parseDxf(dxfFile(line(0, 0, 10, 0) + line(10, 0, 10, 10) + line(10, 10, 0, 10))).paths);
    expect(open.loops).toHaveLength(0);
    expect(open.warnings.map(w => w.key)).toEqual(['warnings.dxf.openChain']);
  });

  it('handles reversed segments and duplicate joints', () => {
    const doc = parseDxf(dxfFile(line(10, 0, 0, 0) + line(10, 10, 10, 0) + line(0, 10, 10, 10) + line(0, 0, 0, 10)));
    const { loops } = chainLoops(doc.paths);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.points).toHaveLength(4);
    expect(loops[0]!.area).toBeCloseTo(100, 9);
  });
});

describe('helpers', () => {
  it('cleanText strips codes', () => {
    expect(cleanText('\\A1;UP 90.00%%d R 1.00')).toBe('UP 90.00° R 1.00');
    expect(cleanText('{\\fArial|b0|i0|c0|p34;DOWN 90%%D}')).toBe('DOWN 90°');
  });
  it('douglasPeucker keeps the corners of a polyline', () => {
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: i, y: 0 });
    for (let i = 1; i <= 10; i++) pts.push({ x: 10, y: i });
    expect(douglasPeucker(pts, 0.01)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });
});
