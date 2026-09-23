import { describe, it, expect } from 'vitest';
import { loadTruth } from '../testing/fixtures';
import type { FlatPattern, Mat4, Vec3 } from '../types';
import { mat4, vec3, area, bounds, polygonsIntersect } from '../geom';
import { punchTipY } from '../bend';
import { buildPartModel } from './build';
import { foldGeometry, flatState, finishedState } from './fold';
import { bendPose } from './pose';
import { partSilhouette } from './silhouette';
import { zoneCentrePoint } from './zone';

/** PART → MACHINE for a bend along PART y at x = xBend, sheet on the die, 'up' side toward +Y, child toward +X. */
function placementFor(xBend: number, t: number): Mat4 {
  // (x, y, z) → (x − xBend, z + t/2, −y): rotation about X by −90° then translate
  return mat4.multiply(mat4.translationXYZ(-xBend, t / 2, 0), mat4.fromAxisAngle({ x: 1, y: 0, z: 0 }, -90));
}

function symmetricFlat(leg: number, width: number, t = 2, ri = 2, k = 0.44): FlatPattern {
  const ba = (Math.PI / 2) * (ri + k * t);
  const u = leg + ba / 2;
  return {
    id: 'sym', name: 'sym', thickness: t, materialId: 'std:mild-steel',
    outline: [{ x: 0, y: 0 }, { x: 2 * leg + ba, y: 0 }, { x: 2 * leg + ba, y: width }, { x: 0, y: width }],
    holes: [],
    bends: [{ id: 'B1', p0: { x: u, y: 0 }, p1: { x: u, y: width }, direction: 'up', angle: 90, innerRadius: ri, kFactor: k, sources: { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } }],
  };
}

describe('bendPose', () => {
  const truth = loadTruth('L-bracket');
  const part = buildPartModel(truth.flat);
  const t = truth.thickness;
  const placement = placementFor(58.261947, t);

  it('placement sanity: bend line on Z at X = 0, lower face on Y = 0, child toward +X', () => {
    const p = mat4.applyToPoint(placement, { x: 58.261947, y: 10, z: 0 });
    expect(p.x).toBeCloseTo(0, 9); expect(p.y).toBeCloseTo(t / 2, 9); expect(p.z).toBeCloseTo(-10, 9);
    expect(mat4.applyToDir(placement, { x: 0, y: 0, z: 1 }).y).toBeCloseTo(1, 12);
    expect(mat4.applyToPoint(placement, { x: 90, y: 0, z: 0 }).x).toBeGreaterThan(0);
  });

  it('pose at f = 0 equals the placement', () => {
    const folded = foldGeometry(part, flatState(part));
    const pose = bendPose(placement, folded, 'B1', 0, punchTipY(16, t, 2.56, 0), t);
    expect(mat4.equals(pose, placement, 1e-9)).toBe(true);
  });

  it('bend-line-centre material point stays at X ≈ 0 and the apex at punchTipY − t/2', () => {
    for (const f of [0, 0.25, 0.5, 1]) {
      const folded = foldGeometry(part, { B1: f });
      const tipY = punchTipY(16, t, 2.56, 90 * f);
      const pose = bendPose(placement, folded, 'B1', f, tipY, t);
      const m = mat4.applyToPoint(pose, zoneCentrePoint(folded.bends[0]!));
      expect(Math.abs(m.x)).toBeLessThan(1e-6);
      expect(m.y).toBeCloseTo(tipY - t / 2, 9);
      if (f > 0) {
        // the apex is the lowest point of the mid-surface arc: sample it
        const b = folded.bends[0]!;
        for (let i = 0; i <= 16; i++) {
          const phi = (b.currentAngle * i) / 16;
          const C = vec3.add(b.startEdge[0], vec3.scale(b.toCentre, b.midRadius));
          const p: Vec3 = vec3.add(C, vec3.add(vec3.scale(b.toCentre, -b.midRadius * Math.cos(phi * Math.PI / 180)), vec3.scale(b.tangent, b.midRadius * Math.sin(phi * Math.PI / 180))));
          expect(mat4.applyToPoint(pose, p).y).toBeGreaterThanOrEqual(tipY - t / 2 - 1e-9);
        }
        // the arc centre sits straight above the apex
        const c = mat4.applyToPoint(pose, b.axisPoint);
        expect(Math.abs(c.x)).toBeLessThan(1e-6);
        expect(c.y).toBeCloseTo(tipY - t / 2 + b.midRadius, 9);
      }
    }
  });

  it('both legs rise symmetrically: far edges of a symmetric part at equal heights', () => {
    const flat = symmetricFlat(40, 30);
    const p = buildPartModel(flat);
    const ba = p.bendAllowance['B1']!;
    const pl = placementFor(40 + ba / 2, 2);
    for (const f of [0.25, 0.5, 1]) {
      const folded = foldGeometry(p, { B1: f });
      const pose = bendPose(pl, folded, 'B1', f, punchTipY(16, 2, 2.56, 90 * f), 2);
      const root = folded.flanges.find(x => x.flangeId === p.rootFlangeId)!;
      const child = folded.flanges.find(x => x.flangeId !== p.rootFlangeId)!;
      const farRoot = root.regions[0]!.midSurface.filter((_, i) => Math.abs(p.flanges.find(x => x.id === root.flangeId)!.regions[0]!.polygon[i]!.x) < 1e-9);
      const farChild = child.regions[0]!.midSurface.filter((_, i) => Math.abs(p.flanges.find(x => x.id === child.flangeId)!.regions[0]!.polygon[i]!.x - (2 * 40 + ba)) < 1e-6);
      expect(farRoot.length).toBe(2); expect(farChild.length).toBe(2);
      const yr = mat4.applyToPoint(pose, farRoot[0]!).y, yc = mat4.applyToPoint(pose, farChild[0]!).y;
      expect(yr).toBeCloseTo(yc, 6);
      const xr = mat4.applyToPoint(pose, farRoot[0]!).x, xc = mat4.applyToPoint(pose, farChild[0]!).x;
      expect(xr).toBeCloseTo(-xc, 6);
      expect(xc).toBeGreaterThan(0);
      // the parent leg is tilted by θf/2 from horizontal
      const n = mat4.applyToDir(pose, root.normal);
      expect(Math.acos(n.y) * 180 / Math.PI).toBeCloseTo(45 * f, 6);
    }
  });

  it("'down' bend with the parent flipped (+w → −Y): concave side still up, apex at the tip", () => {
    const flat: FlatPattern = { ...symmetricFlat(40, 30), bends: symmetricFlat(40, 30).bends.map(b => ({ ...b, direction: 'down' as const })) };
    const p = buildPartModel(flat);
    const ba = p.bendAllowance['B1']!;
    // (x, y, z) → (x − xBend, −z + t/2, y): rotation about X by +90°, then translate
    const pl = mat4.multiply(mat4.translationXYZ(-(40 + ba / 2), 1, 0), mat4.fromAxisAngle({ x: 1, y: 0, z: 0 }, 90));
    expect(mat4.applyToDir(pl, { x: 0, y: 0, z: 1 }).y).toBeCloseTo(-1, 12);
    for (const f of [0.3, 1]) {
      const folded = foldGeometry(p, { B1: f });
      const tipY = punchTipY(16, 2, 2.56, 90 * f);
      const pose = bendPose(pl, folded, 'B1', f, tipY, 2);
      const b = folded.bends[0]!;
      const m = mat4.applyToPoint(pose, zoneCentrePoint(b));
      expect(Math.abs(m.x)).toBeLessThan(1e-6);
      expect(m.y).toBeCloseTo(tipY - 1, 9);
      const c = mat4.applyToPoint(pose, b.axisPoint);
      expect(c.y).toBeCloseTo(tipY - 1 + b.midRadius, 9); // centre above the apex: concave side up
      expect(Math.abs(c.x)).toBeLessThan(1e-6);
      // both far edges at equal height and rising
      const root = folded.flanges.find(x => x.flangeId === p.rootFlangeId)!;
      const child = folded.flanges.find(x => x.flangeId !== p.rootFlangeId)!;
      const ys = [root, child].map(fl => Math.max(...fl.regions[0]!.midSurface.map(q => mat4.applyToPoint(pose, q).y)));
      expect(ys[0]).toBeCloseTo(ys[1]!, 6);
      expect(ys[0]).toBeGreaterThan(tipY - 1 + 5);
    }
  });

  it('throws for an unknown bend', () => {
    const folded = foldGeometry(part, flatState(part));
    expect(() => bendPose(placement, folded, 'nope', 0, 2, t)).toThrow();
  });
});

describe('partSilhouette', () => {
  const truth = loadTruth('L-bracket');
  const part = buildPartModel(truth.flat);
  const t = truth.thickness;
  const placement = placementFor(58.261947, t);

  it('flat L-bracket on the die: one 96.5 × 2 rectangle at y ∈ [t/2 − 1, t/2 + 1]', () => {
    const folded = foldGeometry(part, flatState(part));
    const sil = partSilhouette(folded, placement, t);
    expect(sil.length).toBe(3); // root region, straight zone strip, child region
    let totalArea = 0;
    let minX = Infinity, maxX = -Infinity;
    for (const s of sil) {
      const b = bounds(s.polygon);
      expect(b.min.y).toBeCloseTo(t / 2 - 1, 9);
      expect(b.max.y).toBeCloseTo(t / 2 + 1, 9);
      expect(s.zRange[0]).toBeCloseTo(-80, 9);
      expect(s.zRange[1]).toBeCloseTo(0, 9);
      expect(s.polygon.length).toBe(4);
      totalArea += area(s.polygon);
      minX = Math.min(minX, b.min.x); maxX = Math.max(maxX, b.max.x);
    }
    expect(totalArea).toBeCloseTo(96.523893 * 2, 4);
    expect(maxX - minX).toBeCloseTo(96.523893, 5);
    expect(minX).toBeCloseTo(-58.261947, 5);
    // pieces do not overlap each other (they only touch)
    for (let i = 0; i < sil.length; i++) for (let j = i + 1; j < sil.length; j++) {
      const a = sil[i]!.polygon, b = sil[j]!.polygon;
      expect(polygonsIntersect(a, b) ? area(a) + area(b) > 0 : true).toBe(true);
    }
    // zBand clipping keeps the shape and clamps the Z extent
    const band = partSilhouette(folded, placement, t, [-50, -30]);
    expect(band.length).toBe(3);
    for (const s of band) {
      expect(s.zRange[0]).toBeCloseTo(-50, 6); expect(s.zRange[1]).toBeCloseTo(-30, 6);
      const b = bounds(s.polygon);
      expect(b.max.y - b.min.y).toBeCloseTo(2, 9);
    }
    expect(partSilhouette(folded, placement, t, [10, 20]).length).toBe(0);
  });

  it('finished L-bracket: standing leg as a thick vertical rectangle, exact annular sector for the zone', () => {
    const folded = foldGeometry(part, finishedState(part));
    const sil = partSilhouette(folded, placement, t);
    expect(sil.length).toBe(3);
    const root = sil.find(s => s.source.kind === 'flange' && s.source.flangeId === part.rootFlangeId)!;
    const child = sil.find(s => s.source.kind === 'flange' && s.source.flangeId !== part.rootFlangeId)!;
    const zone = sil.find(s => s.source.kind === 'bend')!;
    const rb = bounds(root.polygon);
    expect(rb.min.y).toBeCloseTo(0, 9); expect(rb.max.y).toBeCloseTo(2, 9);
    expect(rb.min.x).toBeCloseTo(-58.261947, 5); expect(rb.max.x).toBeCloseTo(-2.261947, 5);
    const cb = bounds(child.polygon);
    // child mid-surface at X = 56 + rm − 58.262 = 0.738; Y from rm + t/2 = 4 to 40
    expect(cb.min.x).toBeCloseTo(0.738053 - 1, 5); expect(cb.max.x).toBeCloseTo(0.738053 + 1, 5);
    expect(cb.min.y).toBeCloseTo(4, 5); expect(cb.max.y).toBeCloseTo(40, 5);
    const zb = bounds(zone.polygon);
    expect(zb.min.x).toBeCloseTo(-2.261947, 5); expect(zb.max.x).toBeCloseTo(1.738053, 5);
    expect(zb.min.y).toBeCloseTo(0, 6); expect(zb.max.y).toBeCloseTo(4, 6);
    expect(zone.polygon.length).toBe(18);
    expect(area(zone.polygon)).toBeCloseTo((Math.PI / 4) * (16 - 4), 0); // quarter annulus ri 2, ro 4 (polygonised)
    for (const s of sil) { expect(s.zRange[0]).toBeCloseTo(-80, 9); expect(s.zRange[1]).toBeCloseTo(0, 9); }
  });

  it('box: end walls (normal ∥ Z) are hulls with a thin Z range and disappear from middle slices', () => {
    const tr = loadTruth('box-4-flange');
    const p = buildPartModel(tr.flat);
    const folded = foldGeometry(p, finishedState(p));
    // place with B1 (along u) on Z: rotate so PART x → machine Z, PART z → Y: (x, y, z) → (y, z, x)
    const R: Mat4 = [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]; // columns: x̂→ẑ, ŷ→x̂, ẑ→ŷ
    const sil = partSilhouette(folded, R, 2);
    expect(sil.length).toBe(5 + 4);
    const walls = sil.filter(s => s.source.kind === 'flange' && s.source.flangeId !== p.rootFlangeId);
    const endWalls = walls.filter(w => w.zRange[1] - w.zRange[0] < 3);
    expect(endWalls.length).toBe(2);
    for (const w of endWalls) expect(w.zRange[1] - w.zRange[0]).toBeCloseTo(2, 9);
    const longWalls = walls.filter(w => w.zRange[1] - w.zRange[0] > 100);
    expect(longWalls.length).toBe(2);
    // a slice through the middle of the box sees the root, the two long walls and their zones only
    const zMid = (folded.bounds.min.x + folded.bounds.max.x) / 2;
    const mid = partSilhouette(folded, R, 2, [zMid - 10, zMid + 10]);
    expect(mid.filter(s => s.source.kind === 'flange').length).toBe(3);
    expect(mid.filter(s => s.source.kind === 'bend').length).toBe(2);
  });
});
