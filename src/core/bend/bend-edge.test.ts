import { describe, it, expect } from 'vitest';
import {
  bendAllowance, outsideSetback, bendDeduction, ramDepth, punchTipY, springback, overbend, legCheck, toolAngleFeasible,
  minLeg, actualInnerRadius, airBendForce,
} from './index';

/** Independent check of the ram-depth geometry: outer leg line tangent to the outer arc, resting on the shoulder / fillet. */
function legContactError(V: number, t: number, ri: number, thi: number, rs: number, vAngle: number): number {
  const D = ramDepth(V, t, ri, thi, rs, vAngle);
  const phi = (thi / 2) * Math.PI / 180;
  const C = { x: 0, y: ri - D };                          // arc centre (tip at the inner apex y = −D)
  const n = { x: Math.cos(phi), y: -Math.sin(phi) };      // outward normal of the right leg line
  const R = ri + t;
  if (rs <= 0) {
    // the line n·(p − C) = R must pass through the shoulder edge (V/2, 0)
    return n.x * (V / 2 - C.x) + n.y * (0 - C.y) - R;
  }
  const beta = (vAngle / 2) * Math.PI / 180;
  const F = { x: V / 2 + rs * (1 - Math.sin(beta)) / Math.cos(beta), y: -rs };
  return n.x * (F.x - C.x) + n.y * (F.y - C.y) - (R + rs);
}

describe('ram depth geometry', () => {
  it('sharp and filleted closed forms satisfy the tangency construction over a range of dies and angles', () => {
    for (const [V, t, ri] of [[6, 0.8, 0.8], [12, 1.5, 1.5], [16, 2, 2.56], [50, 6, 8], [80, 8, 12]] as const) {
      for (const thi of [30, 45, 60, 88.3, 90, 120, 150, 179]) {
        expect(Math.abs(legContactError(V, t, ri, thi, 0, 88)), `sharp V${V} θi${thi}`).toBeLessThan(1e-9);
        for (const [rs, va] of [[0.5, 88], [1.5, 88], [3, 30], [5, 85]] as const) {
          if (thi < va) continue; // below the die angle the sheet bottoms — not a valid air-bend state
          expect(Math.abs(legContactError(V, t, ri, thi, rs, va)), `fillet V${V} rs${rs} θi${thi}`).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('is monotonic in the included angle and continuous as the fillet vanishes; clamp at −t', () => {
    let prev = Infinity;
    for (let thi = 30; thi <= 180; thi += 2.5) {
      const D = ramDepth(16, 2, 2.56, thi, 1.5);
      expect(D).toBeLessThanOrEqual(prev + 1e-12);
      prev = D;
    }
    expect(ramDepth(16, 2, 2.56, 180, 1.5)).toBeCloseTo(-2, 12);
    expect(Math.abs(ramDepth(16, 2, 2.56, 100, 1e-9) - ramDepth(16, 2, 2.56, 100))).toBeLessThan(1e-6);
    // an outer radius larger than the die half-opening (R > V/2) drives the closed form below −t — clamped
    expect(ramDepth(6, 1, 10, 60)).toBe(-1);
    expect(ramDepth(6, 1, 10, 60, 0.5)).toBe(-1);
    // a wide die at a shallow angle stays above −t without clamping
    expect(ramDepth(80, 1, 10, 179.5)).toBeGreaterThan(-1);
    expect(ramDepth(80, 1, 10, 179.5)).toBeLessThan(0);
    // included angles outside (0, 180] are clamped, never NaN
    expect(Number.isFinite(ramDepth(16, 2, 2, 0))).toBe(true);
    expect(ramDepth(16, 2, 2, 200)).toBeCloseTo(-2, 12);
  });

  it('punchTipY decreases monotonically with the fold angle and starts at +t', () => {
    let prev = Infinity;
    for (let f = 0; f <= 150; f += 5) {
      const y = punchTipY(12, 1.5, 1.5, f, 1, 30);
      expect(y).toBeLessThanOrEqual(prev + 1e-12);
      prev = y;
    }
    expect(punchTipY(12, 1.5, 1.5, 0, 1, 30)).toBeCloseTo(1.5, 12);
    expect(punchTipY(12, 1.5, 1.5, 135, 1, 30)).toBeCloseTo(-ramDepth(12, 1.5, 1.5, 45, 1, 30), 12);
  });
});

describe('allowance / setback / deduction conventions', () => {
  it('outside setback is continuous at 90° and switches reference', () => {
    const a = outsideSetback(90, 2, 2), b = outsideSetback(90.000001, 2, 2);
    expect(a.value).toBeCloseTo(b.value, 6);
    expect(a.ref).toBe('virtual-sharp'); expect(b.ref).toBe('tangent');
    expect(outsideSetback(45, 1, 1).value).toBeCloseTo(Math.tan(Math.PI / 8) * 2, 12);
    expect(outsideSetback(180, 0.5, 1).value).toBe(1.5);
  });

  it('hem (180°) and acute allowances / deductions', () => {
    expect(bendAllowance(180, 0.5, 0.44, 1)).toBeCloseTo(Math.PI * 0.94, 12);
    expect(bendDeduction(180, 0.5, 0.44, 1)).toBeCloseTo(3 - Math.PI * 0.94, 12);
    expect(bendAllowance(135, 1.5, 0.44, 1.5)).toBeCloseTo(5.089380098815465, 9);
    expect(bendAllowance(0, 2, 0.44, 2)).toBe(0);
    // zero k-factor: neutral axis on the inside
    expect(bendAllowance(90, 2, 0, 2)).toBeCloseTo(Math.PI, 12);
  });

  it('springback / overbend / feasibility / leg boundaries', () => {
    const mat = { springbackDeg: 1.5 };
    expect(springback(mat, 2.56, 2, 45)).toBeCloseTo(0.855, 9);
    expect(springback(mat, 2.56, 2, 180)).toBeCloseTo(3.42, 9);
    const ob = overbend(mat, 2.56, 2, 90, -1);
    expect(ob.overbendAngle).toBeCloseTo(90.71, 9);
    expect(ob.loadedIncludedAngle).toBeCloseTo(89.29, 9);
    // boundary of the tool-angle rule (≤)
    expect(toolAngleFeasible(88, 88, 91)).toBe(true);
    expect(toolAngleFeasible(88, 88, 91.0001)).toBe(false);
    // leg check boundaries
    expect(legCheck(10, 10)).toBe('warning');
    expect(legCheck(11.5, 10)).toBe('ok');
    expect(legCheck(11.49, 10)).toBe('warning');
    expect(legCheck(9.99, 10)).toBe('error');
    expect(legCheck(12, 10, 1.3)).toBe('warning');
    // minimum leg grows for acute loaded angles
    expect(minLeg(12, 45, 1)).toBeGreaterThan(minLeg(12, 90, 1));
    expect(minLeg(12, 90, 1)).toBeCloseTo(6 / Math.SQRT1_2 + 3, 9);
  });

  it('actual radius scales with V and Rm; force scales with t² and 1/V', () => {
    const steel = { tensileStrength: 420, minInnerRadiusFactor: 0.8 };
    expect(actualInnerRadius(32, steel, 3, 0.8)).toBeCloseTo(5.12, 12);
    expect(actualInnerRadius(16, { tensileStrength: 620, minInnerRadiusFactor: 1.5 }, 2, 0.8)).toBeCloseTo(0.16 * 16 * 620 / 420, 12);
    const a = airBendForce(420, 1000, 2, 16), b = airBendForce(420, 1000, 4, 32);
    expect(b.force / a.force).toBeCloseTo(2, 12);
    expect(a.force).toBeCloseTo(a.forcePerMeter, 12);
  });
});
