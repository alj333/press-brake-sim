import { describe, it, expect } from 'vitest';
import { isCCW, bounds, distanceToBoundary, pointInPolygon } from '../geom';
import { vDie, multiVDie, hemmingDie, standardDieBodyWidth, standardDieHeight, standardShoulderRadius, standardDieRating } from './dies';
import { isSimplePolygon } from './profile';
import type { Die } from '../types';

function checkDie(d: Die): void {
  const pts = d.profile.points;
  expect(pts.length).toBeGreaterThanOrEqual(4);
  expect(isCCW(pts)).toBe(true);
  expect(isSimplePolygon(pts)).toBe(true);
  const b = bounds(pts);
  expect(b.max.y).toBeCloseTo(0, 9);
  expect(b.min.y).toBeCloseTo(-d.height, 9);
  expect(b.max.x - b.min.x).toBeCloseTo(d.bodyWidth, 9);
  expect(b.min.x).toBeCloseTo(-d.bodyWidth / 2, 9);
}

/** The V faces extended must hit y = 0 at ±V/2 and meet at (0, −(V/2)/tan β). */
function checkNotch(d: Die): void {
  const beta = (d.vAngle / 2) * Math.PI / 180;
  const depth = (d.vWidth / 2) / Math.tan(beta);
  const pts = d.profile.points;
  const bottom = pts.find(p => Math.abs(p.x) < 1e-9 && Math.abs(p.y + depth) < 1e-6);
  expect(bottom).toBeDefined();
  // origin (V centre on the shoulder plane) is NOT inside the material, the virtual sharp shoulders are on the face lines
  expect(pointInPolygon({ x: 0, y: -0.01 }, pts)).toBe(false);
  expect(pointInPolygon({ x: 0, y: -depth - 0.01 }, pts)).toBe(true);
  // points on the face lines just above the bottom are on the boundary
  const s = Math.sin(beta), c = Math.cos(beta);
  const onFace = { x: 2 * s, y: -depth + 2 * c };
  expect(distanceToBoundary(onFace, pts)).toBeLessThan(1e-6);
  expect(distanceToBoundary({ x: -onFace.x, y: onFace.y }, pts)).toBeLessThan(1e-6);
  // shoulder fillet vertices lie on the fillet circle
  if (d.shoulderRadius > 0) {
    const rs = d.shoulderRadius;
    const xc = d.vWidth / 2 + (rs * (1 - s)) / c;
    const fillet = pts.filter(p => p.x > d.vWidth / 2 - 1e-6 && p.x < xc + 1e-6 && p.y > -rs - 1e-6 && p.y <= 0);
    expect(fillet.length).toBeGreaterThanOrEqual(2);
    for (const p of fillet) expect(Math.hypot(p.x - xc, p.y + rs)).toBeCloseTo(rs, 8);
    // shoulder plane point (xc, 0) present, top surface beyond it flat at y = 0
    expect(pts.some(p => Math.abs(p.x - xc) < 1e-6 && Math.abs(p.y) < 1e-9)).toBe(true);
  } else {
    expect(pts.some(p => Math.abs(p.x - d.vWidth / 2) < 1e-9 && Math.abs(p.y) < 1e-9)).toBe(true);
  }
}

describe('die generators', () => {
  it('standard dimension formulas', () => {
    expect(standardDieBodyWidth(16)).toBe(60);
    expect(standardDieBodyWidth(50)).toBe(80);
    expect(standardDieBodyWidth(63)).toBe(100);
    expect(standardDieBodyWidth(80)).toBe(120);
    expect(standardDieHeight(25)).toBe(60); expect(standardDieHeight(32)).toBe(90); expect(standardDieHeight(63)).toBe(100);
    expect(standardShoulderRadius(16)).toBe(1.5); expect(standardShoulderRadius(12)).toBe(1);
    expect(standardShoulderRadius(6)).toBe(0.5); expect(standardShoulderRadius(63)).toBe(6.5);
    expect(standardDieRating(6)).toBe(300); expect(standardDieRating(8)).toBe(400); expect(standardDieRating(10)).toBe(600); expect(standardDieRating(12)).toBe(1000);
  });

  it('V16 88° die: notch at the origin, fillets on the ramDepth circle', () => {
    const d = vDie({ vWidth: 16 });
    checkDie(d); checkNotch(d);
    expect(d.id).toBe('std:die-v16-88'); expect(d.height).toBe(60); expect(d.bodyWidth).toBe(60);
    expect(d.shoulderRadius).toBe(1.5); expect(d.maxLoadPerMeter).toBe(1000); expect(d.family).toBe('v');
  });

  it('all standard V widths and angles', () => {
    for (const v of [6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80]) { const d = vDie({ vWidth: v }); checkDie(d); checkNotch(d); }
    for (const v of [12, 16]) {
      const d85 = vDie({ vWidth: v, vAngle: 85 }); checkDie(d85); checkNotch(d85);
      expect(d85.id).toBe(`std:die-v${v}-85`);
      const d30 = vDie({ vWidth: v, vAngle: 30 }); checkDie(d30); checkNotch(d30);
      expect(d30.id).toBe(`std:die-v${v}-30`);
    }
    const sharp = vDie({ vWidth: 16, shoulderRadius: 0 }); checkDie(sharp); checkNotch(sharp);
  });

  it('multi-V block: 90×90, active V on top, other Vs on the sides', () => {
    for (let a = 0; a < 4; a++) {
      const d = multiVDie({ active: a });
      checkDie(d); checkNotch(d);
      expect(d.bodyWidth).toBe(90); expect(d.height).toBe(90); expect(d.family).toBe('multi-v');
      expect(d.vWidth).toBe([16, 22, 35, 50][a]);
      expect(d.id).toBe(`std:die-multi-v${d.vWidth}`);
      // the bottom V (index a + 2) opens downward at x = 0
      const vb = [16, 22, 35, 50][(a + 2) % 4]!;
      const depthB = (vb / 2) / Math.tan(44 * Math.PI / 180);
      expect(d.profile.points.some(p => Math.abs(p.x) < 1e-6 && Math.abs(p.y - (-90 + depthB)) < 1e-6)).toBe(true);
      // the right V opens toward −X from the right side at y = −45
      const vr = [16, 22, 35, 50][(a + 1) % 4]!;
      const depthR = (vr / 2) / Math.tan(44 * Math.PI / 180);
      expect(d.profile.points.some(p => Math.abs(p.x - (45 - depthR)) < 1e-6 && Math.abs(p.y + 45) < 1e-6)).toBe(true);
    }
  });

  it('hemming die: flat top through the origin, no V', () => {
    const d = hemmingDie();
    checkDie(d);
    expect(d.vWidth).toBe(0); expect(d.vAngle).toBe(180); expect(d.family).toBe('hemming');
    expect(distanceToBoundary({ x: 0, y: 0 }, d.profile.points)).toBeLessThan(1e-9);
  });
});
