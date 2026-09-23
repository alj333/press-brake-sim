import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth } from '../testing/fixtures';
import type { FlatPattern, Vec3 } from '../types';
import { mat4, vec3, centroid } from '../geom';
import { buildPartModel } from './build';
import { foldGeometry, flatState, finishedState, partBoundsFolded } from './fold';
import { zonePoint, zoneSurfaceSamples } from './zone';
import { flangeExtentFromBend } from './extent';

const dims = (b: { min: Vec3; max: Vec3 }) => [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].sort((a, c) => a - c);

function simpleFlat(len0: number, len1: number, width: number, direction: 'up' | 'down', angle = 90, t = 2, ri = 2, k = 0.44): FlatPattern {
  const ba = (angle * Math.PI / 180) * (ri + k * t);
  const u = len0 + ba / 2;
  return {
    id: 's', name: 's', thickness: t, materialId: 'std:mild-steel',
    outline: [{ x: 0, y: 0 }, { x: len0 + ba + len1, y: 0 }, { x: len0 + ba + len1, y: width }, { x: 0, y: width }],
    holes: [],
    bends: [{ id: 'B1', p0: { x: u, y: 0 }, p1: { x: u, y: width }, direction, angle, innerRadius: ri, kFactor: k, sources: { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } }],
  };
}

describe('foldGeometry', () => {
  it('L-bracket finished: child ⟂ root, bounds 60×40×80, arc continuity, radii', () => {
    const truth = loadTruth('L-bracket');
    const part = buildPartModel(truth.flat);
    const folded = foldGeometry(part, finishedState(part));
    const root = folded.flanges.find(f => f.flangeId === part.rootFlangeId)!;
    const child = folded.flanges.find(f => f.flangeId !== part.rootFlangeId)!;
    expect(vec3.equals(root.normal, { x: 0, y: 0, z: 1 })).toBe(true);
    expect(Math.abs(vec3.dot(root.normal, child.normal))).toBeLessThan(1e-9);
    // 'up' bend: the child rises toward +z and its top face looks back over the root (−x)
    expect(child.normal.x).toBeCloseTo(-1, 9);
    for (const p of child.regions[0]!.midSurface) expect(p.z).toBeGreaterThan(0);
    const d = dims(folded.bounds);
    const e = truth.expected.foldedBounds;
    const ed = [e.x, e.y, e.z].sort((a, b) => a - b);
    for (let i = 0; i < 3; i++) expect(Math.abs(d[i]! - ed[i]!)).toBeLessThan(0.1);
    // radii at f = 1
    const b = folded.bends[0]!;
    expect(b.currentAngle).toBe(90);
    expect(b.innerRadius).toBeCloseTo(2, 9);
    expect(b.midRadius).toBeCloseTo(3, 9);
    expect(b.zoneWidth).toBeCloseTo(truth.expected.bendAllowance['B1']!, 9);
    expect(b.thickness).toBe(2);
    expect(vec3.equals(b.toCentre, { x: 0, y: 0, z: 1 })).toBe(true);
    expect(vec3.equals(b.tangent, { x: 1, y: 0, z: 0 })).toBe(true);
    expect(b.axisPoint.z).toBeCloseTo(3, 9);
    expect(b.axisPoint.x).toBeCloseTo(56, 5);
    // right-hand rotation about axisDir carries the child up: axisDir = −y for this layout
    expect(b.axisDir.y).toBeCloseTo(-1, 9);
    // arc end continuous with the child: child zone-end vertices (flat u = zone end) land on the arc end
    const childFlange = part.flanges.find(f => f.id === child.flangeId)!;
    const uEnd = 58.261947 + b.zoneWidth / 2;
    let checked = 0;
    childFlange.regions[0]!.polygon.forEach((p, i) => {
      if (Math.abs(p.x - uEnd) > 1e-4) return;
      const lambda = (p.y - 0) / 80;
      const onArc = zonePoint(b, b.currentAngle, lambda, b.midRadius);
      const placed = child.regions[0]!.midSurface[i]!;
      expect(vec3.dist(onArc, placed)).toBeLessThan(1e-6);
      checked++;
    });
    expect(checked).toBe(2);
    // start edge sits on the root's zone-start line
    expect(b.startEdge[0]!.x).toBeCloseTo(56, 5);
    expect(b.startEdge[0]!.z).toBeCloseTo(0, 12);
    // mid-surface arc length ≈ rm·θ (fine polyline)
    let len = 0;
    for (let i = 1; i <= 64; i++) len += vec3.dist(zonePoint(b, b.currentAngle * (i - 1) / 64, 0, b.midRadius), zonePoint(b, b.currentAngle * i / 64, 0, b.midRadius));
    expect(Math.abs(len - b.midRadius * Math.PI / 2)).toBeLessThan(2e-3);
    // inner / outer surfaces are at ri and ri + t from the axis
    const s = zoneSurfaceSamples(b, 2, 0.5, 8);
    for (const p of s.inner) expect(vec3.dist(p, b.axisPoint)).toBeCloseTo(2, 9);
    for (const p of s.outer) expect(vec3.dist(p, b.axisPoint)).toBeCloseTo(4, 9);
  });

  it('f = 0 reproduces the flat', () => {
    const truth = loadTruth('L-bracket');
    const part = buildPartModel(truth.flat);
    const folded = foldGeometry(part, flatState(part));
    for (const f of folded.flanges) {
      expect(mat4.equals(f.transform, mat4.identity())).toBe(true);
      for (const r of f.regions) for (const p of r.midSurface) expect(p.z).toBe(0);
    }
    const b = folded.bends[0]!;
    expect(b.currentAngle).toBe(0);
    expect(b.midRadius).toBe(Infinity);
    expect(vec3.equals(b.toCentre, { x: 0, y: 0, z: 1 })).toBe(true);
    expect(b.axisPoint.x).toBeCloseTo(58.261947, 6);
    const d = dims(folded.bounds);
    expect(d[0]).toBeCloseTo(2, 9);
    expect(d[1]).toBeCloseTo(80, 9);
    expect(d[2]).toBeCloseTo(96.523893, 6);
    // missing ids mean flat too
    const folded2 = foldGeometry(part, {});
    expect(folded2.bends[0]!.currentAngle).toBe(0);
  });

  it("a 'down' bend folds toward −w", () => {
    const part = buildPartModel(simpleFlat(50, 30, 40, 'down'));
    const folded = foldGeometry(part, finishedState(part));
    const child = folded.flanges.find(f => f.flangeId !== part.rootFlangeId)!;
    const c = centroid(child.regions[0]!.midSurface.map(p => ({ x: p.x, y: p.z })));
    expect(c.y).toBeLessThan(-10);
    expect(folded.bends[0]!.toCentre.z).toBeCloseTo(-1, 12);
    expect(folded.bends[0]!.axisPoint.z).toBeCloseTo(-3, 9);
    const up = foldGeometry(buildPartModel(simpleFlat(50, 30, 40, 'up')), { B1: 1 });
    expect(up.bends[0]!.axisDir.y).toBeCloseTo(-folded.bends[0]!.axisDir.y, 12);
  });

  it('hat-channel finished bounds ≈ 86 × 30 × 100 and all samples match expected.foldedBounds', () => {
    for (const name of SAMPLE_NAMES) {
      const truth = loadTruth(name);
      const part = buildPartModel(truth.flat);
      const folded = foldGeometry(part, finishedState(part));
      const d = dims(folded.bounds);
      const e = truth.expected.foldedBounds;
      const ed = [e.x, e.y, e.z].sort((a, b) => a - b);
      for (let i = 0; i < 3; i++) expect(Math.abs(d[i]! - ed[i]!), `${name} dim ${i}`).toBeLessThan(0.1);
    }
    const hat = loadTruth('hat-channel');
    const part = buildPartModel(hat.flat);
    const d = dims(foldGeometry(part, finishedState(part)).bounds);
    expect(d[0]).toBeCloseTo(30, 1); expect(d[1]).toBeCloseTo(86, 1); expect(d[2]).toBeCloseTo(100, 1);
  });

  it('intermediate fractions and overbend f = 1.05', () => {
    const truth = loadTruth('L-bracket');
    const part = buildPartModel(truth.flat);
    for (const f of [0.25, 0.5, 1.05]) {
      const folded = foldGeometry(part, { B1: f });
      const b = folded.bends[0]!;
      expect(b.currentAngle).toBeCloseTo(90 * f, 12);
      const rn = b.zoneWidth / (b.currentAngle * Math.PI / 180);
      expect(b.innerRadius).toBeCloseTo(rn - 0.44 * 2, 12);
      expect(b.midRadius).toBeCloseTo(b.innerRadius + 1, 12);
      const child = folded.flanges.find(x => x.flangeId !== part.rootFlangeId)!;
      const root = folded.flanges.find(x => x.flangeId === part.rootFlangeId)!;
      const ang = Math.acos(vec3.dot(root.normal, child.normal)) * 180 / Math.PI;
      expect(ang).toBeCloseTo(90 * f, 9);
      // arc end meets the child at the zone-end line
      const childFlange = part.flanges.find(x => x.id === child.flangeId)!;
      const uEnd = 58.261947 + b.zoneWidth / 2;
      childFlange.regions[0]!.polygon.forEach((p, i) => {
        if (Math.abs(p.x - uEnd) > 1e-4) return;
        const onArc = zonePoint(b, b.currentAngle, p.y / 80, b.midRadius);
        expect(vec3.dist(onArc, child.regions[0]!.midSurface[i]!)).toBeLessThan(1e-6);
      });
    }
  });

  it('composes down the tree (hat: brims parallel to the top, walls vertical)', () => {
    const truth = loadTruth('hat-channel');
    const part = buildPartModel(truth.flat);
    const folded = foldGeometry(part, finishedState(part));
    const root = folded.flanges.find(f => f.flangeId === part.rootFlangeId)!;
    const walls = part.links.filter(l => l.parentFlangeId === root.flangeId).map(l => folded.flanges.find(f => f.flangeId === l.childFlangeId)!);
    for (const w of walls) expect(Math.abs(vec3.dot(w.normal, root.normal))).toBeLessThan(1e-9);
    const brims = part.links.filter(l => l.parentFlangeId !== root.flangeId).map(l => folded.flanges.find(f => f.flangeId === l.childFlangeId)!);
    for (const b of brims) expect(Math.abs(Math.abs(vec3.dot(b.normal, root.normal)) - 1)).toBeLessThan(1e-9);
    // both brims at the same height (below the top, since the walls go down)
    const zs = brims.map(b => b.regions[0]!.midSurface[0]!.z);
    expect(zs[0]).toBeCloseTo(zs[1]!, 9);
  });

  it('is independent of the flat orientation and of the bend line direction', () => {
    const truth = loadTruth('L-bracket');
    const rot = (p: { x: number; y: number }) => {
      const a = 0.6, c = Math.cos(a), s = Math.sin(a);
      return { x: p.x * c - p.y * s + 17.3, y: p.x * s + p.y * c - 41.9 };
    };
    const flat: FlatPattern = {
      ...truth.flat,
      outline: truth.flat.outline.map(rot),
      holes: truth.flat.holes.map(h => h.map(rot)),
      bends: truth.flat.bends.map(b => ({ ...b, p0: rot(b.p1), p1: rot(b.p0) })), // rotated AND reversed
    };
    const part = buildPartModel(flat);
    expect(part.warnings).toEqual([]);
    expect(part.flanges.length).toBe(2);
    const ref = buildPartModel(truth.flat);
    expect(part.flanges[0]!.area).toBeCloseTo(ref.flanges[0]!.area, 6);
    expect(part.flanges[1]!.area).toBeCloseTo(ref.flanges[1]!.area, 6);
    const folded = foldGeometry(part, finishedState(part));
    const child = folded.flanges.find(f => f.flangeId !== part.rootFlangeId)!;
    const zs = child.regions[0]!.midSurface.map(p => p.z);
    expect(Math.min(...zs)).toBeCloseTo(3, 5);
    expect(Math.max(...zs)).toBeCloseTo(39, 5);
    expect(folded.bounds.max.z - folded.bounds.min.z).toBeCloseTo(40, 5);
    // the child rose toward +w ('up') even though p0/p1 were swapped
    expect(folded.bends[0]!.toCentre.z).toBeCloseTo(1, 12);
    // the arc tangent points from the root toward the child in the flat plane
    const rootC = centroid(ref.flanges[0]!.regions[0]!.polygon), childC = centroid(ref.flanges[1]!.regions[0]!.polygon);
    const dir = rot(childC).x - rot(rootC).x;
    expect(Math.sign(folded.bends[0]!.tangent.x)).toBe(Math.sign(dir));
  });

  it('partBoundsFolded with a transform', () => {
    const part = buildPartModel(loadTruth('L-bracket').flat);
    const folded = foldGeometry(part, finishedState(part));
    const b = partBoundsFolded(folded, 2, mat4.translation({ x: 100, y: 0, z: 0 }));
    expect(b.min.x).toBeCloseTo(folded.bounds.min.x + 100, 9);
    expect(b.max.z).toBeCloseTo(folded.bounds.max.z, 9);
  });
});

describe('flangeExtentFromBend', () => {
  it('L-bracket legs and tabbed-plate root beside the tab', () => {
    const truth = loadTruth('L-bracket');
    const part = buildPartModel(truth.flat);
    const ba = part.bendAllowance['B1']!;
    const child = part.links[0]!.childFlangeId;
    const c = flangeExtentFromBend(part, child, 'B1');
    expect(c.min).toBeCloseTo(ba / 2, 5);
    expect(c.max).toBeCloseTo(96.523893 - 58.261947, 5);
    const r = flangeExtentFromBend(part, part.rootFlangeId, 'B1');
    expect(r.min).toBeCloseTo(ba / 2, 5);
    expect(r.max).toBeCloseTo(58.261947, 5);
    const tp = buildPartModel(loadTruth('tabbed-plate').flat);
    const rt = flangeExtentFromBend(tp, tp.rootFlangeId, 'B1');
    expect(rt.max).toBeCloseTo(118, 9);
    expect(rt.min).toBeCloseTo(-2, 9); // side strips reach 2 mm past the bend line
    const tab = flangeExtentFromBend(tp, tp.links[0]!.childFlangeId, 'B1');
    expect(tab.min).toBeCloseTo(ba / 2, 9);
    expect(tab.max).toBeCloseTo(141.261947 - 118, 5);
  });
});
