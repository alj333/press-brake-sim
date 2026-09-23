/**
 * Reviewer edge-case tests for src/core/tools: degenerate / odd inputs, obtuse tips, inch
 * drawings, un-normalised profiles, parametric guards, odd bed lengths and NaN loads.
 */
import { describe, it, expect } from 'vitest';
import { isCCW, bounds, arcToPoints, distanceToBoundary } from '../geom';
import { derivePunchParams, deriveDieParams, deriveFingerParams } from './derive';
import { normalizeProfile, createCustomPunch, createCustomDie, createCustomFinger, enforceFrameExtents } from './custom';
import { straightPunch, gooseneckPunch, acutePunch, radiusPunch, hemmingPunch } from './punches';
import { vDie, multiVDie, hemmingDie, vNotchDepth, shoulderTangentX, maxShoulderRadius } from './dies';
import { flatFinger, steppedFinger } from './fingers';
import { isSimplePolygon, tipArc } from './profile';
import { segmentsForLength, defaultToolSetup, pickDieForThickness } from './setup';
import { buildStandardLibrary } from './standard';
import { toolLoadCheck, daylightCheck, strokeCheck } from './checks';
import { defaultMachine } from '../machine/default';
import { validateSetup } from '../machine/validate';
import type { Die, Punch, Tool, Vec2 } from '../types';

const DEG = Math.PI / 180;
const lib = buildStandardLibrary();
const machine = defaultMachine();

/** Every generated profile must be a simple CCW polygon obeying its frame's extent rule. */
function expectWellFormed(t: Tool, label = t.id): void {
  const pts = t.profile.points;
  expect(pts.length, label).toBeGreaterThanOrEqual(3);
  expect(isCCW(pts), label).toBe(true);
  expect(isSimplePolygon(pts), label).toBe(true);
  const b = bounds(pts);
  if (t.kind === 'die') { expect(b.max.y, label).toBeCloseTo(0, 9); expect(b.min.y, label).toBeCloseTo(-t.height, 9); }
  else { expect(b.min.y, label).toBeCloseTo(0, 9); expect(b.max.y, label).toBeCloseTo(t.height, 9); }
  if (t.kind === 'finger') expect(b.min.x, label).toBeCloseTo(0, 9);
  if (t.kind === 'punch') expect(distanceToBoundary({ x: 0, y: 0 }, pts), label).toBeLessThan(1e-9);
  if (t.kind === 'die') expect(distanceToBoundary({ x: 0, y: 0 }, pts), label).toBeLessThan(t.vWidth > 0 ? t.vWidth : 1e-9 + 1e-9);
}

/** A sharp symmetric punch tip of the given included angle, flanks to x = ±8 then a vertical body. */
function sharpTip(includedDeg: number, height = 100): Vec2[] {
  const y = 8 / Math.tan((includedDeg / 2) * DEG);
  return [{ x: 0, y: 0 }, { x: 8, y }, { x: 8, y: height }, { x: -8, y: height }, { x: -8, y }];
}

describe('derivePunchParams — tips the builder skipped', () => {
  it('obtuse sharp tips (130°–170°) are sharp, never a huge radius with a nonsense angle', () => {
    for (const a of [130, 140, 150, 160, 170]) {
      const d = derivePunchParams(sharpTip(a));
      expect(d.tipRadius, `${a}°`).toBe(0);
      expect(d.tipAngle, `${a}°`).toBeCloseTo(a, 6);
      expect(d.arcVertices, `${a}°`).toEqual([]);
      expect(d.messages).toEqual([]);
    }
  });

  it('a chamfered flat tip (origin on the flat, gentle turns at both ends) is a flat face', () => {
    const pts = [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 10, y: 3 }, { x: 10, y: 100 }, { x: -10, y: 100 }, { x: -10, y: 3 }];
    const d = derivePunchParams(pts);
    expect(d.tipRadius).toBe(0);
    expect(d.tipAngle).toBe(180);
  });

  it('a rounded tip drawn with the origin on a chord and a coarse 3-chord arc still fits', () => {
    // r = 2, 88°, 3 chords: the origin lies on the middle chord, not on a vertex
    const r = 2, a = 44;
    const arc: Vec2[] = [];
    for (let i = 0; i <= 3; i++) {
      const ang = (180 + a + ((180 - 2 * a) * i) / 3) * DEG;
      arc.push({ x: r * Math.cos(ang), y: r + r * Math.sin(ang) });
    }
    const tR = arc[arc.length - 1]!;
    const yBody = tR.y + (10 - tR.x) / Math.tan(a * DEG);
    const raw = [...arc, { x: 10, y: yBody }, { x: 10, y: 100 }, { x: -10, y: 100 }, { x: -10, y: yBody }];
    const n = normalizeProfile(raw, { kind: 'punch' });
    const d = derivePunchParams(n.profile.points);
    expect(d.tipRadius).toBeCloseTo(2, 2);
    expect(d.tipAngle).toBeCloseTo(88, 1);
    expect(d.arcVertices.length).toBe(4);
  });

  it('tip away from the origin: warns and seeds from the LOWEST vertex, so the offset punch still derives 88° R0.8', () => {
    const off = straightPunch().profile.points.map(p => ({ x: p.x + 3, y: p.y + 5 }));
    const d = derivePunchParams(off);
    expect(d.messages.map(m => m.key)).toEqual(['warnings.tool.tipNotFound']);
    expect(d.tipRadius).toBeCloseTo(0.8, 3);
    expect(d.tipAngle).toBeCloseTo(88, 3);
  });

  it('every standard punch, mirrored in x, derives the same tip', () => {
    for (const p of lib.punches) {
      const mirrored = p.profile.points.map(q => ({ x: -q.x, y: q.y })).reverse();
      const d = derivePunchParams(mirrored);
      expect(d.tipRadius, p.id).toBeCloseTo(p.tipRadius, 3);
      expect(d.tipAngle, p.id).toBeCloseTo(p.tipAngle, 2);
      expect(d.tangCentreX, p.id).toBeCloseTo(-p.tangCentreX, 6);
    }
  });
});

describe('deriveDieParams — odd notches', () => {
  it('an off-centre notch is found with its centre reported (auto reference uses it)', () => {
    const off = vDie({ vWidth: 20 }).profile.points.map(p => ({ x: p.x + 12.5, y: p.y - 3 }));
    const d = deriveDieParams(off);
    expect(d.hasNotch).toBe(true);
    expect(d.vWidth).toBeCloseTo(20, 6); expect(d.vAngle).toBeCloseTo(88, 6);
    expect(d.vCentreX).toBeCloseTo(12.5, 6); expect(d.topY).toBeCloseTo(-3, 9);
    const n = normalizeProfile(off, { kind: 'die' });
    expect(n.messages).toEqual([]);
    expect(deriveDieParams(n.profile.points).vCentreX).toBeCloseTo(0, 6);
  });

  it('two notches: the one straddling x = 0 wins, otherwise the deepest', () => {
    const two: Vec2[] = [{ x: -50, y: -60 }, { x: 50, y: -60 }, { x: 50, y: 0 }, { x: 35, y: 0 }, { x: 30, y: -5 }, { x: 25, y: 0 }, { x: 8, y: 0 }, { x: 0, y: -8.284 }, { x: -8, y: 0 }, { x: -50, y: 0 }];
    expect(deriveDieParams(two)).toMatchObject({ hasNotch: true });
    expect(deriveDieParams(two).vWidth).toBeCloseTo(16, 3);
    expect(deriveDieParams(two).vCentreX).toBeCloseTo(0, 6);
    const shifted = two.map(p => ({ x: p.x + 20, y: p.y }));
    expect(deriveDieParams(shifted).vWidth).toBeCloseTo(16, 3);
    expect(deriveDieParams(shifted).vCentreX).toBeCloseTo(20, 6);
  });

  it('shallow (120°) and acute (30°) custom Vs with fillets, and an inch drawing', () => {
    for (const [v, a] of [[30, 120], [16, 30], [12, 60]] as const) {
      const die = vDie({ vWidth: v, vAngle: a });
      const d = deriveDieParams(die.profile.points);
      expect(d.vWidth, `${v}/${a}`).toBeCloseTo(v, 3);
      expect(d.vAngle, `${v}/${a}`).toBeCloseTo(a, 3);
      expect(d.shoulderRadius, `${v}/${a}`).toBeCloseTo(die.shoulderRadius, 2);
    }
    const inch = vDie({ vWidth: 25.4 }).profile.points.map(p => ({ x: p.x / 25.4, y: p.y / 25.4 }));
    const n = normalizeProfile(inch, { kind: 'die', scale: 25.4 });
    expect(n.height).toBeCloseTo(90, 6); // V > 25 ⇒ 90 high
    expect(deriveDieParams(n.profile.points).vWidth).toBeCloseTo(25.4, 3);
  });

  it('a body with rounded outer corners does not confuse the notch search', () => {
    const r = 3;
    const pts: Vec2[] = [
      { x: -30, y: -60 }, { x: 30, y: -60 }, { x: 30, y: -r }, ...arcToPoints({ x: 30 - r, y: -r }, r, 0, 90, true, 0.02).slice(1),
      { x: 8, y: 0 }, { x: 0, y: -8.284 }, { x: -8, y: 0 },
      ...arcToPoints({ x: -30 + r, y: -r }, r, 90, 180, true, 0.02), { x: -30, y: -60 },
    ];
    const d = deriveDieParams(pts);
    expect(d.hasNotch).toBe(true);
    expect(d.vWidth).toBeCloseTo(16, 3);
    expect(d.shoulderRadius).toBe(0);
  });
});

describe('deriveFingerParams — front faces', () => {
  it('a small chamfer under the stop face is tolerated; the face top is the stop height', () => {
    const pts = [{ x: 0, y: 1.5 }, { x: 1.5, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 35 }, { x: 15, y: 35 }, { x: 0, y: 20 }];
    const d = deriveFingerParams(normalizeProfile(pts, { kind: 'finger' }).profile.points);
    expect(d.messages).toEqual([]);
    expect(d.stopHeight).toBeCloseTo(20, 6);
  });

  it('a stepped face uses the LOWEST vertical chain on x = 0 only', () => {
    // two vertical runs on x = 0 separated by a horizontal step: the lower one is the stop face
    const pts = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 50 }, { x: 0, y: 50 }, { x: 0, y: 40 }, { x: 10, y: 40 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
    expect(deriveFingerParams(pts).stopHeight).toBe(20);
  });

  it('a finger drawn CW derives the same as CCW', () => {
    const cw = steppedFinger().profile.points.slice().reverse();
    expect(deriveFingerParams(cw)).toMatchObject({ stopHeight: 20, bodyDepth: 60, height: 35 });
  });
});

describe('normalizeProfile — degenerate inputs', () => {
  it('non-finite points are dropped with a message', () => {
    const n = normalizeProfile([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 5, y: 5 }, { x: -5, y: 5 }, { x: Infinity, y: 2 }], { kind: 'punch' });
    expect(n.messages.map(m => m.key)).toContain('warnings.tool.profileInvalidPoints');
    expect(n.messages.find(m => m.key === 'warnings.tool.profileInvalidPoints')!.params).toEqual({ count: 2 });
    expect(n.profile.points).toHaveLength(3);
  });

  it('an invalid scale or reference is ignored', () => {
    const ref = normalizeProfile(straightPunch().profile.points, { kind: 'punch' }).profile.points;
    const a = normalizeProfile(straightPunch().profile.points, { kind: 'punch', scale: 0 });
    const b = normalizeProfile(straightPunch().profile.points, { kind: 'punch', scale: NaN, referencePoint: { x: NaN, y: 0 } });
    expect(a.profile.points).toEqual(ref); expect(b.profile.points).toEqual(ref);
  });

  it('an empty list and a single repeated point are reported as too few points', () => {
    expect(normalizeProfile([], { kind: 'die' }).messages[0]!.key).toBe('warnings.tool.profileTooFewPoints');
    expect(normalizeProfile([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], { kind: 'finger' }).messages[0]!.key).toBe('warnings.tool.profileTooFewPoints');
  });

  it('a die drawn upside down with the reference given keeps the reference at the origin', () => {
    const upside = vDie({ vWidth: 16 }).profile.points.map(p => ({ x: p.x + 100, y: -p.y + 200 }));
    const n = normalizeProfile(upside, { kind: 'die', upDir: 'y-', referencePoint: { x: 100, y: 200 } });
    expect(n.shift).toEqual({ x: 0, y: 0 });
    expect(n.messages).toEqual([]);
    const d = deriveDieParams(n.profile.points);
    expect(d.vWidth).toBeCloseTo(16, 3); expect(d.vCentreX).toBeCloseTo(0, 6);
  });
});

describe('createCustom* — frame enforcement', () => {
  it('un-normalised profiles are shifted into the tool frame (punch/die y rule, finger x+y)', () => {
    const p = createCustomPunch(straightPunch().profile.points.map(q => ({ x: q.x, y: q.y + 5 })));
    expect(bounds(p.profile.points).min.y).toBe(0); expect(p.height).toBe(120);
    const d = createCustomDie(vDie({ vWidth: 16 }).profile.points.map(q => ({ x: q.x, y: q.y + 5 })));
    expect(bounds(d.profile.points).max.y).toBe(0); expect(d.height).toBe(60); expect(d.vWidth).toBeCloseTo(16, 3);
    const f = createCustomFinger(flatFinger().profile.points.map(q => ({ x: q.x + 2, y: q.y + 2 })));
    expect(bounds(f.profile.points).min).toEqual({ x: 0, y: 0 }); expect(f.stopHeight).toBe(20);
  });

  it('already-normalised profiles are passed through untouched (same array)', () => {
    const pts = normalizeProfile(gooseneckPunch().profile.points, { kind: 'punch' }).profile.points;
    expect(enforceFrameExtents(pts, 'punch')).toBe(pts);
    const die = vDie({ vWidth: 20 }).profile.points;
    expect(enforceFrameExtents(die, 'die')).toBe(die);
  });

  it('a custom die without a notch becomes a hemming die; meta wins over derivation', () => {
    const flat = createCustomDie([{ x: -30, y: -50 }, { x: 30, y: -50 }, { x: 30, y: 0 }, { x: -30, y: 0 }]);
    expect(flat.family).toBe('hemming'); expect(flat.vWidth).toBe(0); expect(flat.vAngle).toBe(180);
    const forced = createCustomDie(flat.profile, { family: 'u', vWidth: 12, vAngle: 0, id: 'custom:u' });
    expect(forced).toMatchObject({ family: 'u', vWidth: 12, vAngle: 0, id: 'custom:u' });
  });
});

describe('parametric generators stay well-formed for odd parameters', () => {
  it('straight / acute / radius / hemming punches over a sweep', () => {
    for (const tipAngle of [20, 28, 45, 60, 88, 120, 150, 180]) {
      for (const tipRadius of [0, 0.2, 0.8, 3, 10]) {
        for (const height of [30, 67, 120, 170]) {
          for (const bodyWidth of [1, 10, 20, 60]) {
            const p = straightPunch({ tipAngle, tipRadius, height, bodyWidth });
            expectWellFormed(p, `straight a${tipAngle} r${tipRadius} h${height} w${bodyWidth}`);
            expect(p.tipAngle).toBe(tipAngle); expect(p.height).toBe(height);
            expect(p.bodyWidth).toBeCloseTo(bounds(p.profile.points).max.x - bounds(p.profile.points).min.x, 6);
          }
        }
      }
    }
    expectWellFormed(acutePunch({ tipAngle: 26, tipRadius: 0.4, height: 40 }));
    expectWellFormed(radiusPunch({ radius: 25 }));
    expectWellFormed(hemmingPunch({ faceWidth: 5, height: 20 }));
    // nonsense parameters fall back to sane values rather than producing garbage
    expectWellFormed(straightPunch({ tipAngle: -5, tipRadius: -1, height: -10, bodyWidth: NaN }));
    expectWellFormed(hemmingPunch({ faceWidth: 0, height: NaN }));
  });

  it('gooseneck: heights below 45 are clamped; tips that do not fit the nose are clamped', () => {
    for (const height of [10, 20, 45, 60, 120, 170]) {
      const p = gooseneckPunch({ height });
      expectWellFormed(p, `gooseneck h${height}`);
      expect(p.height).toBe(Math.max(45, height));
      expect(p.tangCentreX).toBe(7);
    }
    for (const [tipAngle, tipRadius] of [[20, 0.8], [30, 3], [60, 5], [88, 10], [120, 0.8]] as const) {
      const p = gooseneckPunch({ tipAngle, tipRadius });
      expectWellFormed(p, `gooseneck a${tipAngle} r${tipRadius}`);
      expect(p.tipAngle).toBeGreaterThanOrEqual(28);
      expect(p.tipRadius).toBeLessThanOrEqual(tipRadius);
      const d = derivePunchParams(p.profile.points);
      expect(d.tipAngle, `gooseneck a${tipAngle} r${tipRadius}`).toBeCloseTo(p.tipAngle, 2);
      expect(d.tipRadius, `gooseneck a${tipAngle} r${tipRadius}`).toBeCloseTo(p.tipRadius, 3);
    }
  });

  it('V dies: deep Vs enlarge the height, wide Vs enlarge the body, big fillets are limited', () => {
    for (const vWidth of [2, 6, 16, 50, 100, 200]) {
      for (const vAngle of [30, 60, 88, 120, 179]) {
        for (const shoulderRadius of [0, 0.5, 4, 20]) {
          for (const height of [undefined, 5, 40]) {
            for (const bodyWidth of [undefined, 10, 60]) {
              const d = vDie({ vWidth, vAngle, shoulderRadius, height, bodyWidth });
              const label = `V${vWidth} ${vAngle}° rs${shoulderRadius} h${height} bw${bodyWidth}`;
              expectWellFormed(d, label);
              expect(d.vWidth).toBe(vWidth); expect(d.vAngle).toBe(vAngle);
              expect(d.height, label).toBeGreaterThanOrEqual(vNotchDepth(vWidth, vAngle) + 5 - 1e-9);
              expect(d.bodyWidth, label).toBeGreaterThanOrEqual(2 * shoulderTangentX(vWidth, vAngle, d.shoulderRadius) + 4 - 1e-9);
              expect(d.shoulderRadius, label).toBeLessThanOrEqual(Math.min(shoulderRadius, maxShoulderRadius(vWidth, vAngle)) + 1e-9);
              // the notch derived back from the profile matches what the die claims (faces flatter
              // than ~17° from horizontal, i.e. vAngle > ~145°, read as top surface — documented limit)
              if (vAngle <= 120) {
                const r = deriveDieParams(d.profile.points);
                expect(r.vWidth, label).toBeCloseTo(vWidth, 2);
                expect(r.vAngle, label).toBeCloseTo(vAngle, 2);
              }
            }
          }
        }
      }
    }
    // standard dies are unaffected by the guards
    for (const d of lib.dies) {
      if (d.family !== 'v') continue;
      const again = vDie({ vWidth: d.vWidth, vAngle: d.vAngle });
      expect(again.height).toBe(d.height); expect(again.bodyWidth).toBe(d.bodyWidth); expect(again.shoulderRadius).toBe(d.shoulderRadius);
    }
  });

  it('multi-V blocks grow to fit oversized Vs; hemming dies guard their sizes', () => {
    const big = multiVDie({ vWidths: [16, 22, 35, 100] });
    expectWellFormed(big, 'multi-V with V100');
    expect(big.bodyWidth).toBeGreaterThan(100);
    const deep = multiVDie({ vWidths: [80, 80, 80, 80], size: 90 });
    expectWellFormed(deep, 'multi-V 4×V80');
    expect(deep.height).toBeGreaterThanOrEqual(2 * vNotchDepth(80, 88) + 10);
    for (let a = 0; a < 4; a++) {
      const std = multiVDie({ active: a });
      expect(std.bodyWidth).toBe(90); expect(std.height).toBe(90);
      expectWellFormed(std);
    }
    expectWellFormed(multiVDie({ active: -1 }), 'multi-V active −1');
    expectWellFormed(multiVDie({ vAngle: 30 }), 'multi-V 30°');
    expectWellFormed(hemmingDie({ width: -1, height: 0 }));
    expectWellFormed(hemmingDie({ width: 20, height: 10 }));
  });

  it('fingers: height below the stop height is raised to it; sizes stay consistent', () => {
    const f = flatFinger({ height: 10, stopHeight: 20 });
    expectWellFormed(f);
    expect(f.height).toBe(20); expect(f.stopHeight).toBe(20);
    const s = steppedFinger({ stopHeight: 30, height: 30, stepDepth: 5 });
    expectWellFormed(s);
    expect(deriveFingerParams(s.profile.points).stopHeight).toBe(30);
  });

  it('tipArc: 180° tip degenerates to the origin, tiny and huge radii keep the origin vertex', () => {
    const flat = tipArc(0.8, 90);
    for (const p of flat) { expect(Math.abs(p.x)).toBeLessThan(1e-12); expect(Math.abs(p.y)).toBeLessThan(1e-12); }
    for (const r of [0.01, 0.2, 30]) {
      const arc = tipArc(r, 44);
      expect(arc.some(p => p.x === 0 && p.y === 0)).toBe(true);
      for (const p of arc) expect(Math.hypot(p.x, p.y - r)).toBeCloseTo(r, 9);
      expect(arc.length % 2).toBe(1); // symmetric: the origin is the middle vertex
    }
    expect(tipArc(0, 44)).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('default setup and checks — odd machines and loads', () => {
  it('a 48-inch bed (1219.2 mm) gets a station the pieces can compose exactly, and it validates', () => {
    const inch = { ...machine, bedLength: 1219.2, backgauge: { ...machine.backgauge, zMax: 1219.2 } };
    const setup = defaultToolSetup(lib, inch, 2)!;
    const st = setup.stations[0]!;
    expect(st.zStart).toBe(0);
    expect(st.zEnd).toBeCloseTo(st.segments.reduce((a, b) => a + b, 0), 9);
    expect(st.zEnd).toBeLessThanOrEqual(1219.2);
    expect(st.zEnd).toBeGreaterThan(1200);
    expect(validateSetup(setup, inch, lib)).toEqual([]);
  });

  it('a punch without sectional pieces gets one full-length piece; odd explicit ranges are clamped', () => {
    const solid: Punch = { ...lib.punches[0]!, id: 'custom:solid', segmentLengths: [] };
    const solidLib = { ...lib, punches: [solid] };
    const setup = defaultToolSetup(solidLib, machine, 2)!;
    expect(setup.stations[0]!.segments).toEqual([]);
    expect(setup.stations[0]!.zEnd).toBe(3100);
    expect(validateSetup(setup, machine, solidLib)).toEqual([]);
    const clamped = defaultToolSetup(lib, machine, 2, { zStart: -50, zEnd: 5000 })!;
    expect(clamped.stations[0]!.zStart).toBe(0); expect(clamped.stations[0]!.zEnd).toBe(3100);
    expect(defaultToolSetup(lib, machine, 2, { zStart: 500, zEnd: 500 })).toBeNull();
    expect(defaultToolSetup(lib, machine, 2, { punchId: 'nope' })).toBeNull();
  });

  it('falls back to a die of another angle when no 88° V die exists, never to hemming or multi-V', () => {
    const only85: Die[] = lib.dies.filter(d => d.vAngle === 85 || d.family !== 'v');
    const setup = defaultToolSetup({ punches: lib.punches, dies: only85 }, machine, 2)!;
    expect(setup.stations[0]!.dieId).toBe('std:die-v16-85');
    expect(pickDieForThickness(lib.dies.filter(d => d.family !== 'v'), 2)).toBeUndefined();
    expect(pickDieForThickness(lib.dies, 2, null)!.id).toBe('std:die-v16-88');
    expect(pickDieForThickness(only85, 2, null)!.id).toBe('std:die-v16-85');
    expect(defaultToolSetup({ punches: lib.punches, dies: [hemmingDie()] }, machine, 2)).toBeNull();
  });

  it('segmentsForLength: nothing available, too short, and non-multiples of 5', () => {
    expect(segmentsForLength(100, [])).toEqual([]);
    expect(segmentsForLength(7, [10, 15, 20])).toEqual([]);
    const pieces = [10, 15, 20, 40, 50, 100, 200, 300, 415, 835];
    const segs = segmentsForLength(1003, pieces);
    expect(segs.reduce((a, b) => a + b, 0)).toBe(1000);
    for (const s of segs) expect(pieces).toContain(s);
  });

  it('toolLoadCheck: NaN / Infinity loads fail, negative loads count as zero, unrated tools pass', () => {
    const punch = lib.punches[0]!, die = lib.dies.find(d => d.id === 'std:die-v16-88')!;
    expect(toolLoadCheck(NaN, punch, die).ok).toBe(false);
    expect(toolLoadCheck(Infinity, punch, die)).toMatchObject({ ok: false, percentOfTool: Infinity });
    expect(toolLoadCheck(Infinity, punch, die).message?.key).toBe('warnings.tool.overload');
    expect(toolLoadCheck(-50, punch, die)).toMatchObject({ ok: true, percentOfTool: 0 });
    const unrated = { name: 'x', maxLoadPerMeter: 0 };
    expect(toolLoadCheck(5000, unrated, unrated)).toMatchObject({ ok: true, percentOfTool: 0 });
    expect(toolLoadCheck(Infinity, unrated, unrated).ok).toBe(false);
    // exactly at the rating is OK (not an overload), just above is not
    expect(toolLoadCheck(1000, punch, die).ok).toBe(true);
    expect(toolLoadCheck(1000.01, punch, die).ok).toBe(false);
  });

  it('daylight / stroke with a non-standard stack (multi-V 90 high, radius punch)', () => {
    const die = lib.dies.find(d => d.id === 'std:die-multi-v35')!;
    const punch = lib.punches.find(p => p.id === 'std:punch-radius-r10')!;
    const dl = daylightCheck(machine, punch, die, 100);
    expect(dl).toMatchObject({ ok: true, stack: 270, tipClearance: 150 });
    expect(daylightCheck(machine, punch, die, 131).ok).toBe(false);
    const sc = strokeCheck(machine, punch, die, 40);
    expect(sc.maxRamDepth).toBeCloseTo(50, 9); // TDC clamp 270 → BDC 70 → tip at −50
    expect(sc.ok).toBe(true);
    expect(strokeCheck(machine, punch, die, 50.5).ok).toBe(false);
    // negative ram depths (shallow bends, tip above the die plane) are always reachable
    expect(strokeCheck(machine, punch, die, -2).ok).toBe(true);
  });
});
