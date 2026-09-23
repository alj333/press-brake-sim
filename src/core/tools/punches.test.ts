import { describe, it, expect } from 'vitest';
import { isCCW, distanceToBoundary, bounds } from '../geom';
import { straightPunch, gooseneckPunch, acutePunch, radiusPunch, hemmingPunch } from './punches';
import { isSimplePolygon } from './profile';
import type { Punch } from '../types';

function checkPunch(p: Punch): void {
  const pts = p.profile.points;
  expect(pts.length).toBeGreaterThanOrEqual(3);
  expect(isCCW(pts)).toBe(true);
  expect(isSimplePolygon(pts)).toBe(true);
  const b = bounds(pts);
  expect(b.min.y).toBeCloseTo(0, 9);
  expect(b.max.y).toBeCloseTo(p.height, 9);
  // tip at the origin: an explicit vertex
  expect(pts.some(q => Math.abs(q.x) < 1e-9 && Math.abs(q.y) < 1e-9)).toBe(true);
  expect(distanceToBoundary({ x: 0, y: 0 }, pts)).toBeLessThan(1e-9);
  expect(p.bodyWidth).toBeCloseTo(b.max.x - b.min.x, 6);
}

describe('punch generators', () => {
  it('straight 88° R0.8: closed CCW, tip at origin, flanks at 44°', () => {
    const p = straightPunch();
    checkPunch(p);
    expect(p.tipAngle).toBe(88); expect(p.tipRadius).toBe(0.8); expect(p.height).toBe(120);
    expect(p.tangCentreX).toBe(0); expect(p.family).toBe('straight');
    expect(p.id).toBe('std:punch-straight-88-r0.8');
    // tip arc: every arc vertex at distance r from (0, r)
    const arcPts = p.profile.points.filter(q => q.y < 0.3);
    expect(arcPts.length).toBeGreaterThanOrEqual(3);
    for (const q of arcPts) expect(Math.hypot(q.x, q.y - 0.8)).toBeCloseTo(0.8, 9);
    // right flank: the first non-arc vertex lies on the line through T_R at 44° from vertical
    const a = 44 * Math.PI / 180;
    const tR = { x: 0.8 * Math.cos(a), y: 0.8 * (1 - Math.sin(a)) };
    const next = p.profile.points.find(q => q.x > 5)!;
    expect((next.x - tR.x) / (next.y - tR.y)).toBeCloseTo(Math.tan(a), 9);
    expect(next.x).toBeCloseTo(10, 9);
    expect(p.maxLoadPerMeter).toBe(1000);
    expect(p.segmentLengths).toContain(835);
  });

  it('sharp tip (R0) is a single vertex with the flank angle', () => {
    const p = straightPunch({ tipRadius: 0, tipAngle: 88 });
    checkPunch(p);
    const tip = p.profile.points.findIndex(q => q.x === 0 && q.y === 0);
    const n = p.profile.points.length;
    const prev = p.profile.points[(tip + n - 1) % n]!, next = p.profile.points[(tip + 1) % n]!;
    const ang = Math.acos((prev.x * next.x + prev.y * next.y) / (Math.hypot(prev.x, prev.y) * Math.hypot(next.x, next.y))) * 180 / Math.PI;
    expect(ang).toBeCloseTo(88, 6);
  });

  it('85° and R0.2 variants', () => {
    checkPunch(straightPunch({ tipAngle: 85 }));
    checkPunch(straightPunch({ tipRadius: 0.2 }));
    expect(straightPunch({ tipAngle: 85 }).id).toBe('std:punch-straight-85-r0.8');
    expect(straightPunch({ tipRadius: 0.2 }).id).toBe('std:punch-straight-88-r0.2');
  });

  it('gooseneck: relief toward −X, tang centred at +7, height 120', () => {
    const p = gooseneckPunch();
    checkPunch(p);
    expect(p.tangCentreX).toBe(7); expect(p.family).toBe('gooseneck'); expect(p.maxLoadPerMeter).toBe(600);
    expect(p.id).toBe('std:punch-gooseneck-88-r0.8');
    const b = bounds(p.profile.points);
    expect(b.min.x).toBe(-12); expect(b.max.x).toBe(26);
    const top = p.profile.points.filter(q => q.y === 120).map(q => q.x).sort((x, y) => x - y);
    expect(top).toEqual([-12, 26]);
    // nose points as in ARCHITECTURE
    for (const q of [{ x: 6, y: 25 }, { x: 26, y: 55 }, { x: -12, y: 92 }, { x: 4, y: 70 }, { x: 6, y: 45 }, { x: -7, y: 28 }]) {
      expect(p.profile.points.some(r => Math.abs(r.x - q.x) < 1e-9 && Math.abs(r.y - q.y) < 1e-9)).toBe(true);
    }
    // a different height scales the body only
    const tall = gooseneckPunch({ height: 135 });
    checkPunch(tall);
    expect(tall.profile.points.some(q => Math.abs(q.x - 6) < 1e-9 && Math.abs(q.y - 25) < 1e-9)).toBe(true);
  });

  it('acute, radius and hemming punches', () => {
    const a30 = acutePunch({ tipAngle: 30, tipRadius: 0.8 });
    checkPunch(a30);
    expect(a30.family).toBe('acute'); expect(a30.tipAngle).toBe(30); expect(a30.maxLoadPerMeter).toBe(400);
    expect(a30.id).toBe('std:punch-acute-30-r0.8');
    const a28 = acutePunch({ tipAngle: 28, tipRadius: 1.0 });
    checkPunch(a28);
    expect(a28.id).toBe('std:punch-acute-28-r1');
    for (const r of [3, 5, 10]) {
      const p = radiusPunch({ radius: r });
      checkPunch(p);
      expect(p.family).toBe('radius'); expect(p.tipRadius).toBe(r); expect(p.maxLoadPerMeter).toBe(800);
      expect(p.id).toBe(`std:punch-radius-r${r}`);
      const arcPts = p.profile.points.filter(q => Math.abs(Math.hypot(q.x, q.y - r) - r) < 1e-9);
      expect(arcPts.length).toBeGreaterThanOrEqual(5);
    }
    const h = hemmingPunch();
    checkPunch(h);
    expect(h.tipAngle).toBe(180); expect(h.tipRadius).toBe(0); expect(h.family).toBe('hemming');
    expect(h.id).toBe('std:punch-hemming');
  });

  it('meta overrides', () => {
    const p = straightPunch({}, { id: 'custom:x', name: 'Mine', source: 'custom', maxLoadPerMeter: 500, segmentLengths: [100], notes: 'n' });
    expect(p.id).toBe('custom:x'); expect(p.name).toBe('Mine'); expect(p.source).toBe('custom');
    expect(p.maxLoadPerMeter).toBe(500); expect(p.segmentLengths).toEqual([100]); expect(p.notes).toBe('n');
  });
});
