import { describe, it, expect } from 'vitest';
import * as mat4 from './mat4';
import * as vec3 from './vec3';
import * as vec2 from './vec2';

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

describe('vec2 / vec3', () => {
  it('basic ops', () => {
    expect(vec2.cross({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    expect(vec2.perp({ x: 1, y: 0 })).toEqual({ x: -0, y: 1 });
    const r = vec2.rotate({ x: 1, y: 0 }, 90);
    expect(near(r.x, 0)).toBe(true); expect(near(r.y, 1)).toBe(true);
    expect(vec3.cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 0, z: 1 });
    const q = vec3.rotateAboutAxis({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 90);
    expect(vec3.equals(q, { x: 0, y: 1, z: 0 }, 1e-12)).toBe(true);
    expect(vec3.length(vec3.normalize({ x: 3, y: 4, z: 12 }))).toBeCloseTo(1, 12);
  });
});

describe('mat4', () => {
  it('identity / translation / apply', () => {
    const t = mat4.translation({ x: 1, y: 2, z: 3 });
    expect(mat4.applyToPoint(t, { x: 1, y: 1, z: 1 })).toEqual({ x: 2, y: 3, z: 4 });
    expect(mat4.applyToDir(t, { x: 1, y: 1, z: 1 })).toEqual({ x: 1, y: 1, z: 1 });
    expect(t[12]).toBe(1); expect(t[13]).toBe(2); expect(t[14]).toBe(3);
  });

  it('fromAxisAngle follows the right-hand rule and the three.js layout', () => {
    const rz = mat4.fromAxisAngle({ x: 0, y: 0, z: 1 }, 90);
    const p = mat4.applyToPoint(rz, { x: 1, y: 0, z: 0 });
    expect(vec3.equals(p, { x: 0, y: 1, z: 0 }, 1e-12)).toBe(true);
    // column 0 is the image of x̂: elements [0..2]
    expect(near(rz[0]!, 0)).toBe(true); expect(near(rz[1]!, 1)).toBe(true);
    const ry = mat4.fromAxisAngle({ x: 0, y: 1, z: 0 }, 90);
    expect(vec3.equals(mat4.applyToPoint(ry, { x: 0, y: 0, z: 1 }), { x: 1, y: 0, z: 0 }, 1e-12)).toBe(true);
    const rx = mat4.fromAxisAngle({ x: 1, y: 0, z: 0 }, 90);
    expect(vec3.equals(mat4.applyToPoint(rx, { x: 0, y: 1, z: 0 }), { x: 0, y: 0, z: 1 }, 1e-12)).toBe(true);
  });

  it('rotationAxisAngle rotates about a point and multiply composes right-to-left', () => {
    const r = mat4.rotationAxisAngle({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 90);
    expect(vec3.equals(mat4.applyToPoint(r, { x: 1, y: 0, z: 0 }), { x: 1, y: 0, z: 0 }, 1e-12)).toBe(true);
    expect(vec3.equals(mat4.applyToPoint(r, { x: 2, y: 0, z: 0 }), { x: 1, y: 1, z: 0 }, 1e-12)).toBe(true);
    const t = mat4.translation({ x: 5, y: 0, z: 0 });
    const rz = mat4.fromAxisAngle({ x: 0, y: 0, z: 1 }, 90);
    // multiply(t, rz): rotate first then translate
    const p = mat4.applyToPoint(mat4.multiply(t, rz), { x: 1, y: 0, z: 0 });
    expect(vec3.equals(p, { x: 5, y: 1, z: 0 }, 1e-12)).toBe(true);
    const q = mat4.applyToPoint(mat4.multiply(rz, t), { x: 1, y: 0, z: 0 });
    expect(vec3.equals(q, { x: 0, y: 6, z: 0 }, 1e-12)).toBe(true);
  });

  it('invert', () => {
    const m = mat4.multiply(mat4.translation({ x: 3, y: -2, z: 7 }), mat4.rotationAxisAngle({ x: 1, y: 2, z: 3 }, { x: 1, y: 1, z: 0 }, 37));
    const inv = mat4.invert(m);
    expect(mat4.equals(mat4.multiply(m, inv), mat4.identity(), 1e-10)).toBe(true);
    expect(() => mat4.invert(mat4.scaling(0, 1, 1))).toThrow();
  });

  it('decompose / compose round-trip', () => {
    const m = mat4.multiply(mat4.translation({ x: 3, y: -2, z: 7 }), mat4.fromAxisAngle({ x: 1, y: 1, z: 0 }, 130));
    const d = mat4.decompose(m);
    expect(vec3.equals(d.position, { x: 3, y: -2, z: 7 }, 1e-12)).toBe(true);
    expect(vec3.equals(d.scale, { x: 1, y: 1, z: 1 }, 1e-12)).toBe(true);
    const [x, y, z, w] = d.quaternion;
    expect(near(Math.hypot(x, y, z, w), 1, 1e-12)).toBe(true);
    // rotation about (1,1,0)/√2 by 130°: q = (axis·sin65, cos65)
    const s = Math.sin((65 * Math.PI) / 180) / Math.SQRT2;
    expect(near(x, s, 1e-12)).toBe(true); expect(near(y, s, 1e-12)).toBe(true); expect(near(z, 0, 1e-12)).toBe(true);
    expect(near(w, Math.cos((65 * Math.PI) / 180), 1e-12)).toBe(true);
    expect(mat4.equals(mat4.compose(d.position, d.quaternion, d.scale), m, 1e-12)).toBe(true);
    // all four quaternion branches
    for (const [axis, deg] of [[{ x: 1, y: 0, z: 0 }, 180], [{ x: 0, y: 1, z: 0 }, 180], [{ x: 0, y: 0, z: 1 }, 180], [{ x: 0.3, y: -0.5, z: 0.8 }, 200]] as const) {
      const r = mat4.fromAxisAngle(axis, deg);
      const dd = mat4.decompose(r);
      expect(mat4.equals(mat4.compose(dd.position, dd.quaternion, dd.scale), r, 1e-12)).toBe(true);
    }
    // mirror → negative scale.x
    const mir = mat4.scaling(-1, 1, 1);
    expect(mat4.decompose(mir).scale.x).toBe(-1);
  });
});
