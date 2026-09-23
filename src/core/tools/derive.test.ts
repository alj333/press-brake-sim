import { describe, it, expect } from 'vitest';
import { arcToPoints } from '../geom';
import { derivePunchParams, deriveDieParams, deriveFingerParams } from './derive';
import { normalizeProfile, createCustomPunch, createCustomDie } from './custom';
import type { Vec2 } from '../types';

const DEG = Math.PI / 180;

/** A straight punch drawn like a CAD export: tip arc flattened with `segs` chords (odd counts put the origin on a chord). */
function drawnPunch(r: number, tipAngle: number, segs: number, bodyHalf = 10, height = 120): Vec2[] {
  const a = tipAngle / 2;
  const c = { x: 0, y: r };
  const arc: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const ang = (180 + a + ((180 - 2 * a) * i) / segs) * DEG;
    arc.push({ x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) });
  }
  const tR = arc[arc.length - 1]!;
  const yBody = tR.y + (bodyHalf - tR.x) / Math.tan(a * DEG);
  return [...arc, { x: bodyHalf, y: yBody }, { x: bodyHalf, y: height }, { x: -bodyHalf, y: height }, { x: -bodyHalf, y: yBody }];
}

describe('derivePunchParams on CAD-like drawings', () => {
  it('odd and even chord counts, coarse and fine, small and large radii', () => {
    for (const [r, angle, segs] of [[0.8, 88, 3], [0.8, 88, 4], [0.8, 88, 7], [0.2, 88, 2], [0.2, 88, 3], [3, 88, 5], [10, 88, 9], [10, 88, 24], [1, 30, 3], [1, 30, 6], [0.8, 85, 5]] as const) {
      const raw = drawnPunch(r, angle, segs);
      const norm = normalizeProfile(raw, { kind: 'punch' });
      const d = derivePunchParams(norm.profile.points);
      expect(d.tipRadius, `r${r} a${angle} n${segs}`).toBeCloseTo(r, 2);
      expect(d.tipAngle, `r${r} a${angle} n${segs}`).toBeCloseTo(angle, 1);
      expect(d.arcVertices.length).toBe(segs + 1);
      expect(d.messages).toEqual([]);
      const p = createCustomPunch(norm.profile);
      expect(p.tipRadius).toBeCloseTo(r, 2); expect(p.tipAngle).toBeCloseTo(angle, 1);
    }
  });

  it('sharp tips and flat faces are not mistaken for arcs', () => {
    const sharp = [{ x: 0, y: 0 }, { x: 8, y: 8.3 }, { x: 8, y: 100 }, { x: -8, y: 100 }, { x: -8, y: 8.3 }];
    const d = derivePunchParams(sharp);
    expect(d.tipRadius).toBe(0); expect(d.tipAngle).toBeCloseTo(2 * Math.atan(8 / 8.3) / DEG, 6);
    const flatNoVertex = [{ x: -15, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 100 }, { x: -15, y: 100 }];
    expect(derivePunchParams(flatNoVertex)).toMatchObject({ tipRadius: 0, tipAngle: 180 });
    // chamfered tip (two gentle turns, nearly straight): the 3-point circle is huge → treated as sharp
    const chamfer = [{ x: -1, y: 0 }, { x: 0, y: -0.001 }, { x: 1, y: 0 }, { x: 10, y: 9 }, { x: 10, y: 100 }, { x: -10, y: 100 }, { x: -10, y: 9 }];
    const c = derivePunchParams(normalizeProfile(chamfer, { kind: 'punch' }).profile.points);
    expect(c.tipRadius).toBe(0);
    expect(c.tipAngle).toBeGreaterThan(150);
  });

  it('tip not at the origin is reported and still derived', () => {
    const off = [{ x: 3, y: 1 }, { x: 11, y: 9.3 }, { x: 11, y: 100 }, { x: -5, y: 100 }, { x: -5, y: 9.3 }];
    const d = derivePunchParams(off);
    expect(d.messages.some(m => m.key === 'warnings.tool.tipNotFound')).toBe(true);
    expect(d.tipAngle).toBeCloseTo(2 * Math.atan(8 / 8.3) / DEG, 6);
  });
});

describe('deriveDieParams on CAD-like drawings', () => {
  it('V with a bottom radius and shoulder fillets drawn as arcs', () => {
    const V = 20, beta = 44 * DEG, rs = 2, rb = 1.5, hb = 30, h = 60;
    const depth = (V / 2) / Math.tan(beta);
    // bottom fillet: circle tangent to both faces, centre on the axis at distance rb/sin(beta) above the sharp bottom
    const cb = { x: 0, y: -depth + rb / Math.sin(beta) };
    const tb = { x: rb * Math.cos(beta), y: cb.y - rb * Math.sin(beta) }; // tangent point on the right face
    const xc = V / 2 + (rs * (1 - Math.sin(beta))) / Math.cos(beta);
    const right = arcToPoints({ x: xc, y: -rs }, rs, 90, 180 - 44, true, 0.05);
    const bottom = arcToPoints(cb, rb, 270 - 44, 270 + 44, true, 0.05);
    const left = arcToPoints({ x: -xc, y: -rs }, rs, 44, 90, true, 0.05);
    const pts: Vec2[] = [{ x: -hb, y: -h }, { x: hb, y: -h }, { x: hb, y: 0 }, ...right, { x: tb.x, y: tb.y }, ...bottom, { x: -tb.x, y: tb.y }, ...left, { x: -hb, y: 0 }];
    const d = deriveDieParams(pts);
    expect(d.hasNotch).toBe(true);
    expect(d.vWidth).toBeCloseTo(V, 3); expect(d.vAngle).toBeCloseTo(88, 3); expect(d.shoulderRadius).toBeCloseTo(rs, 2);
    expect(d.vCentreX).toBeCloseTo(0, 6);
    const die = createCustomDie(normalizeProfile(pts.map(p => ({ x: p.x + 100, y: p.y - 5 })), { kind: 'die' }).profile);
    expect(die.vWidth).toBeCloseTo(V, 3); expect(die.height).toBe(60);
  });

  it('flat-bottomed U notch and a die drawn upside down', () => {
    const u = [{ x: -30, y: 0 }, { x: -10, y: 0 }, { x: -6, y: -15 }, { x: 6, y: -15 }, { x: 10, y: 0 }, { x: 30, y: 0 }, { x: 30, y: -60 }, { x: -30, y: -60 }];
    const d = deriveDieParams(u);
    expect(d.vWidth).toBeCloseTo(20, 6);
    expect(d.vAngle).toBeCloseTo(2 * Math.atan(4 / 15) / DEG, 6);
    const upside = u.map(p => ({ x: p.x, y: -p.y + 60 }));
    const n = normalizeProfile(upside, { kind: 'die', upDir: 'y-' });
    expect(deriveDieParams(n.profile.points).vWidth).toBeCloseTo(20, 6);
  });
});

describe('deriveFingerParams edge cases', () => {
  it('stop face detection climbs only vertical edges', () => {
    const f = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 35 }, { x: 10, y: 35 }, { x: 0, y: 25 }];
    expect(deriveFingerParams(f)).toMatchObject({ stopHeight: 25, bodyDepth: 60, height: 35 });
    const noFace = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 35 }, { x: 5, y: 35 }];
    const d = deriveFingerParams(noFace);
    expect(d.messages.some(m => m.key === 'warnings.tool.stopFaceNotFound')).toBe(true);
    expect(d.stopHeight).toBe(20);
  });
});
