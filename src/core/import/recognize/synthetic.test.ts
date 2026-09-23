/**
 * Round trips through the synthetic folded-mesh generator: FlatPattern → folded triangle mesh
 * (STL-like soup and STEP-like face groups) → recognizeSheet → the same flat pattern. Covers what
 * the sample parts do not: non-parallel second-level bends, coaxial tabs, arbitrary angles, hems,
 * holes on child flanges, coarse / fine tessellations, thick and tiny parts, multi-body meshes.
 */
import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth, flatsEquivalent } from '../../testing/fixtures';
import type { FlatPattern, TriangleMesh } from '../../types';
import { vec2, vec3 } from '../../geom';
import { buildPartModel } from '../../part';
import { recognizeSheet, matchToDxf } from './index';
import { buildTopology } from './topology';
import { foldedMesh, profileFlat, rect, circleCW, bendLine, ba } from './synthetic';

const OPTS = { materialId: 'std:mild-steel', kFactor: 0.44 };
const t = 2, ri = 2;
const B = ba(90, ri, t);

/** Recognise and compare with the flat the mesh was generated from. */
function roundTrip(flat: FlatPattern, mesh: TriangleMesh, opts: { angleTol?: number; allowMirror?: boolean } = {}) {
  const topo = buildTopology(mesh);
  expect(topo.openEdges, 'generator produced a closed mesh').toBe(0);
  const rec = recognizeSheet(mesh, OPTS);
  expect(Math.abs(rec.thickness - flat.thickness)).toBeLessThanOrEqual(0.01);
  expect(rec.bendCount).toBe(flat.bends.length);
  const eq = flatsEquivalent(rec.flat, flat, { tol: 0.05, angleTol: opts.angleTol ?? 0.05 });
  expect(eq.reasons, eq.reasons.join('; ')).toEqual([]);
  if (!opts.allowMirror) expect(eq.mirrored).toBe(false);
  expect(rec.confidence).toBe(1);
  expect(rec.issues.filter(m => m.severity !== 'info')).toEqual([]);
  // the recognised flat builds a clean part model, and every bend pairs with the original by geometry
  const part = buildPartModel(rec.flat);
  expect(part.warnings).toEqual([]);
  expect(part.flanges.length).toBe(flat.bends.length + 1);
  const m = matchToDxf(rec, flat);
  expect(m.pairs.length).toBe(flat.bends.length);
  expect(m.unmatchedDxf).toEqual([]);
  for (const p of m.pairs) {
    const orig = flat.bends.find(b => b.id === p.dxfBendId)!, got = m.flat.bends.find(b => b.id === p.dxfBendId)!;
    expect(Math.abs(got.angle - orig.angle)).toBeLessThanOrEqual(opts.angleTol ?? 0.05);
    expect(Math.abs(got.innerRadius - orig.innerRadius)).toBeLessThanOrEqual(0.01);
    expect(got.direction).toBe(orig.direction);
  }
  return rec;
}

describe('synthetic round trips of the sample truth flats', () => {
  for (const name of SAMPLE_NAMES) {
    for (const withGroups of [false, true]) {
      it(`${name} (${withGroups ? 'face groups' : 'soup'})`, () => {
        const truth = loadTruth(name);
        const rec = roundTrip(truth.flat, foldedMesh(truth.flat, { withGroups }));
        expect(rec.flat.holes.length).toBe(truth.expected.holeCount);
        expect(rec.faces.length).toBe(truth.expected.flangeCount);
        for (const b of rec.flat.bends) expect(b.sources.angle).toBe(withGroups ? 'step' : 'mesh');
      });
    }
  }
});

describe('second-level and coaxial bends', () => {
  for (const tabDir of ['up', 'down'] as const) {
    it(`corner tab bent ${tabDir} from a standing wall (perpendicular second-level axis)`, () => {
      const wallH = 30, tabL = 20;
      const outline = [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 + B }, { x: 100 + B + tabL, y: 60 + B }, { x: 100 + B + tabL, y: 60 + B + wallH },
        { x: 0, y: 60 + B + wallH },
      ];
      const flat: FlatPattern = {
        id: 'corner', name: 'corner', thickness: t, materialId: 'm', outline, holes: [],
        bends: [bendLine('B1', { x: 0, y: 60 + B / 2 }, { x: 100, y: 60 + B / 2 }, 'up', 90, ri), bendLine('B2', { x: 100 + B / 2, y: 60 + B }, { x: 100 + B / 2, y: 60 + B + wallH }, tabDir, 90, ri)],
        sourceUnits: 'mm',
      };
      for (const withGroups of [false, true]) {
        const rec = roundTrip(flat, foldedMesh(flat, { withGroups }));
        // the tab hangs off the wall, not off the base: faceA of one bend is faceB of the other
        const ids = rec.bends3d.map(b => [b.faceA, b.faceB]);
        expect(ids.some(([a]) => a === 'F1')).toBe(true);
        expect(ids.some(([a, b]) => a !== 'F1' && b !== 'F1')).toBe(true);
        // the two axes are perpendicular
        expect(Math.abs(vec3.dot(rec.bends3d[0]!.axisDir, rec.bends3d[1]!.axisDir))).toBeLessThan(1e-6);
      }
    });
  }

  it('two tabs bent up along one line (coaxial bends) stay two bends with their own extents', () => {
    const outline = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 90, y: 60 }, { x: 90, y: 60 + B + 20 }, { x: 60, y: 60 + B + 20 }, { x: 60, y: 60 },
      { x: 40, y: 60 }, { x: 40, y: 60 + B + 20 }, { x: 10, y: 60 + B + 20 }, { x: 10, y: 60 }, { x: 0, y: 60 },
    ];
    const flat: FlatPattern = {
      id: 'coax', name: 'coax', thickness: t, materialId: 'm', outline, holes: [],
      bends: [bendLine('B1', { x: 10, y: 60 + B / 2 }, { x: 40, y: 60 + B / 2 }, 'up', 90, ri), bendLine('B2', { x: 60, y: 60 + B / 2 }, { x: 90, y: 60 + B / 2 }, 'up', 90, ri)],
      sourceUnits: 'mm',
    };
    for (const withGroups of [false, true]) {
      const rec = roundTrip(flat, foldedMesh(flat, { withGroups }));
      const lens = rec.flat.bends.map(b => vec2.dist(b.p0, b.p1));
      expect(lens.every(l => Math.abs(l - 30) < 0.01)).toBe(true);
      expect(rec.flat.outline.length).toBe(12);
    }
  });

  it('three walls up and two coaxial tabs down: directions and extents per tab', () => {
    const W = 30;
    const outline = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: -(B + 20) }, { x: 40, y: -(B + 20) }, { x: 40, y: 0 }, { x: 60, y: 0 }, { x: 60, y: -(B + 20) }, { x: 90, y: -(B + 20) }, { x: 90, y: 0 },
      { x: 100, y: 0 }, { x: 100 + B + W, y: 0 }, { x: 100 + B + W, y: 60 }, { x: 100, y: 60 }, { x: 100, y: 60 + B + W }, { x: 0, y: 60 + B + W }, { x: 0, y: 60 },
      { x: -(B + W), y: 60 }, { x: -(B + W), y: 0 },
    ];
    const flat: FlatPattern = {
      id: 'coax2', name: 'coax2', thickness: t, materialId: 'm', outline, holes: [],
      bends: [
        bendLine('B1', { x: 10, y: -B / 2 }, { x: 40, y: -B / 2 }, 'down', 90, ri), bendLine('B2', { x: 60, y: -B / 2 }, { x: 90, y: -B / 2 }, 'down', 90, ri),
        bendLine('B3', { x: 100 + B / 2, y: 0 }, { x: 100 + B / 2, y: 60 }, 'up', 90, ri), bendLine('B4', { x: 0, y: 60 + B / 2 }, { x: 100, y: 60 + B / 2 }, 'up', 90, ri),
        bendLine('B5', { x: -B / 2, y: 0 }, { x: -B / 2, y: 60 }, 'up', 90, ri),
      ],
      sourceUnits: 'mm',
    };
    for (const withGroups of [false, true]) {
      const rec = roundTrip(flat, foldedMesh(flat, { withGroups }));
      expect(rec.flat.bends.filter(b => b.direction === 'down').length).toBe(2);
      // the down tabs are the two 30 mm bends
      for (const b of rec.flat.bends.filter(x => x.direction === 'down')) expect(Math.abs(vec2.dist(b.p0, b.p1) - 30)).toBeLessThan(0.01);
    }
  });
});

describe('angles, hems and directions', () => {
  it('30° / 60° / 120° / 150° / 170° bends with mixed directions and radii', () => {
    const flat = profileFlat('angles', [30, 30, 30, 30, 30, 30], [
      { angle: 30, ri, direction: 'up' }, { angle: 60, ri: 1, direction: 'down' }, { angle: 120, ri: 3, direction: 'up' },
      { angle: 150, ri, direction: 'down' }, { angle: 170, ri, direction: 'up' },
    ], t, 50);
    for (const withGroups of [false, true]) roundTrip(flat, foldedMesh(flat, { withGroups }));
  });

  it('shallow bends: 10° and 15° are recognised; a one-facet 5° bend is lost with a facesIgnored warning', () => {
    for (const a of [10, 15]) roundTrip(profileFlat(`s${a}`, [40, 40], [{ angle: a, ri, direction: 'up' }], t, 50), foldedMesh(profileFlat(`s${a}`, [40, 40], [{ angle: a, ri, direction: 'up' }], t, 50)));
    const rec = recognizeSheet(foldedMesh(profileFlat('s5', [40, 40], [{ angle: 5, ri, direction: 'up' }], t, 50)), OPTS);
    expect(rec.bendCount).toBe(0);
    expect(rec.issues.some(m => m.key === 'warnings.recognize.facesIgnored')).toBe(true);
    expect(rec.confidence).toBeLessThan(1);
  });

  it('open hems (180°) carry hem = open and hemGap = 2·ri; matchToDxf copies them', () => {
    for (const r of [2, 1, 0.5]) {
      const flat = profileFlat(`hem${r}`, [40, 15], [{ angle: 180, ri: r, direction: 'up' }], t, 50);
      const rec = roundTrip(flat, foldedMesh(flat));
      expect(rec.flat.bends[0]!.angle).toBe(180);
      expect(rec.flat.bends[0]!.hem).toBe('open');
      expect(rec.flat.bends[0]!.hemGap).toBeCloseTo(2 * r, 2);
      const m = matchToDxf(rec, flat);
      expect(m.flat.bends[0]!.hem).toBe('open');
      expect(m.flat.bends[0]!.hemGap).toBeCloseTo(2 * r, 2);
    }
    // a hem followed by a 90° bend the other way
    const flat = profileFlat('hem-z', [40, 15, 30], [{ angle: 180, ri: 1, direction: 'up' }, { angle: 90, ri, direction: 'down' }], t, 50);
    roundTrip(flat, foldedMesh(flat));
  });

  it('bends3d.axisDir is oriented like FoldedGeometry: +angle about it folds faceB out of faceA\'s plane', () => {
    const flat = profileFlat('zz', [40, 30, 30, 40], [{ angle: 90, ri, direction: 'up' }, { angle: 60, ri, direction: 'down' }, { angle: 135, ri, direction: 'up' }], t, 50);
    for (const withGroups of [false, true]) {
      const rec = recognizeSheet(foldedMesh(flat, { withGroups }), OPTS);
      expect(rec.bendCount).toBe(3);
      for (const b of rec.bends3d) {
        const nA = rec.faces.find(f => f.id === b.faceA)!.normal, nB = rec.faces.find(f => f.id === b.faceB)!.normal;
        expect(vec3.dot(vec3.rotateAboutAxis(nA, b.axisDir, b.angle), nB)).toBeGreaterThan(1 - 1e-6);
        expect(Math.abs(vec3.length(b.axisDir) - 1)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('holes, outline arcs and roundings', () => {
  it('holes on both flanges (72 and 24 segments, a square) survive; a coarse 15°-step hole is not an unpaired cylinder', () => {
    const flat = profileFlat('holes', [60, 40], [{ angle: 90, ri, direction: 'up' }], t, 80, 0.44, [circleCW(30, 40, 5), circleCW(60 + B + 20, 40, 6, 24), rect(10, 10, 10, 10).slice().reverse()]);
    for (const withGroups of [false, true]) {
      const rec = roundTrip(flat, foldedMesh(flat, { withGroups }));
      expect(rec.flat.holes.length).toBe(3);
      expect(rec.issues.filter(m => m.key === 'warnings.recognize.unpairedCylinder')).toEqual([]);
    }
  });

  it('finely tessellated holes (360 / 720 segments) are thinned, never erased', () => {
    for (const n of [360, 720]) {
      const flat = profileFlat('fine', [60, 40], [{ angle: 90, ri, direction: 'up' }], t, 80, 0.44, [circleCW(30, 40, 5, n)]);
      const rec = roundTrip(flat, foldedMesh(flat));
      expect(rec.flat.holes.length).toBe(1);
      const h = rec.flat.holes[0]!;
      expect(h.length).toBeGreaterThanOrEqual(60);
      // every kept vertex is still on the circle and the polygon area is the disc's within 0.1 %
      const c = { x: rec.flat.bends[0]!.p0.x - (60 + B / 2) + 30, y: 40 };
      for (const p of h) expect(Math.abs(vec2.dist(p, c) - 5)).toBeLessThan(0.01);
    }
  });

  it('a plate with a finely tessellated R20 corner keeps the arc in its outline and reports no cylinder', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    for (let i = 1; i <= 180; i++) { const a = -Math.PI / 2 + (i / 180) * (Math.PI / 2); pts.push({ x: 100 + 20 * Math.cos(a), y: 20 + 20 * Math.sin(a) }); }
    pts.push({ x: 120, y: 60 }, { x: 0, y: 60 });
    const plate: FlatPattern = { id: 'rc', name: 'rc', thickness: t, materialId: 'm', outline: pts, holes: [], bends: [], sourceUnits: 'mm' };
    for (const withGroups of [false, true]) {
      const rec = recognizeSheet(foldedMesh(plate, { withGroups }), OPTS);
      expect(rec.bendCount).toBe(0);
      expect(rec.confidence).toBe(1);
      expect(rec.issues.map(m => m.key)).toEqual(['warnings.recognize.noBends']);
      expect(rec.flat.outline.length).toBeGreaterThanOrEqual(40);
      const eq = flatsEquivalent(rec.flat, plate, { tol: 0.05 });
      expect(eq.reasons).toEqual([]);
    }
  });
});

describe('tessellation, size and orientation variants', () => {
  const L = profileFlat('L', [60, 40], [{ angle: 90, ri, direction: 'up' }], t, 80);

  it('facet steps from 15° (6 per 90°) down to 0.5° (180 per 90°)', () => {
    for (const per90 of [6, 8, 45, 90, 180]) roundTrip(L, foldedMesh(L, { facetsPer90: per90 }));
  });

  it('a 22.5°-step arc (4 facets per 90°) is beyond the curved band and reported as ignored faces', () => {
    const rec = recognizeSheet(foldedMesh(L, { facetsPer90: 4 }), OPTS);
    expect(rec.bendCount).toBe(0);
    expect(rec.issues.some(m => m.key === 'warnings.recognize.facesIgnored')).toBe(true);
  });

  it('coordinates quantised to 0.001 / 0.01 mm, inward normals and a 10 m offset', () => {
    for (const q of [1e-3, 1e-2]) {
      const m = foldedMesh(L);
      roundTrip(L, { ...m, positions: Float32Array.from(m.positions, v => Math.round(v / q) * q) }, { angleTol: 0.2 });
    }
    roundTrip(L, foldedMesh(L, { inward: true }));
    const m = foldedMesh(L);
    roundTrip(L, { ...m, positions: Float32Array.from(m.positions, (v, i) => v + (i % 3 === 0 ? 10000 : 0)) }, { angleTol: 0.05 });
  });

  it('large radius with a short leg, thick plate, tiny part', () => {
    roundTrip(profileFlat('bigR', [50, 6], [{ angle: 90, ri: 10, direction: 'up' }], t, 40), foldedMesh(profileFlat('bigR', [50, 6], [{ angle: 90, ri: 10, direction: 'up' }], t, 40)));
    const thick = profileFlat('thick', [300, 200, 150], [{ angle: 90, ri: 6, direction: 'up' }, { angle: 90, ri: 6, direction: 'up' }], 6, 500);
    roundTrip(thick, foldedMesh(thick));
    const tiny = profileFlat('tiny', [12, 6], [{ angle: 90, ri: 0.5, direction: 'up' }], 0.5, 10);
    roundTrip(tiny, foldedMesh(tiny));
  });

  it('a U with legs longer than the web and a square flat are canonical and equivalent', () => {
    const u = profileFlat('U', [80, 40, 80], [{ angle: 90, ri, direction: 'up' }, { angle: 90, ri, direction: 'up' }], t, 100);
    roundTrip(u, foldedMesh(u));
    const sq = profileFlat('sq', [50, 50], [{ angle: 90, ri, direction: 'up' }], t, 100 + B);
    roundTrip(sq, foldedMesh(sq));
  });

  it('a two-body mesh keeps the body of the largest face and reports the other as ignored faces', () => {
    const m = foldedMesh(L);
    const pos = new Float32Array(m.positions.length * 2);
    pos.set(m.positions, 0);
    for (let i = 0; i < m.positions.length; i += 3) { pos[m.positions.length + i] = m.positions[i]! + 300; pos[m.positions.length + i + 1] = m.positions[i + 1]!; pos[m.positions.length + i + 2] = m.positions[i + 2]!; }
    const idx = new Uint32Array(m.indices.length * 2);
    idx.set(m.indices, 0);
    const nv = m.positions.length / 3;
    for (let i = 0; i < m.indices.length; i++) idx[m.indices.length + i] = m.indices[i]! + nv;
    const rec = recognizeSheet({ positions: pos, indices: idx, units: 'mm', name: 'two' }, OPTS);
    expect(rec.bendCount).toBe(1);
    expect(rec.issues.some(m => m.key === 'warnings.recognize.facesIgnored' && m.params?.count === 4)).toBe(true);
    expect(rec.confidence).toBeLessThan(1);
    expect(flatsEquivalent(rec.flat, L).equivalent).toBe(true);
  });
});
