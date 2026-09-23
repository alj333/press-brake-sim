import { describe, it, expect, beforeAll } from 'vitest';
import { readSampleBytes } from '../../testing/fixtures';
import { importStep, importMesh } from '../index';
import { buildTopology, triNormal } from './topology';
import { groupFaces, buildPlanarFace, boundaryLoops, simplifyLoop3 } from './faces';
import type { PlanarFace } from './faces';
import { fitCylinder, fitCircle2d, cylinderAxisDirection, cylinderFitOk } from './cylinders';
import { detectThickness } from './thickness';
import { pairCylinders } from './bends';
import type { CylFace } from './bends';
import { recognizeSheet } from './recognize';
import type { TriangleMesh } from '../../types';
import { vec3 } from '../../geom';

let step: TriangleMesh, stl: TriangleMesh;

beforeAll(async () => {
  step = await importStep(readSampleBytes('L-bracket', 'step'), 'L-bracket');
  stl = await importMesh(readSampleBytes('L-bracket', 'stl'), 'stl', { name: 'L-bracket' });
});

/** A closed axis-aligned box mesh (12 triangles, outward normals). */
function boxMesh(sx: number, sy: number, sz: number, name = 'box'): TriangleMesh {
  const P = [
    [0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0],
    [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz],
  ];
  const quads = [
    [0, 3, 2, 1], // z = 0 (normal −z)
    [4, 5, 6, 7], // z = sz (+z)
    [0, 1, 5, 4], // y = 0 (−y)
    [2, 3, 7, 6], // y = sy (+y)
    [0, 4, 7, 3], // x = 0 (−x)
    [1, 2, 6, 5], // x = sx (+x)
  ];
  const idx: number[] = [];
  for (const [a, b, c, d] of quads) idx.push(a!, b!, c!, a!, c!, d!);
  return { positions: Float32Array.from(P.flat()), indices: Uint32Array.from(idx), units: 'mm', name };
}

describe('topology', () => {
  it('L-bracket STEP: welded, closed, face groups kept, unit normals', () => {
    const topo = buildTopology(step);
    expect(topo.triCount).toBe(404);
    expect(topo.vertexCount).toBe(202);
    expect(topo.openEdges).toBe(0);
    expect(topo.nonManifoldEdges).toBe(0);
    expect(topo.faceGroups!.length).toBe(11);
    for (let t = 0; t < topo.triCount; t++) {
      expect(Math.abs(vec3.length(triNormal(topo, t)) - 1)).toBeLessThan(1e-9);
      for (let k = 0; k < 3; k++) expect(topo.adj[t * 3 + k]).toBeGreaterThanOrEqual(0);
    }
  });

  it('an inward-oriented mesh is flipped to outward normals', () => {
    const box = boxMesh(10, 20, 2);
    const inverted: TriangleMesh = { ...box, indices: Uint32Array.from(box.indices) };
    for (let t = 0; t < inverted.indices.length; t += 3) {
      const b = inverted.indices[t + 1]!; inverted.indices[t + 1] = inverted.indices[t + 2]!; inverted.indices[t + 2] = b;
    }
    const a = buildTopology(box), b = buildTopology(inverted);
    // both have +z normals on the top face triangles
    let upA = 0, upB = 0;
    for (let t = 0; t < a.triCount; t++) { if (triNormal(a, t).z > 0.99) upA++; if (triNormal(b, t).z > 0.99) upB++; }
    expect(upA).toBe(2);
    expect(upB).toBe(2);
  });

  it('counts open edges of a non-closed mesh', () => {
    const box = boxMesh(10, 20, 2);
    const open: TriangleMesh = { ...box, indices: box.indices.slice(0, box.indices.length - 3) };
    const topo = buildTopology(open);
    expect(topo.openEdges).toBe(3);
  });
});

describe('face grouping and planar faces (L-bracket)', () => {
  it('STEP groups: 8 planar + 3 curved faces', () => {
    const topo = buildTopology(step);
    const g = groupFaces(topo);
    expect(g.faces.length).toBe(11);
    expect(g.faces.filter(f => f.kind === 'planar').length).toBe(8);
    expect(g.faces.filter(f => f.kind === 'curved').length).toBe(3);
    let n = 0;
    for (const f of g.faces) n += f.tris.length;
    expect(n).toBe(topo.triCount);
  });

  it('STL region growing + facet chains: the same 8 planar + 3 curved faces', () => {
    const topo = buildTopology(stl);
    const g = groupFaces(topo);
    expect(g.faces.length).toBe(11);
    expect(g.faces.filter(f => f.kind === 'planar').length).toBe(8);
    expect(g.faces.filter(f => f.kind === 'curved').length).toBe(3);
    for (let t = 0; t < topo.triCount; t++) expect(g.faceOf[t]).toBeGreaterThanOrEqual(0);
  });

  for (const kind of ['step', 'stl'] as const) {
    it(`${kind}: the base face has a 4-vertex outline, one hole and area 56·80 − hole`, () => {
      const topo = buildTopology(kind === 'step' ? step : stl);
      const g = groupFaces(topo);
      const planar = g.faces.map((f, id) => (f.kind === 'planar' ? buildPlanarFace(topo, id, f.tris, g.faceOf) : null)).filter((x): x is PlanarFace => x !== null);
      const largest = planar.slice().sort((a, b) => b.area - a.area)[0]!;
      expect(largest.outline3.length).toBe(4);
      expect(largest.holes3.length).toBe(1);
      expect(largest.holes3[0]!.length).toBeGreaterThan(30);
      expect(Math.abs(largest.area - (56 * 80 - Math.PI * 25))).toBeLessThan(1.5);
      expect(Math.abs(Math.abs(largest.normal.y) - 1)).toBeLessThan(1e-6);
      // outline CCW about the normal, hole CW
      const loopNormal = (loop: typeof largest.outline3) => {
        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
          nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
        }
        return { x: nx, y: ny, z: nz };
      };
      expect(vec3.dot(loopNormal(largest.outline3), largest.normal)).toBeGreaterThan(0);
      expect(vec3.dot(loopNormal(largest.holes3[0]!), largest.normal)).toBeLessThan(0);
      // every outline vertex lies on the plane
      for (const p of largest.outline3) expect(Math.abs(vec3.dot(p, largest.normal) - largest.offset)).toBeLessThan(1e-3);
    });
  }

  it('boundaryLoops of a box face is one 4-vertex loop after simplification', () => {
    const topo = buildTopology(boxMesh(10, 20, 2));
    const g = groupFaces(topo);
    expect(g.faces.length).toBe(6);
    for (const [id, f] of g.faces.entries()) {
      const loops = boundaryLoops(topo, f.tris, g.faceOf, id);
      expect(loops.length).toBe(1);
      expect(simplifyLoop3(loops[0]!.map(v => ({ x: topo.positions[v * 3]!, y: topo.positions[v * 3 + 1]!, z: topo.positions[v * 3 + 2]! }))).length).toBe(4);
    }
  });
});

describe('cylinders', () => {
  it('fitCircle2d recovers a circle exactly', () => {
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI; xs.push(3 + 7 * Math.cos(a)); ys.push(-2 + 7 * Math.sin(a)); }
    const c = fitCircle2d(xs, ys)!;
    expect(c.cx).toBeCloseTo(3, 9);
    expect(c.cy).toBeCloseTo(-2, 9);
    expect(c.r).toBeCloseTo(7, 9);
    expect(fitCircle2d([0, 1, 2], [0, 1, 2])).toBeNull();     // collinear
  });

  for (const kind of ['step', 'stl'] as const) {
    it(`${kind}: inner r=2 / outer r=4 bend cylinders (90°, 80 long) and the Ø10 hole (full)`, () => {
      const topo = buildTopology(kind === 'step' ? step : stl);
      const g = groupFaces(topo);
      const fits = g.faces.filter(f => f.kind === 'curved').map(f => fitCylinder(topo, f.tris)!);
      expect(fits.every(f => f && cylinderFitOk(f))).toBe(true);
      const byRadius = fits.slice().sort((a, b) => a.radius - b.radius);
      expect(byRadius.map(f => Math.round(f.radius * 1000) / 1000)).toEqual([2, 4, 5]);
      const [inner, outer, hole] = byRadius;
      expect(inner!.inner).toBe(true);
      expect(outer!.inner).toBe(false);
      expect(inner!.full).toBe(false);
      expect(hole!.full).toBe(true);
      expect(Math.abs(inner!.extentDeg - 90)).toBeLessThan(0.01);
      expect(Math.abs(outer!.extentDeg - 90)).toBeLessThan(0.01);
      expect(Math.abs(inner!.length - 80)).toBeLessThan(1e-3);
      expect(Math.abs(Math.abs(vec3.dot(inner!.axisDir, outer!.axisDir)) - 1)).toBeLessThan(1e-9);
      expect(Math.abs(Math.abs(inner!.axisDir.z) - 1)).toBeLessThan(1e-6);
      expect(vec3.length(vec3.cross(vec3.sub(outer!.centre, inner!.centre), inner!.axisDir))).toBeLessThan(1e-4);
      expect(inner!.maxError).toBeLessThan(1e-4);
      // hole axis ∥ the sheet normal (y)
      expect(Math.abs(Math.abs(hole!.axisDir.y) - 1)).toBeLessThan(1e-6);
      const axis = cylinderAxisDirection(topo, g.faces[fits.indexOf(inner!) >= 0 ? g.faces.findIndex(f => f.kind === 'curved') : 0]!.tris);
      expect(axis).not.toBeNull();
    });
  }
});

describe('thickness and pairing (L-bracket)', () => {
  for (const kind of ['step', 'stl'] as const) {
    it(`${kind}: thickness 2.0 from the sheet face pairs, one bend with two flanges per cylinder`, () => {
      const topo = buildTopology(kind === 'step' ? step : stl);
      const g = groupFaces(topo);
      const planar: PlanarFace[] = [];
      const cylinders: CylFace[] = [];
      for (const [id, f] of g.faces.entries()) {
        if (f.kind === 'planar') planar.push(buildPlanarFace(topo, id, f.tris, g.faceOf));
        else cylinders.push({ id, tris: f.tris, fit: fitCylinder(topo, f.tris)! });
      }
      const th = detectThickness(planar);
      expect(th.none).toBe(false);
      expect(Math.abs(th.thickness - 2)).toBeLessThan(1e-3);
      expect(th.candidates[0]!.distance).toBe(2);
      expect(th.sheetFaces.size).toBe(4);           // both faces of both flanges
      const largest = planar.slice().sort((a, b) => b.area - a.area)[0]!;
      expect(th.sheetFaces.has(largest.id)).toBe(true);
      const pairing = pairCylinders(topo, g, new Map(planar.map(p => [p.id, p])), cylinders, th.thickness);
      expect(pairing.bends.length).toBe(1);
      expect(pairing.unpaired).toEqual([]);
      expect(pairing.flangesMissing).toBe(0);
      const b = pairing.bends[0]!;
      expect(Math.abs(b.angle - 90)).toBeLessThan(0.01);
      expect(Math.abs(b.innerRadius - 2)).toBeLessThan(1e-3);
      expect(Math.abs(b.length - 80)).toBeLessThan(1e-3);
      expect(new Set([...b.innerFlanges, ...b.outerFlanges]).size).toBe(4);
      // the inner flanges are anti-parallel partners of the outer ones (same flange, t apart)
      const byId = new Map(planar.map(p => [p.id, p]));
      for (const i of b.innerFlanges) {
        const partner = b.outerFlanges.map(o => byId.get(o)!).find(o => vec3.dot(o.normal, byId.get(i)!.normal) < -0.99)!;
        expect(partner).toBeDefined();
        expect(Math.abs(Math.abs(vec3.dot(vec3.sub(partner.origin, byId.get(i)!.origin), byId.get(i)!.normal)) - 2)).toBeLessThan(1e-3);
      }
    });
  }

  it('thickness hint picks a candidate near the hint when several exist', () => {
    const topo = buildTopology(step);
    const g = groupFaces(topo);
    const planar = g.faces.map((f, id) => (f.kind === 'planar' ? buildPlanarFace(topo, id, f.tris, g.faceOf) : null)).filter((x): x is PlanarFace => x !== null);
    expect(detectThickness(planar, 2.1).thickness).toBeCloseTo(2, 3);
    expect(detectThickness(planar, 5).thickness).toBeCloseTo(2, 3);   // no candidate near 5: the mode wins
  });
});

describe('recognizeSheet on synthetic meshes', () => {
  it('a flat plate: thickness, no bends, rectangle outline, confidence 1', () => {
    const rec = recognizeSheet(boxMesh(120, 80, 2, 'plate'), { materialId: 'm', kFactor: 0.44 });
    expect(rec.thickness).toBeCloseTo(2, 6);
    expect(rec.bendCount).toBe(0);
    expect(rec.flat.bends).toEqual([]);
    expect(rec.flat.outline.length).toBe(4);
    const xs = rec.flat.outline.map(p => p.x), ys = rec.flat.outline.map(p => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(120, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(80, 6);
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
    expect(Math.min(...ys)).toBeCloseTo(0, 9);
    expect(rec.faces.length).toBe(1);
    expect(rec.confidence).toBe(1);
    expect(rec.issues.map(m => m.key)).toEqual(['warnings.recognize.noBends']);
    expect(rec.flat.id).toBe('plate');
    expect(rec.flat.provenance?.format).toBe('mesh');
  });

  it('a plate standing on edge is recognised the same way (thickness from the thin dimension)', () => {
    const rec = recognizeSheet(boxMesh(1.5, 90, 40), { materialId: 'm', kFactor: 0.44 });
    expect(rec.thickness).toBeCloseTo(1.5, 6);
    expect(rec.flat.outline.length).toBe(4);
    const xs = rec.flat.outline.map(p => p.x), ys = rec.flat.outline.map(p => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(90, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 6);
  });

  it('a non-sheet mesh (tetrahedron) reports thicknessUnknown and no bends', () => {
    const tet: TriangleMesh = {
      positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
      indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
      units: 'mm', name: 'tet',
    };
    const rec = recognizeSheet(tet, { materialId: 'm', kFactor: 0.44 });
    expect(rec.bendCount).toBe(0);
    expect(rec.issues.some(m => m.key === 'warnings.recognize.thicknessUnknown' && m.severity === 'error')).toBe(true);
    expect(rec.confidence).toBeLessThan(1);
    expect(rec.thickness).toBe(0);
    const withHint = recognizeSheet(tet, { materialId: 'm', kFactor: 0.44, thicknessHint: 1.2 });
    expect(withHint.thickness).toBe(1.2);
    expect(withHint.issues.some(m => m.key === 'warnings.recognize.thicknessUnknown' && m.severity === 'warning')).toBe(true);
  });

  it('an open mesh is reported (info) and still recognised', () => {
    const box = boxMesh(50, 30, 2);
    const open: TriangleMesh = { ...box, indices: box.indices.slice(3) };
    const rec = recognizeSheet(open, { materialId: 'm', kFactor: 0.44 });
    expect(rec.issues.some(m => m.key === 'warnings.recognize.meshNotClosed' && m.severity === 'info')).toBe(true);
    expect(rec.thickness).toBeCloseTo(2, 6);
    expect(rec.confidence).toBeLessThan(1);
  });

  it('an empty mesh yields an empty result with an error issue', () => {
    const empty: TriangleMesh = { positions: new Float32Array(0), indices: new Uint32Array(0), units: 'mm', name: 'empty' };
    const rec = recognizeSheet(empty, { materialId: 'm', kFactor: 0.44 });
    expect(rec.confidence).toBe(0);
    expect(rec.flat.outline).toEqual([]);
    expect(rec.issues[0]!.severity).toBe('error');
  });
});

/**
 * Synthetic L-bracket (base 60, leg 40 outside, t = 2, ri = 2, width W) tessellated like an STL
 * with the given facet step on the arc — a closed, outward-oriented mesh without face groups.
 */
function syntheticL(stepDeg: number, W = 80): TriangleMesh {
  const t = 2, ri = 2, e = ri + t;
  const base = 60 - e, leg = 40 - e;
  const n = Math.max(1, Math.round(90 / stepDeg));
  // centre-line profile (x, y) in the XY plane, sheet normal +y at the start, bend up (+y)
  const rm = ri + t / 2, cx = base, cy = rm;
  const pts: Array<[number, number]> = [[0, 0]];
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * (Math.PI / 2);
    pts.push([cx + rm * Math.cos(a), cy + rm * Math.sin(a)]);
  }
  pts.push([cx + rm, cy + leg]);
  // offset polylines: inner (+t/2 toward the centre side) and outer
  const outer: Array<[number, number]> = [], inner: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    let nx: number, ny: number;
    if (i === 0) { nx = 0; ny = 1; }
    else if (i === pts.length - 1) { nx = -1; ny = 0; }
    else { const d = Math.hypot(p[0] - cx, p[1] - cy); nx = (cx - p[0]) / d; ny = (cy - p[1]) / d; }   // toward the arc centre
    inner.push([p[0] + nx * t / 2, p[1] + ny * t / 2]);
    outer.push([p[0] - nx * t / 2, p[1] - ny * t / 2]);
  }
  const V: number[] = [];
  const add = (x: number, y: number, z: number) => { V.push(x, y, z); return V.length / 3 - 1; };
  const m = pts.length;
  const I0 = inner.map(p => add(p[0], p[1], 0)), I1 = inner.map(p => add(p[0], p[1], W));
  const O0 = outer.map(p => add(p[0], p[1], 0)), O1 = outer.map(p => add(p[0], p[1], W));
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d);
  for (let i = 0; i < m - 1; i++) {
    quad(O0[i]!, O0[i + 1]!, O1[i + 1]!, O1[i]!);   // outer surface (normal −y at the base: outward)
    quad(I0[i + 1]!, I0[i]!, I1[i]!, I1[i + 1]!);   // inner surface
    quad(I0[i]!, I0[i + 1]!, O0[i + 1]!, O0[i]!);   // cap z = 0
    quad(O1[i]!, O1[i + 1]!, I1[i + 1]!, I1[i]!);   // cap z = W
  }
  quad(O0[0]!, O1[0]!, I1[0]!, I0[0]!);              // end face at x = 0
  quad(I0[m - 1]!, I1[m - 1]!, O1[m - 1]!, O0[m - 1]!);   // end face at the leg tip
  return { positions: Float32Array.from(V), indices: Uint32Array.from(idx), units: 'mm', name: `L-${stepDeg}` };
}

describe('synthetic STL-like L-bracket at several facet steps', () => {
  for (const stepDeg of [0.5, 1, 1.5, 3, 5, 10, 18]) {
    it(`${stepDeg}° facets: one 90° bend, ri 2, flat 96.52 × 80`, () => {
      const mesh = syntheticL(stepDeg);
      const topo = buildTopology(mesh);
      expect(topo.openEdges).toBe(0);
      const rec = recognizeSheet(mesh, { materialId: 'm', kFactor: 0.44 });
      expect(rec.thickness).toBeCloseTo(2, 4);
      expect(rec.bendCount).toBe(1);
      expect(rec.confidence).toBe(1);
      expect(Math.abs(rec.flat.bends[0]!.angle - 90)).toBeLessThan(0.01);
      expect(Math.abs(rec.flat.bends[0]!.innerRadius - 2)).toBeLessThan(0.01);
      expect(rec.flat.bends[0]!.direction).toBe('up');
      const xs = rec.flat.outline.map(p => p.x), ys = rec.flat.outline.map(p => p.y);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      expect(Math.abs(w - 96.523893)).toBeLessThan(0.01);
      expect(Math.abs(h - 80)).toBeLessThan(0.01);
      expect(rec.flat.outline.length).toBe(4);
    });
  }

  it('facets finer than the planar tolerance (0.25°) degrade gracefully: the first facets join the flanges', () => {
    const rec = recognizeSheet(syntheticL(0.25), { materialId: 'm', kFactor: 0.44 });
    expect(rec.bendCount).toBe(1);
    expect(Math.abs(rec.flat.bends[0]!.angle - 90)).toBeLessThan(3);
    expect(Math.abs(rec.flat.bends[0]!.innerRadius - 2)).toBeLessThan(0.05);
  });

  it('a wider part (W = 300) and a narrow one (W = 12) unfold the same', () => {
    for (const W of [300, 12]) {
      const rec = recognizeSheet(syntheticL(5, W), { materialId: 'm', kFactor: 0.44 });
      expect(rec.bendCount).toBe(1);
      const len = Math.hypot(rec.flat.bends[0]!.p1.x - rec.flat.bends[0]!.p0.x, rec.flat.bends[0]!.p1.y - rec.flat.bends[0]!.p0.y);
      expect(Math.abs(len - W)).toBeLessThan(0.01);
    }
  });
});
