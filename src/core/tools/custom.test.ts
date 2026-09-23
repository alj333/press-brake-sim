import { describe, it, expect } from 'vitest';
import { isCCW, bounds, distanceToBoundary } from '../geom';
import { normalizeProfile, createCustomPunch, createCustomDie, createCustomFinger, newCustomId } from './custom';
import { derivePunchParams, deriveDieParams, deriveFingerParams } from './derive';
import { straightPunch, gooseneckPunch, acutePunch, radiusPunch, hemmingPunch } from './punches';
import { vDie, multiVDie, hemmingDie } from './dies';
import { flatFinger, steppedFinger } from './fingers';
import { isSimplePolygon } from './profile';

// Point lists of samples/tools/*.dxf (closed LWPOLYLINE on layer 0, mm), inlined.
const GOOSENECK_DXF = [
  { x: 0, y: 0 }, { x: 6, y: 6.2 }, { x: 6, y: 25 }, { x: 26, y: 55 }, { x: 26, y: 120 }, { x: -12, y: 120 },
  { x: -12, y: 92 }, { x: 4, y: 70 }, { x: 6, y: 45 }, { x: -7, y: 28 }, { x: -6, y: 6.2 },
];
const V16_DIE_DXF = [
  { x: -30, y: 0 }, { x: -8, y: 0 }, { x: 0, y: -8.284242510324557 }, { x: 8, y: 0 }, { x: 30, y: 0 }, { x: 30, y: -60 }, { x: -30, y: -60 },
];
const FINGER_DXF = [{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 25, y: 20 }, { x: 25, y: 35 }, { x: 60, y: 35 }, { x: 60, y: 0 }];

describe('derivations agree with the parametric generators', () => {
  it('punches: tip radius / angle / tang centre', () => {
    const cases = [
      straightPunch(), straightPunch({ tipRadius: 0.2 }), straightPunch({ tipAngle: 85 }), straightPunch({ tipRadius: 0 }),
      gooseneckPunch(), acutePunch({ tipAngle: 30 }), acutePunch({ tipAngle: 28, tipRadius: 1.0 }),
      radiusPunch({ radius: 3 }), radiusPunch({ radius: 5 }), radiusPunch({ radius: 10 }),
    ];
    for (const p of cases) {
      const d = derivePunchParams(p.profile.points);
      expect(d.tipRadius, p.id).toBeCloseTo(p.tipRadius, 3);
      expect(d.tipAngle, p.id).toBeCloseTo(p.tipAngle, 3);
      expect(d.height, p.id).toBeCloseTo(p.height, 9);
      expect(d.bodyWidth, p.id).toBeCloseTo(p.bodyWidth, 6);
      expect(d.tangCentreX, p.id).toBeCloseTo(p.tangCentreX, 6);
      expect(d.messages).toEqual([]);
    }
    const h = derivePunchParams(hemmingPunch().profile.points);
    expect(h.tipAngle).toBe(180); expect(h.tipRadius).toBe(0);
  });

  it('dies: V width / angle / shoulder radius from the notch at the origin', () => {
    const cases = [
      ...[6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80].map(v => vDie({ vWidth: v })),
      vDie({ vWidth: 12, vAngle: 85 }), vDie({ vWidth: 16, vAngle: 30 }), vDie({ vWidth: 16, shoulderRadius: 0 }),
      multiVDie({ active: 0 }), multiVDie({ active: 1 }), multiVDie({ active: 2 }), multiVDie({ active: 3 }),
    ];
    for (const d of cases) {
      const r = deriveDieParams(d.profile.points);
      expect(r.hasNotch, d.id).toBe(true);
      expect(r.vWidth, d.id).toBeCloseTo(d.vWidth, 3);
      expect(r.vAngle, d.id).toBeCloseTo(d.vAngle, 3);
      expect(r.shoulderRadius, d.id).toBeCloseTo(d.shoulderRadius, 2);
      expect(r.vCentreX, d.id).toBeCloseTo(0, 6);
      expect(r.topY, d.id).toBeCloseTo(0, 9);
      expect(r.height, d.id).toBeCloseTo(d.height, 9);
      expect(r.bodyWidth, d.id).toBeCloseTo(d.bodyWidth, 9);
    }
    const flat = deriveDieParams(hemmingDie().profile.points);
    expect(flat.hasNotch).toBe(false); expect(flat.vWidth).toBe(0); expect(flat.vAngle).toBe(180);
  });

  it('fingers: stop height / body depth', () => {
    for (const f of [flatFinger(), steppedFinger(), flatFinger({ stopHeight: 35, height: 35 })]) {
      const r = deriveFingerParams(f.profile.points);
      expect(r.stopHeight, f.id).toBeCloseTo(f.stopHeight, 9);
      expect(r.bodyDepth, f.id).toBeCloseTo(f.bodyDepth, 9);
      expect(r.height, f.id).toBeCloseTo(f.height, 9);
      expect(r.messages).toEqual([]);
    }
  });
});

describe('normalizeProfile', () => {
  it('gooseneck DXF as drawn: tip at origin, CCW, no shift', () => {
    const n = normalizeProfile(GOOSENECK_DXF, { kind: 'punch' });
    expect(n.messages).toEqual([]);
    expect(isCCW(n.profile.points)).toBe(true);
    expect(n.height).toBe(120);
    expect(n.shift).toEqual({ x: 0, y: 0 });
    expect(n.profile.points.some(p => p.x === 0 && p.y === 0)).toBe(true);
    const b = bounds(n.profile.points);
    expect(b.min.y).toBe(0); expect(b.min.x).toBe(-12); expect(b.max.x).toBe(26);
  });

  it('rotation: a punch drawn tip-up (y-) or lying (x+/x-) ends up tip-down at the origin', () => {
    const upsideDown = GOOSENECK_DXF.map(p => ({ x: p.x, y: -p.y }));   // tip up
    const a = normalizeProfile(upsideDown, { kind: 'punch', upDir: 'y-' });
    expect(a.messages).toEqual([]);
    const ref = normalizeProfile(GOOSENECK_DXF, { kind: 'punch' }).profile.points;
    // rotating by 180° about the origin then... the result is mirrored in x relative to the reference; compare with mirrorX
    const b = normalizeProfile(upsideDown, { kind: 'punch', upDir: 'y-', mirrorX: true });
    const sortKey = (p: { x: number; y: number }): string => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    expect(b.profile.points.map(sortKey).sort()).toEqual(ref.map(sortKey).sort());
    // lying on its side: +X in the drawing should be up
    const lying = GOOSENECK_DXF.map(p => ({ x: p.y, y: -p.x }));            // rotated −90°: up → +X
    const c = normalizeProfile(lying, { kind: 'punch', upDir: 'x+' });
    expect(c.profile.points.map(sortKey).sort()).toEqual(ref.map(sortKey).sort());
    const lying2 = GOOSENECK_DXF.map(p => ({ x: -p.y, y: p.x }));           // rotated +90°: up → −X
    const d = normalizeProfile(lying2, { kind: 'punch', upDir: 'x-' });
    expect(d.profile.points.map(sortKey).sort()).toEqual(ref.map(sortKey).sort());
  });

  it('reference point, scale and y-extent shift are applied and reported', () => {
    // drawn in inches, offset, with the reference given explicitly
    const inch = GOOSENECK_DXF.map(p => ({ x: (p.x + 100) / 25.4, y: (p.y + 50) / 25.4 }));
    const n = normalizeProfile(inch, { kind: 'punch', referencePoint: { x: 100 / 25.4, y: 50 / 25.4 }, scale: 25.4 });
    expect(n.height).toBeCloseTo(120, 6);
    expect(n.messages).toEqual([]);
    // a wrong reference (5 mm above the tip) → shifted down and reported
    const w = normalizeProfile(GOOSENECK_DXF, { kind: 'punch', referencePoint: { x: 0, y: 5 } });
    expect(w.shift.y).toBeCloseTo(5, 9);
    expect(w.messages.some(m => m.key === 'warnings.tool.profileShifted')).toBe(true);
    expect(bounds(w.profile.points).min.y).toBe(0);
  });

  it('die: auto reference = V centre on the shoulder plane; drawn offset', () => {
    const offset = V16_DIE_DXF.map(p => ({ x: p.x + 40, y: p.y + 10 }));
    const n = normalizeProfile(offset, { kind: 'die' });
    expect(n.height).toBe(60);
    const b = bounds(n.profile.points);
    expect(b.max.y).toBe(0); expect(b.min.y).toBe(-60);
    expect(n.profile.points.some(p => Math.abs(p.x) < 1e-6 && Math.abs(p.y + 8.284242510324557) < 1e-5)).toBe(true);
  });

  it('finger: stop face on x = 0 from the origin', () => {
    const offset = FINGER_DXF.map(p => ({ x: p.x - 7, y: p.y + 3 }));
    const n = normalizeProfile(offset, { kind: 'finger' });
    const b = bounds(n.profile.points);
    expect(b.min.x).toBe(0); expect(b.min.y).toBe(0); expect(n.height).toBe(35);
    expect(isCCW(n.profile.points)).toBe(true);
  });

  it('bad input: too few points / self-intersection reported, never throws', () => {
    expect(normalizeProfile([{ x: 0, y: 0 }, { x: 1, y: 1 }], { kind: 'punch' }).messages[0]!.key).toBe('warnings.tool.profileTooFewPoints');
    const bow = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(normalizeProfile(bow, { kind: 'punch' }).messages.some(m => m.key === 'warnings.tool.profileSelfIntersecting')).toBe(true);
    const line = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    expect(normalizeProfile(line, { kind: 'die' }).messages.some(m => m.key === 'warnings.tool.profileDegenerate')).toBe(true);
  });
});

describe('createCustom* from the sample tool DXFs', () => {
  it('gooseneck punch: sharp 88° tip, tang centre 7, custom id', () => {
    const n = normalizeProfile(GOOSENECK_DXF, { kind: 'punch' });
    const p = createCustomPunch(n.profile, { name: 'Shop gooseneck', family: 'gooseneck' });
    expect(p.kind).toBe('punch'); expect(p.source).toBe('custom');
    expect(p.id).toMatch(/^custom:[0-9a-f-]{36}$/);
    expect(p.height).toBe(120);
    expect(p.tipRadius).toBe(0);
    expect(p.tipAngle).toBeCloseTo(2 * Math.atan(6 / 6.2) * 180 / Math.PI, 1);
    expect(p.tangCentreX).toBe(7);
    expect(p.bodyWidth).toBe(38);
    expect(p.maxLoadPerMeter).toBe(600);
    expect(isCCW(p.profile.points)).toBe(true); expect(isSimplePolygon(p.profile.points)).toBe(true);
    expect(distanceToBoundary({ x: 0, y: 0 }, p.profile.points)).toBe(0);
  });

  it('V16 die: V16 / 88° / sharp shoulders', () => {
    const n = normalizeProfile(V16_DIE_DXF, { kind: 'die' });
    const d = createCustomDie(n.profile, { name: 'Shop V16' });
    expect(d.kind).toBe('die'); expect(d.source).toBe('custom'); expect(d.family).toBe('custom');
    expect(d.vWidth).toBeCloseTo(16, 6);
    expect(d.vAngle).toBeCloseTo(88, 3);
    expect(d.shoulderRadius).toBe(0);
    expect(d.height).toBe(60); expect(d.bodyWidth).toBe(60);
    expect(bounds(d.profile.points).max.y).toBe(0);
  });

  it('stepped finger: stop 20, body 60, height 35', () => {
    const n = normalizeProfile(FINGER_DXF, { kind: 'finger' });
    const f = createCustomFinger(n.profile, { name: 'Shop finger', width: 25 });
    expect(f.kind).toBe('finger'); expect(f.source).toBe('custom');
    expect(f.stopHeight).toBe(20); expect(f.bodyDepth).toBe(60); expect(f.height).toBe(35); expect(f.width).toBe(25);
    expect(isCCW(f.profile.points)).toBe(true);
    // same shape as the standard stepped finger
    const std = steppedFinger();
    const key = (p: { x: number; y: number }): string => `${p.x},${p.y}`;
    expect(f.profile.points.map(key).sort()).toEqual(std.profile.points.map(key).sort());
  });

  it('meta overrides and ids', () => {
    const p = createCustomPunch(straightPunch().profile, { id: 'custom:fixed', tipRadius: 1, maxLoadPerMeter: 300, segmentLengths: [50], notes: 'x' });
    expect(p.id).toBe('custom:fixed'); expect(p.tipRadius).toBe(1); expect(p.maxLoadPerMeter).toBe(300); expect(p.segmentLengths).toEqual([50]); expect(p.notes).toBe('x');
    const ids = new Set([newCustomId(), newCustomId(), newCustomId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^custom:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
