import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from '../geom';
import { foldGeometry, flatState, bendPose } from '../part';
import { punchTipY } from '../bend';
import { computePlacement, computePlacementDetails, classifyTurn } from './placement';
import { sampleSetup } from './test-helpers';

describe('computePlacement', () => {
  const { part, machine, setup } = sampleSetup('L-bracket');
  const station = setup.stations[0]!;
  const t = 2;
  const folded = foldGeometry(part, flatState(part));
  const link = part.links[0]!;

  it('child gauged: bend line on Z at X = 0, sheet on Y ∈ [0, t], child toward +X, concave up', () => {
    const p = computePlacement(part, folded, 'B1', link.childFlangeId, station, t);
    expect(p.gaugedFlangeId).toBe(link.childFlangeId);
    expect(p.frontFlangeId).toBe(link.parentFlangeId);
    expect(p.flipped).toBe(false);
    // the bend line (flat u = 58.26, v ∈ [0, 80]) maps to x = 0, y = t/2
    for (const v of [0, 40, 80]) {
      const q = mat4.applyToPoint(p.transform, { x: 58.261947, y: v, z: 0 });
      expect(Math.abs(q.x)).toBeLessThan(1e-9);
      expect(q.y).toBeCloseTo(t / 2, 9);
    }
    // +w → +Y (up bend, parent normal +z), child (u > 58) → +X
    expect(mat4.applyToDir(p.transform, { x: 0, y: 0, z: 1 }).y).toBeCloseTo(1, 12);
    expect(mat4.applyToPoint(p.transform, { x: 96.52, y: 0, z: 0 }).x).toBeCloseTo(38.26, 1);
    expect(mat4.applyToPoint(p.transform, { x: 0, y: 0, z: 0 }).x).toBeCloseTo(-58.26, 1);
    // bend line centred in the station
    const d = computePlacementDetails(part, folded, 'B1', link.childFlangeId, station, t);
    expect((d.bendZ[0] + d.bendZ[1]) / 2).toBeCloseTo(machine.bedLength / 2, 6);
    expect(d.bendZ[1] - d.bendZ[0]).toBeCloseTo(80, 6);
    expect(p.partZOffset).toBeCloseTo(machine.bedLength / 2 - 40, 6);
    // the rotation is proper (det +1) and the transform is rigid
    expect(mat4.determinant(p.transform)).toBeCloseTo(1, 9);
  });

  it('parent gauged: the root goes to +X and the child to the front', () => {
    const p = computePlacement(part, folded, 'B1', link.parentFlangeId, station, t);
    expect(mat4.applyToPoint(p.transform, { x: 0, y: 0, z: 0 }).x).toBeCloseTo(58.26, 1);
    expect(mat4.applyToPoint(p.transform, { x: 96.52, y: 0, z: 0 }).x).toBeCloseTo(-38.26, 1);
    expect(mat4.applyToDir(p.transform, { x: 0, y: 0, z: 1 }).y).toBeCloseTo(1, 12);
    expect(p.flipped).toBe(false);
  });

  it('down bend: the part is flipped (root +w → −Y) so the concave side is up', () => {
    const z = sampleSetup('Z-bracket');
    const f0 = foldGeometry(z.part, flatState(z.part));
    const l2 = z.part.links.find(l => l.bendId === 'B2')!;
    const p = computePlacement(z.part, f0, 'B2', l2.childFlangeId, z.setup.stations[0]!, 2);
    expect(p.flipped).toBe(true);
    expect(mat4.applyToDir(p.transform, { x: 0, y: 0, z: 1 }).y).toBeCloseTo(-1, 12);
    const b2 = z.part.flat.bends.find(b => b.id === 'B2')!;
    const q = mat4.applyToPoint(p.transform, { x: b2.p0.x, y: 50, z: 0 });
    expect(Math.abs(q.x)).toBeLessThan(1e-6);
    expect(q.y).toBeCloseTo(1, 6);
  });

  it('uses the parent flange current normal after previous bends (hat channel B1 after B2)', () => {
    const h = sampleSetup('hat-channel');
    const fB2 = foldGeometry(h.part, { B2: 1 });
    const l1 = h.part.links.find(l => l.bendId === 'B1')!;
    const p = computePlacement(h.part, fB2, 'B1', l1.childFlangeId, h.setup.stations[0]!, 2);
    // the parent of B1 (bent 90° down from the root) lies on the die: its normal → ±Y
    const parent = fB2.flanges.find(f => f.flangeId === l1.parentFlangeId)!;
    const n = mat4.applyToDir(p.transform, parent.normal);
    expect(Math.abs(n.y)).toBeCloseTo(1, 9);
    // the root now stands: its normal is horizontal
    const root = fB2.flanges.find(f => f.flangeId === h.part.rootFlangeId)!;
    expect(Math.abs(mat4.applyToDir(p.transform, root.normal).y)).toBeLessThan(1e-9);
  });

  it('bendPose at f = 0 equals the placement', () => {
    const p = computePlacement(part, folded, 'B1', link.childFlangeId, station, t);
    const pose = bendPose(p.transform, folded, 'B1', 0, punchTipY(16, t, 2.56, 0), t);
    expect(mat4.equals(pose, p.transform, 1e-9)).toBe(true);
  });

  it('rejects a non-adjacent flange and a non-flat bend', () => {
    expect(() => computePlacement(part, folded, 'B1', 'F99', station, t)).toThrow();
    const bent = foldGeometry(part, { B1: 1 });
    expect(() => computePlacement(part, bent, 'B1', link.childFlangeId, station, t)).toThrow();
  });
});

describe('classifyTurn', () => {
  const base = mat4.multiply(mat4.translationXYZ(-10, 1, 1500), mat4.fromAxisAngle({ x: 1, y: 0, z: 0 }, -90));
  it('translation only → none', () => {
    expect(classifyTurn(base, mat4.multiply(mat4.translationXYZ(50, 0, -20), base))).toBe('none');
  });
  it('rotation about Y → rotate180 (also for 90°)', () => {
    expect(classifyTurn(base, mat4.multiply(mat4.fromAxisAngle({ x: 0, y: 1, z: 0 }, 180), base))).toBe('rotate180');
    expect(classifyTurn(base, mat4.multiply(mat4.fromAxisAngle({ x: 0, y: 1, z: 0 }, 90), base))).toBe('rotate180');
  });
  it('180° about Z → flip-front-back, about X → flip-end-for-end', () => {
    expect(classifyTurn(base, mat4.multiply(mat4.fromAxisAngle({ x: 0, y: 0, z: 1 }, 180), base))).toBe('flip-front-back');
    expect(classifyTurn(base, mat4.multiply(mat4.fromAxisAngle({ x: 1, y: 0, z: 0 }, 180), base))).toBe('flip-end-for-end');
    // flip combined with a translation is still a flip
    const m = mat4.multiply(mat4.translationXYZ(5, 0, 100), mat4.multiply(mat4.fromAxisAngle({ x: 0, y: 0, z: 1 }, 180), base));
    expect(classifyTurn(base, m)).toBe('flip-front-back');
    expect(vec3.length({ x: 1, y: 0, z: 0 })).toBe(1);
  });
});
