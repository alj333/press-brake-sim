/**
 * Reviewer tests for import-files: edge cases the builder's suite did not cover — mirrored OCS
 * entities, doubled entities, vertex identifiers, code pages, unit scaling of bend notes,
 * non-90° / down / hem notes, bend lines that do not span the part, flipped tool profiles,
 * mesh unit overrides and the relaxed importFile options.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSampleBytes, readSampleText } from '../testing/fixtures';
import { bounds, isCCW, signedArea } from '../geom';
import {
  importDxfFlat, importToolProfileDxf, importFile, importMesh, parseDxf, chainLoops, decodeDxfText, weldMesh,
  positionsBounds, ImportError,
} from './index';
import { dxfFile, line, lwpoly, circle, text, arc } from './dxf-common.test';
import { binaryStl, cubeSoup } from './mesh.test';
import { writeGlb } from './gltf';

const OPTS = { thickness: 2, materialId: 'std:mild-steel', name: 'review' };
const rect = (w: number, h: number, layer = 'OUTLINE') => lwpoly([[0, 0], [w, 0], [w, h], [0, h]], true, layer);
const keys = (ws: Array<{ key: string }>) => ws.map(w => w.key);

/** Entity text with an extrusion direction appended (group codes 210/220/230). */
const withExtrusion = (entity: string, ez: number) => `${entity}210\n0\n220\n0\n230\n${ez}\n`;

describe('DXF — doubled entities and vertex identifiers', () => {
  it('a double-drawn outline segment does not break the chain, whichever order the copies come in', () => {
    const orders = [
      line(0, 0, 100, 0) + line(0, 0, 100, 0) + line(100, 0, 100, 50) + line(100, 50, 0, 50) + line(0, 50, 0, 0),
      line(0, 0, 100, 0) + line(100, 0, 100, 50) + line(0, 0, 100, 0) + line(100, 50, 0, 50) + line(0, 50, 0, 0),
      line(0, 0, 100, 0) + line(100, 0, 100, 50) + line(100, 50, 0, 50) + line(100, 0, 100, 50) + line(0, 50, 0, 0),
      line(0, 0, 100, 0) + line(100, 0, 100, 50) + line(100, 50, 0, 50) + line(0, 50, 0, 0) + line(100, 0, 0, 0),   // reversed copy last
    ];
    for (const ents of orders) {
      const res = importDxfFlat(dxfFile(ents + line(50, 0, 50, 50, 'BEND')), OPTS);
      expect(res.flat!.outline.length, ents).toBe(4);
      expect(Math.abs(signedArea(res.flat!.outline))).toBeCloseTo(5000, 6);
      expect(keys(res.warnings)).toEqual(['warnings.dxf.duplicateEntities']);
      expect(res.warnings[0]!.params).toEqual({ count: 1 });
      expect(res.warnings[0]!.severity).toBe('info');
    }
  });

  it('two different arcs between the same end points (a lens) are NOT treated as duplicates', () => {
    const doc = parseDxf(dxfFile(arc(5, 0, 5, 0, 180) + arc(5, 0, 5, 180, 360)));   // full circle from two half arcs
    const { loops, warnings } = chainLoops(doc.paths);
    expect(loops).toHaveLength(1);
    expect(warnings).toEqual([]);
    const lens = parseDxf(dxfFile(arc(5, 3, 5, 216.87, 323.13) + arc(5, -3, 5, 36.87, 143.13)));   // two arcs, same chord
    expect(chainLoops(lens.paths).loops).toHaveLength(1);
  });

  it('a double-drawn hole circle gives one hole', () => {
    const res = importDxfFlat(dxfFile(rect(100, 50) + circle(30, 25, 5) + circle(30, 25, 5) + line(60, 0, 60, 50, 'BEND')), OPTS);
    expect(res.flat!.holes).toHaveLength(1);
    expect(keys(res.warnings)).toEqual(['warnings.dxf.duplicateEntities']);
  });

  it('at a T-junction the chain prefers a segment of its own layer class (stray layer-0 line touching the outline)', () => {
    // outline as 4 LINEs on IV_OUTER_PROFILE, plus a layer-0 construction line from a corner into the part,
    // listed BEFORE the true continuation so that a distance-only tie-break would pick it
    const outline = line(0, 0, 100, 0, 'IV_OUTER_PROFILE') + line(100, 0, 100, 60, '0') + line(100, 0, 100, 50, 'IV_OUTER_PROFILE') +
      line(100, 50, 0, 50, 'IV_OUTER_PROFILE') + line(0, 50, 0, 0, 'IV_OUTER_PROFILE');
    const res = importDxfFlat(dxfFile(outline + line(50, 0, 50, 50, 'IV_BEND')), OPTS);
    expect(res.flat!.outline).toHaveLength(4);
    expect(Math.abs(signedArea(res.flat!.outline))).toBeCloseTo(5000, 6);
    expect(keys(res.warnings)).toEqual(['warnings.dxf.openChain']);
  });

  it('LWPOLYLINE vertex identifiers (code 91, AutoCAD 2010+) do not truncate the polyline', () => {
    const poly = `0\nLWPOLYLINE\n8\nOUTLINE\n90\n4\n70\n1\n10\n0\n20\n0\n91\n1\n10\n100\n20\n0\n91\n2\n10\n100\n20\n50\n91\n3\n10\n0\n20\n50\n91\n4\n`;
    const res = importDxfFlat(dxfFile(poly + line(40, 0, 40, 50, 'BEND')), OPTS);
    expect(res.flat!.outline).toHaveLength(4);
    expect(bounds(res.flat!.outline).max).toEqual({ x: 100, y: 50 });
    expect(res.warnings).toEqual([]);
  });
});

describe('DXF — mirrored OCS (extrusion 0,0,−1)', () => {
  it('CIRCLE: the centre is mirrored in x (dxf-parser drops the circle extrusion)', () => {
    const ents = rect(100, 50) + withExtrusion(circle(-30, 25, 5), -1) + line(60, 0, 60, 50, 'BEND');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    expect(res.flat!.holes).toHaveLength(1);
    const b = bounds(res.flat!.holes[0]!);
    expect(b.min.x).toBeCloseTo(25, 6); expect(b.max.x).toBeCloseTo(35, 1);
    expect(b.min.y).toBeCloseTo(20, 1); expect(b.max.y).toBeCloseTo(30, 1);
    expect(isCCW(res.flat!.holes[0]!)).toBe(false);
    expect(res.warnings).toEqual([]);
    // a +Z extrusion written explicitly changes nothing (inscribed polygon: min x within the chord error)
    const plain = importDxfFlat(dxfFile(rect(100, 50) + withExtrusion(circle(30, 25, 5), 1) + line(60, 0, 60, 50, 'BEND')), OPTS);
    expect(Math.abs(bounds(plain.flat!.holes[0]!).min.x - 25)).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it('CIRCLE inside a block: ordinal lookup is per block traversal (block inserted twice)', () => {
    const blocks = `0\nBLOCK\n8\n0\n2\nH\n70\n0\n10\n0\n20\n0\n30\n0\n3\nH\n${withExtrusion(circle(-5, 0, 2), -1)}0\nENDBLK\n`;
    const ins = (x: number) => `0\nINSERT\n8\n0\n2\nH\n10\n${x}\n20\n25\n30\n0\n`;
    const res = importDxfFlat(dxfFile(rect(100, 50) + ins(20) + ins(60) + line(40, 0, 40, 50, 'BEND'), { blocks }), OPTS);
    expect(res.flat!.holes).toHaveLength(2);
    const cx = res.flat!.holes.map(h => (bounds(h).min.x + bounds(h).max.x) / 2).sort((a, b) => a - b);
    expect(cx[0]).toBeCloseTo(25, 1);
    expect(cx[1]).toBeCloseTo(65, 1);
  });

  it('ARC and INSERT with a −Z extrusion are mirrored (insert point is in OCS)', () => {
    const a = parseDxf(dxfFile(withExtrusion(arc(-30, 25, 5, 0, 180), -1))).paths[0]!;
    const ab = bounds(a.points);
    expect(ab.min.x).toBeCloseTo(25, 6); expect(ab.max.x).toBeCloseTo(35, 6);
    expect(ab.min.y).toBeCloseTo(25, 6); expect(ab.max.y).toBeCloseTo(30, 6);
    const blocks = `0\nBLOCK\n8\n0\n2\nP\n70\n0\n10\n0\n20\n0\n30\n0\n3\nP\n${rect(60, 40)}${line(20, 0, 20, 40, 'BEND')}0\nENDBLK\n`;
    const ins = `0\nINSERT\n8\n0\n2\nP\n10\n-100\n20\n0\n30\n0\n210\n0\n220\n0\n230\n-1\n`;
    const res = importDxfFlat(dxfFile(ins, { blocks }), OPTS);
    const b = bounds(res.flat!.outline);
    expect(b.min.x).toBeCloseTo(40, 9); expect(b.max.x).toBeCloseTo(100, 9);
    expect(isCCW(res.flat!.outline)).toBe(true);
    expect(res.flat!.bends[0]!.p0.x).toBeCloseTo(80, 9);   // block x = 20 → OCS −100 + 20 = −80 → WCS +80
    expect(res.warnings).toEqual([]);
  });

  it('ELLIPSE: a −Z extrusion flips the minor axis (the arc goes to the other side of the major axis)', () => {
    const ell = (ez: number) => `0\nELLIPSE\n8\n0\n10\n50\n20\n25\n30\n0\n11\n10\n21\n0\n31\n0\n210\n0\n220\n0\n230\n${ez}\n40\n0.5\n41\n0\n42\n${Math.PI}\n`;
    const up = parseDxf(dxfFile(ell(1))).paths[0]!;
    const down = parseDxf(dxfFile(ell(-1))).paths[0]!;
    expect(up.closed).toBe(false);
    for (const p of up.points) expect(p.y).toBeGreaterThanOrEqual(25 - 1e-9);
    for (const p of down.points) expect(p.y).toBeLessThanOrEqual(25 + 1e-9);
    expect(bounds(up.points).max.y).toBeCloseTo(30, 6);
    expect(bounds(down.points).min.y).toBeCloseTo(20, 6);
    expect(up.points[0]).toEqual({ x: 60, y: 25 });
  });

  it('TEXT with a −Z extrusion is positioned in WCS and still finds its bend line', () => {
    const ents = rect(100, 50) + line(50, 0, 50, 50, 'BEND') + withExtrusion(text(-51, 25, 2.5, 'UP 120%%d R 1', 'BEND'), -1);
    const res = importDxfFlat(dxfFile(ents), OPTS);
    expect(res.flat!.bends[0]!.angle).toBe(120);
    expect(res.warnings).toEqual([]);
  });

  it('an oblique extrusion is reported once per entity type and the entity is used as drawn', () => {
    const ents = rect(100, 50) + `${circle(30, 25, 5)}210\n0.6\n220\n0\n230\n0.8\n` + `${circle(70, 25, 5)}210\n0.6\n220\n0\n230\n0.8\n` + line(50, 0, 50, 50, 'BEND');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    expect(res.flat!.holes).toHaveLength(2);
    expect(keys(res.warnings)).toEqual(['warnings.dxf.nonPlanar']);
    expect(res.warnings[0]!.params).toEqual({ type: 'CIRCLE' });
  });
});

describe('DXF — units and encodings', () => {
  it('bend-note radii are converted from the drawing units (inch note R 0.06 → 1.524 mm)', () => {
    const ents = lwpoly([[0, 0], [4, 0], [4, 2], [0, 2]], true, 'OUTLINE') + line(2, 0, 2, 2, 'BEND') + text(2.1, 1, 0.1, 'UP 90%%d R 0.06', 'BEND');
    const res = importDxfFlat(dxfFile(ents, { insunits: 1 }), OPTS);
    const b = res.flat!.bends[0]!;
    expect(b.innerRadius).toBeCloseTo(1.524, 9);
    expect(b.sources.radius).toBe('dxf');
    expect(b.angle).toBe(90);
    expect(res.warnings).toEqual([]);
    // guessed inches (unitless, small): note distance threshold works in mm after scaling
    const guessed = importDxfFlat(dxfFile(ents, { insunits: 0 }), OPTS);
    expect(guessed.flat!.sourceUnits).toBe('in');
    expect(guessed.flat!.bends[0]!.innerRadius).toBeCloseTo(1.524, 9);
    expect(keys(guessed.warnings)).toEqual(['warnings.dxf.unitsGuessed']);
  });

  it('$INSUNITS = 5 (cm): geometry ×10, provenance keeps the unit name, sourceUnits is mm', () => {
    const ents = lwpoly([[0, 0], [10, 0], [10, 5], [0, 5]], true, 'OUTLINE') + line(5, 0, 5, 5, 'BEND') + circle(2, 2.5, 0.5);
    const res = importDxfFlat(dxfFile(ents, { insunits: 5 }), OPTS);
    expect(bounds(res.flat!.outline).max).toEqual({ x: 100, y: 50 });
    expect(res.flat!.provenance?.units).toBe('cm');
    expect(res.flat!.sourceUnits).toBe('mm');
    expect(res.flat!.holes[0]!.length).toBeGreaterThanOrEqual(16);   // Ø10 mm at 0.05 mm chord error
    expect(res.warnings).toEqual([]);
  });

  it('units override: a unitless 24" plate (too big for the inch guess) imports as inches when told so', () => {
    const ents = lwpoly([[0, 0], [24, 0], [24, 12], [0, 12]], true, 'OUTLINE') + line(12, 0, 12, 12, 'BEND') + text(12.2, 6, 0.125, 'UP 90%%d R 0.125', 'BEND');
    const auto = importDxfFlat(dxfFile(ents, { insunits: 0 }), OPTS);
    expect(bounds(auto.flat!.outline).max).toEqual({ x: 24, y: 12 });          // 'auto': 24 units > 12 ⇒ mm
    const inch = importDxfFlat(dxfFile(ents, { insunits: 0 }), { ...OPTS, units: 'in' });
    expect(bounds(inch.flat!.outline).max.x).toBeCloseTo(609.6, 9);
    expect(inch.flat!.sourceUnits).toBe('in');
    expect(inch.flat!.bends[0]!.innerRadius).toBeCloseTo(3.175, 9);
    expect(inch.warnings).toEqual([]);                                         // no guess ⇒ no unitsGuessed
    // the override also wins over a wrong $INSUNITS, and applies to tool profiles / importFile
    const forcedMm = importDxfFlat(dxfFile(ents, { insunits: 1 }), { ...OPTS, units: 'mm' });
    expect(bounds(forcedMm.flat!.outline).max).toEqual({ x: 24, y: 12 });
    expect(importToolProfileDxf(dxfFile(lwpoly([[0, 0], [1, 0], [1, 1], [0, 1]], true)), { units: 'in' }).points[2]).toEqual({ x: 25.4, y: 25.4 });
    return importFile({ name: 'p.dxf', bytes: new TextEncoder().encode(dxfFile(ents, { insunits: 0 })) }, { thickness: 2, units: 'in' })
      .then(r => expect(bounds(r.flat!.outline).max.x).toBeCloseTo(609.6, 9));
  });

  it('unknown $INSUNITS (3 = miles) is taken as mm with a warning', () => {
    const res = importDxfFlat(dxfFile(rect(100, 50) + line(50, 0, 50, 50, 'BEND'), { insunits: 3 }), OPTS);
    expect(bounds(res.flat!.outline).max).toEqual({ x: 100, y: 50 });
    expect(keys(res.warnings)).toEqual(['warnings.dxf.unitsUnknown']);
  });

  it('decodeDxfText: windows-1252 bend notes ("°" = 0xB0) and \\U+00B0 escapes both parse', () => {
    const src = dxfFile(rect(100, 50) + line(50, 0, 50, 50, 'BEND') + text(51, 25, 2.5, 'UP 135.00° R 1.50', 'BEND'));
    const ansi = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) ansi[i] = src.charCodeAt(i) & 0xff;
    const decoded = decodeDxfText(ansi);
    expect(decoded).toContain('135.00°');
    const res = importDxfFlat(decoded, OPTS);
    expect(res.flat!.bends[0]!.angle).toBe(135);
    expect(res.flat!.bends[0]!.innerRadius).toBe(1.5);
    // valid UTF-8 (with a BOM) still decodes as UTF-8
    const utf8 = new TextEncoder().encode('﻿' + src);
    expect(importDxfFlat(decodeDxfText(utf8), OPTS).flat!.bends[0]!.angle).toBe(135);
    const esc = importDxfFlat(dxfFile(rect(100, 50) + line(50, 0, 50, 50, 'BEND') + text(51, 25, 2.5, 'DOWN 45.00\\U+00B0 R 3', 'BEND')), OPTS);
    expect(esc.flat!.bends[0]!.angle).toBe(45);
    expect(esc.flat!.bends[0]!.direction).toBe('down');
    expect(esc.flat!.bends[0]!.innerRadius).toBe(3);
    expect(keys(esc.warnings)).toEqual(['warnings.dxf.bendTextConflict']);
  });

  it('justified TEXT is located by its second alignment point', () => {
    const t = `0\nTEXT\n8\nBEND\n10\n0\n20\n0\n30\n0\n11\n51\n21\n25\n31\n0\n40\n2.5\n1\nUP 100%%d\n72\n1\n73\n2\n`;
    const res = importDxfFlat(dxfFile(rect(100, 50) + line(50, 0, 50, 50, 'BEND') + t), OPTS);
    expect(res.flat!.bends[0]!.angle).toBe(100);
    expect(res.warnings).toEqual([]);
  });
});

describe('DXF — bends: directions, angles, spans', () => {
  it('down layers (IV_BEND_DOWN, BEND_DOWN, BendLinesDown) → direction down; the truth-equivalent reflection is the caller\'s business', () => {
    const ents = rect(120, 50) + line(30, 0, 30, 50, 'IV_BEND_DOWN') + line(60, 0, 60, 50, 'BEND_DOWN') + line(90, 0, 90, 50, 'BendLinesDown');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    expect(res.flat!.bends.map(b => b.direction)).toEqual(['down', 'down', 'down']);
    expect(res.flat!.bends.map(b => b.sources.direction)).toEqual(['dxf', 'dxf', 'dxf']);
    expect(res.flat!.provenance?.bendLayers).toBe('IV_BEND_DOWN,BEND_DOWN,BendLinesDown');
  });

  it('non-90° notes: acute (135 from flat), obtuse (45), hem (180 → closed), k-factor; out-of-range angles ignored', () => {
    const ents = rect(200, 50) + line(40, 0, 40, 50, 'BEND') + line(80, 0, 80, 50, 'BEND') + line(120, 0, 120, 50, 'BEND') + line(160, 0, 160, 50, 'BEND') +
      text(41, 25, 2.5, 'UP 135%%d R 0.8', 'BEND') + text(81, 25, 2.5, 'UP 45%%d R 4 K=0.5', 'BEND') +
      text(121, 25, 2.5, 'UP 180%%d R 0.5', 'BEND') + text(161, 25, 2.5, 'UP 190%%d', 'BEND');
    const res = importDxfFlat(dxfFile(ents), OPTS);
    const [b1, b2, b3, b4] = res.flat!.bends;
    expect(b1!.angle).toBe(135); expect(b1!.innerRadius).toBe(0.8); expect(b1!.hem).toBeUndefined();
    expect(b2!.angle).toBe(45); expect(b2!.kFactor).toBe(0.5); expect(b2!.innerRadius).toBe(4);
    expect(b3!.angle).toBe(180); expect(b3!.hem).toBe('closed');
    expect(b4!.angle).toBe(90); expect(b4!.sources.angle).toBe('default');   // 190 is not a bend angle
    expect(res.warnings).toEqual([]);
  });

  it('a bend line drawn entirely inside the material is extended to both edges (with warnings)', () => {
    const res = importDxfFlat(dxfFile(rect(100, 50) + line(30, 10, 30, 40, 'BEND')), OPTS);
    const b = res.flat!.bends[0]!;
    expect(b.p0).toEqual({ x: 30, y: 0 });
    expect(b.p1).toEqual({ x: 30, y: 50 });
    expect(res.warnings.map(w => `${w.key}:${w.params?.end}:${w.params?.amount}`)).toEqual(['warnings.dxf.bendExtended:0:10', 'warnings.dxf.bendExtended:1:10']);
  });

  it('an oblique bend line across an L-shaped outline lands exactly on the boundary at both ends', () => {
    const outline = lwpoly([[0, 0], [100, 0], [100, 30], [50, 30], [50, 80], [0, 80]], true, 'OUTLINE');
    const res = importDxfFlat(dxfFile(outline + line(10, -5, 60, 45, 'BEND')), OPTS);   // 45° line, overshoots both ends
    const b = res.flat!.bends[0]!;
    expect(b.p0.x).toBeCloseTo(15, 9); expect(b.p0.y).toBeCloseTo(0, 9);
    expect(b.p1.x).toBeCloseTo(50, 9); expect(b.p1.y).toBeCloseTo(35, 9);
    expect(keys(res.warnings)).toEqual(['warnings.dxf.bendTrimmed', 'warnings.dxf.bendTrimmed']);
  });

  it('a bend line crossing a hole and one lying along an outline edge are left as drawn', () => {
    const res = importDxfFlat(dxfFile(rect(100, 50) + circle(50, 25, 10) + line(50, 0, 50, 50, 'BEND') + line(0, 0, 100, 0, 'BEND')), OPTS);
    expect(res.flat!.bends[0]!.p0).toEqual({ x: 50, y: 0 });
    expect(res.flat!.bends[0]!.p1).toEqual({ x: 50, y: 50 });
    expect(res.flat!.bends[1]!.p0).toEqual({ x: 0, y: 0 });
    expect(res.flat!.bends[1]!.p1).toEqual({ x: 100, y: 0 });
    expect(res.warnings).toEqual([]);
  });

  it('a bend line completely outside the part is kept as drawn (core-geometry reports it) — no crash', () => {
    const res = importDxfFlat(dxfFile(rect(100, 50) + line(150, 0, 150, 50, 'BEND')), OPTS);
    expect(res.flat!.bends).toHaveLength(1);
    expect(res.flat!.bends[0]!.p0).toEqual({ x: 150, y: 0 });
  });

  it('a zero-length bend line is skipped without producing NaN geometry', () => {
    const res = importDxfFlat(dxfFile(rect(100, 50) + line(30, 20, 30, 20, 'BEND') + line(60, 0, 60, 50, 'BEND')), OPTS);
    expect(res.flat!.bends).toHaveLength(1);
    expect(res.flat!.bends[0]!.id).toBe('B1');
    expect(res.flat!.bends[0]!.p0.x).toBe(60);
  });

  it('a part with a hole and a down bend builds a 2-flange PartModel', async () => {
    const { buildPartModel } = await import('../part');
    const res = importDxfFlat(dxfFile(rect(100, 50) + circle(20, 25, 6) + line(60, 0, 60, 50, 'BEND_DOWN')), { ...OPTS, defaultRadius: 2 });
    const part = buildPartModel(res.flat!);
    expect(part.warnings).toEqual([]);
    expect(part.flanges).toHaveLength(2);
    expect(part.links[0]!.bendId).toBe('B1');
    expect(res.flat!.bends[0]!.direction).toBe('down');
  });

  it('empty ENTITIES section → dxfNoOutline; only ignored layers → dxfNoOutline', () => {
    expect(() => importDxfFlat(dxfFile(''), OPTS)).toThrow(ImportError);
    try { importDxfFlat(dxfFile(''), OPTS); } catch (e) { expect((e as ImportError).key).toBe('errors.import.dxfNoOutline'); }
    expect(() => importDxfFlat(dxfFile(rect(100, 50, 'DIMENSIONS')), OPTS)).toThrow(ImportError);
  });
});

describe('DXF — tool profiles', () => {
  const tools = join(process.cwd(), 'samples/tools');

  it('a profile drawn clockwise is returned CCW; a construction centre line only adds a warning', () => {
    const cw = lwpoly([[0, 0], [0, 35], [60, 35], [60, 0]], true) + line(30, -5, 30, 40);   // CW box + centre line
    const res = importToolProfileDxf(dxfFile(cw));
    expect(res.points).toHaveLength(4);
    expect(isCCW(res.points)).toBe(true);
    expect(keys(res.warnings)).toEqual(['warnings.dxf.openChain']);
  });

  it('a profile with a bulge fillet flattens at 0.05 mm chord error and keeps the extents', () => {
    const res = importToolProfileDxf(dxfFile(lwpoly([[-30, -60], [30, -60], [30, 0], [8, 0], [0, -8, 0.4142], [-8, 0], [-30, 0]], true)));
    expect(isCCW(res.points)).toBe(true);
    const b = bounds(res.points);
    expect(b.min.x).toBe(-30); expect(b.max.x).toBe(30); expect(b.min.y).toBe(-60); expect(b.max.y).toBe(0);
    expect(res.points.length).toBeGreaterThan(7);
  });

  it('a profile drawn as a block and inserted mirrored (xScale −1) comes out mirrored and CCW', () => {
    const gooseneck: Array<[number, number]> = [[0, 0], [6, 6.2], [6, 25], [26, 55], [26, 120], [-12, 120], [-12, 92], [4, 70], [6, 45], [-7, 28], [-6, 6.2]];
    const blocks = `0\nBLOCK\n8\n0\n2\nGN\n70\n0\n10\n0\n20\n0\n30\n0\n3\nGN\n${lwpoly(gooseneck, true)}0\nENDBLK\n`;
    const ins = `0\nINSERT\n8\n0\n2\nGN\n10\n0\n20\n0\n30\n0\n41\n-1\n`;
    const res = importToolProfileDxf(dxfFile(ins, { blocks }));
    expect(res.points).toHaveLength(11);
    expect(isCCW(res.points)).toBe(true);
    expect(bounds(res.points)).toEqual({ min: { x: -26, y: 0 }, max: { x: 12, y: 120 } });
    expect(res.warnings).toEqual([]);
    // the shipped sample die profile is unchanged by the pre-scan (no extrusions, no code 91)
    const die = importToolProfileDxf(readFileSync(join(tools, 'custom-v16-die.dxf'), 'utf8'));
    expect(bounds(die.points)).toEqual({ min: { x: -30, y: -60 }, max: { x: 30, y: 0 } });
  });
});

describe('meshes — units, welding edge cases', () => {
  it('explicit cm / m unit overrides scale without a warning; a NaN vertex only drops its triangle', async () => {
    const cm = await importMesh(binaryStl(cubeSoup(2).positions), 'stl', { units: 'cm' });
    const b = positionsBounds(cm.positions);
    expect(b.max[0] - b.min[0]).toBeCloseTo(20, 4);
    expect(cm.warnings).toEqual([]);
    const m = await importMesh(binaryStl(cubeSoup(0.02).positions), 'stl', { units: 'm' });
    expect(positionsBounds(m.positions).max[0]).toBeCloseTo(20, 3);
    const w = weldMesh([0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0, 1, 1, 0, 0, 1, 1], [0, 1, 2, 3, 4, 5], 1e-3, [{ first: 0, last: 1 }]);
    expect(w.degenerate).toBe(1);
    expect(w.indices.length).toBe(3);
    expect(w.faceGroups).toEqual([{ first: 0, last: 0 }]);
  });

  it('binary STL with trailing bytes after the declared triangles is accepted', async () => {
    const bin = binaryStl(cubeSoup(10).positions);
    const padded = new Uint8Array(bin.length + 7);
    padded.set(bin, 0);
    const m = await importMesh(padded, 'stl');
    expect(m.indices.length / 3).toBe(12);
    expect(m.positions.length / 3).toBe(8);
  });

  it('OBJ: a face referencing a vertex that is not defined yet → objInvalid with the line number', () => {
    const bad = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nf 1 2 3\nv 0 1 0\n');
    return expect(importMesh(bad, 'obj')).rejects.toMatchObject({ key: 'errors.import.objInvalid', params: { line: 3 } });
  });

  /** GLB with one POSITION accessor (mm, no indices) referenced by `nodes` (each with its own translation). */
  function unindexedGlb(positions: number[], translations: number[][], extensionsRequired?: string[]): Uint8Array {
    const pos = new Float32Array(positions);
    const b = positionsBounds(pos);
    const json: Record<string, unknown> = {
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: translations.map((_, i) => i) }],
      nodes: translations.map(t => ({ mesh: 0, translation: t })),
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: b.min, max: b.max }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
      buffers: [{ byteLength: pos.byteLength }],
    };
    if (extensionsRequired) { json['extensionsRequired'] = extensionsRequired; json['extensionsUsed'] = extensionsRequired; }
    return new Uint8Array(writeGlb(JSON.stringify(json), new Uint8Array(pos.buffer)));
  }

  it('GLB: unindexed primitives and one mesh shared by two nodes are baked per node', async () => {
    const tri = [0, 0, 0, 100, 0, 0, 0, 100, 0];
    const m = await importMesh(unindexedGlb(tri, [[0, 0, 0], [0, 0, 50]]), 'glb', { units: 'mm' });
    expect(m.indices.length / 3).toBe(2);
    expect(m.positions.length / 3).toBe(6);
    const b = positionsBounds(m.positions);
    expect(b.min[2]).toBe(0); expect(b.max[2]).toBe(50);
    expect(m.warnings).toEqual([]);
  });

  it('GLB requiring Draco compression is rejected with gltfUnsupported', async () => {
    const glb = unindexedGlb([0, 0, 0, 100, 0, 0, 0, 100, 0], [[0, 0, 0]], ['KHR_draco_mesh_compression']);
    await expect(importMesh(glb, 'glb')).rejects.toMatchObject({ key: 'errors.import.gltfUnsupported' });
  });
});

describe('importFile — options', () => {
  it('meshes need neither thickness nor materialId; a DXF without thickness fails with badThickness', async () => {
    const res = await importFile({ name: 'L-bracket.step', bytes: readSampleBytes('L-bracket', 'step') }, {});
    expect(res.mesh!.faceGroups!.length).toBe(11);
    const stl = await importFile({ name: 'L-bracket.stl', bytes: readSampleBytes('L-bracket', 'stl') }, { meshUnits: 'mm' });
    expect(stl.mesh!.faceGroups).toBeUndefined();
    const dxf = new TextEncoder().encode(readSampleText('L-bracket', 'dxf'));
    await expect(importFile({ name: 'L-bracket-flat.dxf', bytes: dxf }, {})).rejects.toMatchObject({ key: 'errors.import.badThickness' });
    const ok = await importFile({ name: 'L-bracket-flat.dxf', bytes: dxf }, { thickness: 2 });
    expect(ok.flat!.materialId).toBe('');
    expect(ok.flat!.bends).toHaveLength(1);
  });
});
