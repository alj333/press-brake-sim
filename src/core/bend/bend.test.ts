import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth } from '../testing/fixtures';
import {
  bendAllowance, outsideSetback, bendDeduction, neutralRadius, midRadius, airBendForce, airBendForcePerMeter,
  hemFlattenForce, ramDepth, punchTipY, actualInnerRadius, springback, overbend, recommendedV, minLeg, legCheck,
  toolAngleFeasible,
} from './index';

describe('bend formulas — closed-form goldens', () => {
  it('bend allowance / setback / deduction', () => {
    expect(bendAllowance(90, 2, 0.44, 2)).toBeCloseTo(4.523893421169302, 9);
    const o = outsideSetback(90, 2, 2);
    expect(o.value).toBeCloseTo(4, 12); expect(o.ref).toBe('virtual-sharp');
    const o2 = outsideSetback(135, 1.5, 1.5);
    expect(o2.value).toBe(3); expect(o2.ref).toBe('tangent');
    expect(bendDeduction(90, 2, 0.44, 2)).toBeCloseTo(3.476106578830697, 9);
    expect(neutralRadius(2, 0.44, 2)).toBeCloseTo(2.88, 12);
    expect(midRadius(2, 2)).toBe(3);
  });

  it('ram depth sharp goldens from ARCHITECTURE', () => {
    expect(ramDepth(12, 2, 2, 90)).toBeCloseTo(2.343, 3);
    expect(ramDepth(16, 2, 2.5, 90)).toBeCloseTo(4.136, 3);
    expect(ramDepth(50, 6, 8, 90)).toBeCloseTo(13.2, 2);
    expect(ramDepth(12, 1.5, 1.5, 45)).toBeCloseTo(8.15, 2);
    expect(ramDepth(16, 2, 2, 180)).toBeCloseTo(-2, 12);
    // negative for shallow folds, clamped only at −t
    expect(ramDepth(16, 2, 2, 160)).toBeLessThan(0);
    expect(ramDepth(16, 2, 2, 160)).toBeGreaterThan(-2);
    expect(ramDepth(4, 2, 2, 179.9)).toBeGreaterThanOrEqual(-2);
  });

  it('ram depth with a shoulder fillet: leg line tangent to the fillet circle', () => {
    const V = 16, t = 2, ri = 2.56, thi = 88.29, rs = 1.5, vAngle = 88;
    const D = ramDepth(V, t, ri, thi, rs, vAngle);
    // verify geometrically: outer-arc centre (0, ri − D), leg outward normal n = (cos φ, −sin φ),
    // the leg line {p : n·(p − C) = R}; the fillet centre must be at distance R + rs from C along n
    const phi = (thi / 2) * Math.PI / 180, beta = (vAngle / 2) * Math.PI / 180;
    const xc = V / 2 + rs * (1 - Math.sin(beta)) / Math.cos(beta);
    const F = { x: xc, y: -rs }, C = { x: 0, y: ri - D };
    const n = { x: Math.cos(phi), y: -Math.sin(phi) };
    const dist = n.x * (F.x - C.x) + n.y * (F.y - C.y) - (ri + t);
    expect(dist).toBeCloseTo(rs, 9);
    // close to the sharp value for a small fillet, and reduces to it for rs = 0
    expect(Math.abs(D - ramDepth(V, t, ri, thi))).toBeLessThan(0.05);
    expect(ramDepth(V, t, ri, 180, rs, vAngle)).toBeCloseTo(-t, 9);
    // a bigger fillet on an acute die changes the depth noticeably
    expect(ramDepth(12, 1.5, 1.5, 42.435, 1, 30)).not.toBeCloseTo(ramDepth(12, 1.5, 1.5, 42.435), 2);
  });

  it('punchTipY = −D(180 − fold) and +t at 0', () => {
    expect(punchTipY(16, 2, 2.56, 0)).toBeCloseTo(2, 12);
    expect(punchTipY(16, 2, 2.56, 91.71)).toBeCloseTo(-ramDepth(16, 2, 2.56, 88.29), 12);
    expect(punchTipY(16, 2, 2.56, 30)).toBeGreaterThan(0);
  });

  it('forces', () => {
    const f = airBendForce(420, 80, 2, 16);
    expect(f.forcePerMeter).toBeCloseTo(149.1, 6);
    expect(f.force).toBeCloseTo(11.928, 6);
    expect(airBendForcePerMeter(420, 2, 16)).toBeCloseTo(149.1, 6);
    expect(hemFlattenForce(420, 2, 1000)).toBeCloseTo(588, 9); // ≈ 60 t/m
  });

  it('actual radius / springback / overbend / V / min leg / checks', () => {
    const steel = { tensileStrength: 420, minInnerRadiusFactor: 0.8, springbackDeg: 1.5 };
    expect(actualInnerRadius(16, steel, 2, 0.8)).toBeCloseTo(2.56, 12);
    expect(actualInnerRadius(6, steel, 2, 0.8)).toBeCloseTo(1.6, 12);     // material minimum wins
    expect(actualInnerRadius(6, steel, 1, 3)).toBe(3);                    // punch tip wins
    expect(springback(steel, 2.56, 2, 90)).toBeCloseTo(1.71, 9);
    expect(springback({ springbackDeg: 0.1 }, 1, 2, 10)).toBe(0.3);       // clamp low
    expect(springback({ springbackDeg: 10 }, 10, 1, 170)).toBe(12);       // clamp high
    const ob = overbend(steel, 2.56, 2, 90, 0.5);
    expect(ob.springback).toBeCloseTo(1.71, 9);
    expect(ob.overbendAngle).toBeCloseTo(92.21, 9);
    expect(ob.loadedIncludedAngle).toBeCloseTo(87.79, 9);
    expect(recommendedV(2)).toBe(16); expect(recommendedV(3)).toBe(24); expect(recommendedV(4)).toBe(40); expect(recommendedV(8)).toBe(96);
    expect(minLeg(16, 88.29, 1.5)).toBeCloseTo(14.986387388711767, 6);
    expect(legCheck(10, 14.98)).toBe('error');
    expect(legCheck(16, 14.98)).toBe('warning');
    expect(legCheck(18, 14.98)).toBe('ok');
    expect(toolAngleFeasible(88, 88, 90)).toBe(true);
    expect(toolAngleFeasible(88, 88, 91.71)).toBe(false);
    expect(toolAngleFeasible(30, 30, 137.565)).toBe(true);
    expect(toolAngleFeasible(85, 30, 91.71)).toBe(true);
    expect(toolAngleFeasible(88, 30, 91.71)).toBe(false);
    expect(toolAngleFeasible(30, 88, 91.71)).toBe(false);
  });
});

describe('bend formulas — sample goldens (expected.perBend)', () => {
  for (const name of SAMPLE_NAMES) {
    it(`${name}`, () => {
      const truth = loadTruth(name);
      const t = truth.thickness;
      const { defaultSetup: setup, tolerances: tol, perBend } = truth.expected;
      const mat = { tensileStrength: truth.material.Rm, springbackDeg: truth.material.sb, minInnerRadiusFactor: truth.material.minR };
      for (const b of truth.flat.bends) {
        const g = perBend[b.id]!;
        expect(bendAllowance(b.angle, b.innerRadius, b.kFactor, t)).toBeCloseTo(g.bendAllowance, 9);
        expect(bendDeduction(b.angle, b.innerRadius, b.kFactor, t)).toBeCloseTo(g.bendDeduction, 9);
        expect(180 - b.angle).toBe(g.includedAngle);
        const riAct = actualInnerRadius(setup.dieV, mat, t, setup.punchTipRadius);
        expect(riAct).toBeCloseTo(g.actualInnerRadius, 9);
        const ob = overbend(mat, riAct, t, b.angle);
        expect(Math.abs(ob.springback - g.springback)).toBeLessThan(tol.angle);
        expect(Math.abs(ob.overbendAngle - g.overbendAngle)).toBeLessThan(tol.angle);
        expect(Math.abs(ob.loadedIncludedAngle - g.loadedIncludedAngle)).toBeLessThan(tol.angle);
        const D = ramDepth(setup.dieV, t, riAct, g.loadedIncludedAngle);
        expect(Math.abs(D - g.ramDepthSharpShoulder)).toBeLessThan(tol.ramDepth);
        const L = Math.hypot(b.p1.x - b.p0.x, b.p1.y - b.p0.y);
        expect(Math.abs(L - g.bendLength)).toBeLessThan(tol.length);
        const f = airBendForce(mat.tensileStrength, L, t, setup.dieV);
        expect(Math.abs(f.forcePerMeter - g.forcePerMeter) / g.forcePerMeter * 100).toBeLessThan(tol.forcePercent);
        expect(Math.abs(f.force - g.force) / g.force * 100).toBeLessThan(tol.forcePercent);
        expect(Math.abs(minLeg(setup.dieV, g.loadedIncludedAngle, setup.shoulderRadius) - g.minLegOutside)).toBeLessThan(tol.length);
      }
    });
  }
});
