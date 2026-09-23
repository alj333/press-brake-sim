/**
 * Regression tests from the review: sliver triangles with unreliable normals, safe collinear
 * simplification, closed-cylinder detection on coarse tessellations, empty Kabsch input, inch DXF.
 */
import { describe, it, expect } from 'vitest';
import { loadTruth } from '../../testing/fixtures';
import type { FlatPattern, RecognizedSheet, TriangleMesh, Vec3 } from '../../types';
import { vec2, vec3 } from '../../geom';
import { recognizeSheet, matchToDxf, kabsch2d, buildTopology, groupFaces, fitCylinder } from './index';
import { simplifyLoop3 } from './faces';
import { simplifyCollinearSafe } from './unfold';

const OPTS = { materialId: 'm', kFactor: 0.44 };

/**
 * A 100 × 50 × 2 plate whose top face contains a sliver triangle (height 1 µm) with a float32-noisy
 * vertex 1e-5 off the plane: its normal is 0.57° off, far beyond the 0.2° planar tolerance.
 */
function sliverPlate(withGroups: boolean): TriangleMesh {
  const A: Vec3 = { x: 0, y: 0, z: 2 }, Bv: Vec3 = { x: 100, y: 0, z: 2 }, C: Vec3 = { x: 100, y: 50, z: 2 }, D: Vec3 = { x: 0, y: 50, z: 2 };
  const E: Vec3 = { x: 50, y: 0.001, z: 2.00001 };
  const A0: Vec3 = { x: 0, y: 0, z: 0 }, B0: Vec3 = { x: 100, y: 0, z: 0 }, C0: Vec3 = { x: 100, y: 50, z: 0 }, D0: Vec3 = { x: 0, y: 50, z: 0 };
  const V: number[] = [], I: number[] = [];
  const groups: Array<{ first: number; last: number }> = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3): void => { for (const p of [a, b, c]) { V.push(p.x, p.y, p.z); } I.push(I.length, I.length + 1, I.length + 2); };
  let start = 0;
  const group = (): void => { groups.push({ first: start, last: I.length / 3 - 1 }); start = I.length / 3; };
  tri(A, Bv, E); tri(A, E, D); tri(E, Bv, C); tri(E, C, D); group();           // top (+z) with the sliver A-B-E
  tri(A0, C0, B0); tri(A0, D0, C0); group();                                       // bottom (−z)
  tri(A0, B0, Bv); tri(A0, Bv, A); group();                                        // y = 0 wall (shares A-B with the sliver)
  tri(B0, C0, C); tri(B0, C, Bv); group();                                         // x = 100
  tri(C0, D0, D); tri(C0, D, C); group();                                          // y = 50
  tri(D0, A0, A); tri(D0, A, D); group();                                          // x = 0
  const mesh: TriangleMesh = { positions: Float32Array.from(V), indices: Uint32Array.from(I), units: 'mm', name: 'sliver' };
  if (withGroups) mesh.faceGroups = groups;
  return mesh;
}

describe('sliver triangles', () => {
  it('are flagged by the topology and do not break the planar classification (STEP path) or grouping (mesh path)', () => {
    for (const withGroups of [false, true]) {
      const mesh = sliverPlate(withGroups);
      const topo = buildTopology(mesh);
      expect(topo.openEdges).toBe(0);
      expect(topo.sliver.reduce((a, b) => a + b, 0)).toBe(1);
      const g = groupFaces(topo);
      expect(g.faces.filter(f => f.kind === 'curved')).toEqual([]);
      expect(g.faces.length).toBe(6);
      const rec = recognizeSheet(mesh, OPTS);
      expect(rec.thickness).toBeCloseTo(2, 6);
      expect(rec.confidence).toBe(1);
      expect(rec.issues.map(m => m.key)).toEqual(['warnings.recognize.noBends']);
      expect(rec.flat.outline.length).toBe(4);
      expect(rec.faces.length).toBe(1);
    }
  });
});

describe('safe collinear simplification', () => {
  it('simplifyLoop3 thins a fine 3D arc to chords within tol instead of erasing it', () => {
    const loop: Vec3[] = [];
    for (let i = 0; i < 720; i++) { const a = (2 * Math.PI * i) / 720; loop.push({ x: 5 * Math.cos(a), y: 5 * Math.sin(a), z: 1 }); }
    const out = simplifyLoop3(loop, 1e-3);
    expect(out.length).toBeGreaterThanOrEqual(60);
    expect(out.length).toBeLessThan(720);
    for (const p of out) expect(Math.abs(Math.hypot(p.x, p.y) - 5)).toBeLessThan(1e-9);
    // a square with collinear midpoints comes back as the 4 corners
    const sq: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 0, y: 5, z: 0.0005 }];
    expect(simplifyLoop3(sq, 1e-3).length).toBe(4);
  });

  it('simplifyCollinearSafe keeps a fine 2D arc within tol and removes exactly collinear vertices', () => {
    const circle = Array.from({ length: 720 }, (_, i) => ({ x: 5 * Math.cos((2 * Math.PI * i) / 720), y: 5 * Math.sin((2 * Math.PI * i) / 720) }));
    const out = simplifyCollinearSafe(circle, 1e-3);
    expect(out.length).toBeGreaterThanOrEqual(60);
    for (const p of out) expect(Math.abs(vec2.length(p) - 5)).toBeLessThan(1e-9);
    // every removed vertex lies within tol of the simplified polygon
    for (const p of circle) {
      let d = Infinity;
      for (let i = 0; i < out.length; i++) {
        const a = out[i]!, b = out[(i + 1) % out.length]!;
        const ab = vec2.sub(b, a), s = Math.max(0, Math.min(1, vec2.dot(vec2.sub(p, a), ab) / vec2.lengthSq(ab)));
        d = Math.min(d, vec2.dist(p, vec2.add(a, vec2.scale(ab, s))));
      }
      expect(d).toBeLessThanOrEqual(1e-3 + 1e-9);
    }
    expect(simplifyCollinearSafe([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 1e-6).length).toBe(4);
  });
});

describe('edge fillets', () => {
  /** 100 × 50 × 2 plate whose top y = 0 edge is rounded R0.5 (8 facets): a convex cylinder smaller than t. */
  function filletedPlate(): TriangleMesh {
    const V: number[] = [], I: number[] = [];
    const tri = (a: Vec3, b: Vec3, c: Vec3): void => { for (const p of [a, b, c]) V.push(p.x, p.y, p.z); I.push(I.length, I.length + 1, I.length + 2); };
    const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => { tri(a, b, c); tri(a, c, d); };
    // (y, z) profile, CCW seen from +x: bottom, far wall, top, fillet arc down to the near wall
    const prof: Array<[number, number]> = [[0, 0], [50, 0], [50, 2], [0.5, 2]];
    for (let i = 1; i <= 8; i++) { const f = (i / 8) * (Math.PI / 2); prof.push([0.5 - 0.5 * Math.sin(f), 1.5 + 0.5 * Math.cos(f)]); }
    const at = (x: number, p: [number, number]): Vec3 => ({ x, y: p[0], z: p[1] });
    // side faces x = 0 (normal −x) and x = 100 (+x) as fans from the first profile point
    for (let i = 1; i < prof.length - 1; i++) {
      tri(at(0, prof[0]!), at(0, prof[i + 1]!), at(0, prof[i]!));
      tri(at(100, prof[0]!), at(100, prof[i]!), at(100, prof[i + 1]!));
    }
    // extruded profile edges: quad between x = 0 and x = 100, winding so the normal points outward
    for (let i = 0; i < prof.length; i++) {
      const a = prof[i]!, b = prof[(i + 1) % prof.length]!;
      quad(at(0, a), at(0, b), at(100, b), at(100, a));
    }
    return { positions: Float32Array.from(V), indices: Uint32Array.from(I), units: 'mm', name: 'fillet' };
  }

  it('a sub-thickness convex fillet along a cut edge is not reported as an unpaired bend cylinder', () => {
    const mesh = filletedPlate();
    const topo = buildTopology(mesh);
    expect(topo.openEdges).toBe(0);
    const rec = recognizeSheet(mesh, OPTS);
    expect(rec.thickness).toBeCloseTo(2, 4);
    expect(rec.bendCount).toBe(0);
    expect(rec.issues.map(m => m.key)).toEqual(['warnings.recognize.noBends']);
    expect(rec.confidence).toBe(1);
    expect(rec.flat.outline.length).toBe(4);
  });
});

describe('closed cylinder detection', () => {
  /** Open-ended tube of n facets (radius r, length L): every facet is a quad. */
  function tube(n: number, r: number, L: number, extentDeg = 360): TriangleMesh {
    const V: number[] = [], I: number[] = [];
    const facets = Math.round((n * extentDeg) / 360);
    for (let i = 0; i < facets; i++) {
      const a0 = ((2 * Math.PI) * i) / n, a1 = ((2 * Math.PI) * (i + 1)) / n;
      const p = [[r * Math.cos(a0), r * Math.sin(a0), 0], [r * Math.cos(a1), r * Math.sin(a1), 0], [r * Math.cos(a1), r * Math.sin(a1), L], [r * Math.cos(a0), r * Math.sin(a0), L]];
      const base = V.length / 3;
      for (const q of p) V.push(...q);
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { positions: Float32Array.from(V), indices: Uint32Array.from(I), units: 'mm', name: 'tube', faceGroups: [{ first: 0, last: I.length / 3 - 1 }] };
  }

  it('a 12-facet (30° step) or 24-facet (15° step) full tube is `full`; a 270° curl is not', () => {
    for (const n of [12, 24, 72]) {
      const topo = buildTopology(tube(n, 5, 10));
      const fit = fitCylinder(topo, Array.from({ length: topo.triCount }, (_, i) => i))!;
      expect(fit).not.toBeNull();
      expect(fit.full, `${n} facets`).toBe(true);
      expect(Math.abs(fit.radius - 5)).toBeLessThan(1e-3);
    }
    const topo = buildTopology(tube(72, 5, 10, 270));
    const fit = fitCylinder(topo, Array.from({ length: topo.triCount }, (_, i) => i))!;
    expect(fit.full).toBe(false);
    expect(Math.abs(fit.extentDeg - 270)).toBeLessThan(0.01);
  });
});

describe('matchToDxf odds and ends', () => {
  function recOf(flat: FlatPattern): RecognizedSheet {
    const bends = flat.bends.map(b => ({ ...b, sources: { geometry: 'step' as const, angle: 'step' as const, radius: 'step' as const, direction: 'step' as const } }));
    return { thickness: flat.thickness, bendCount: bends.length, bends3d: [], faces: [], flat: { ...flat, bends }, meshToPart: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], confidence: 1, issues: [] };
  }

  it('kabsch2d on empty input is the identity, not NaN', () => {
    const k = kabsch2d([], []);
    expect(k.rotationDeg).toBe(0);
    expect(k.translation).toEqual({ x: 0, y: 0 });
  });

  it('an inch-sourced DXF flat (already in mm) matches and keeps sourceUnits / provenance / kFactor', () => {
    const truth = loadTruth('Z-bracket');
    const dxf: FlatPattern = {
      ...truth.flat, sourceUnits: 'in', provenance: { file: 'z.dxf' },
      bends: truth.flat.bends.map(b => ({ ...b, angle: 90, innerRadius: 1, kFactor: 0.4, direction: 'up' as const, sources: { geometry: 'dxf' as const, angle: 'default' as const, radius: 'default' as const, direction: 'dxf' as const } })),
    };
    const m = matchToDxf(recOf(truth.flat), dxf);
    expect(m.pairs.length).toBe(2);
    expect(m.mirrored).toBe(false);
    expect(m.flat.sourceUnits).toBe('in');
    expect(m.flat.provenance).toEqual({ file: 'z.dxf' });
    for (const b of m.flat.bends) {
      const tb = truth.flat.bends.find(x => x.id === b.id)!;
      expect(b.kFactor).toBe(0.4);                 // DXF k-factor kept
      expect(b.direction).toBe(tb.direction);      // the 3D directions win over the DXF's all-'up' labels
      expect(b.innerRadius).toBe(tb.innerRadius);
      expect(b.sources.geometry).toBe('dxf');
      expect(b.sources.direction).toBe('step');
    }
  });

  it('reversed DXF line orientation (p1 → p0) and a zero-length DXF line', () => {
    const truth = loadTruth('U-channel');
    const dxf: FlatPattern = { ...truth.flat, bends: truth.flat.bends.map(b => ({ ...b, p0: b.p1, p1: b.p0 })) };
    expect(matchToDxf(recOf(truth.flat), dxf).pairs.length).toBe(2);
    const zero: FlatPattern = { ...truth.flat, bends: [...truth.flat.bends, { ...truth.flat.bends[0]!, id: 'Z', p0: { x: 5, y: 5 }, p1: { x: 5, y: 5 } }] };
    const m = matchToDxf(recOf(truth.flat), zero);
    expect(m.pairs.length).toBe(2);
    expect(m.unmatchedDxf).toEqual(['Z']);
    expect(vec3.length({ x: m.transform.translation.x, y: m.transform.translation.y, z: 0 })).toBeLessThan(1e-6);
  });
});
