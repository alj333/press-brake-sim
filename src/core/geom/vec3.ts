/** 3D vector helpers (pure, mm). Imported as a namespace: `import { vec3 } from '../geom'`. */
import type { Vec2, Vec3 } from '../types';

export const EPS = 1e-6;

export function v3(x: number, y: number, z: number): Vec3 { return { x, y, z }; }
export function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function scale(a: Vec3, s: number): Vec3 { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
export function neg(a: Vec3): Vec3 { return { x: -a.x, y: -a.y, z: -a.z }; }
export function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function lengthSq(a: Vec3): number { return a.x * a.x + a.y * a.y + a.z * a.z; }
export function length(a: Vec3): number { return Math.hypot(a.x, a.y, a.z); }
export function dist(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
/** Unit vector; the zero vector is returned unchanged. */
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}
export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
export function equals(a: Vec3, b: Vec3, tol = EPS): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol;
}
export function xy(a: Vec3): Vec2 { return { x: a.x, y: a.y }; }
export function fromXY(p: Vec2, z = 0): Vec3 { return { x: p.x, y: p.y, z }; }
export function midpoint(a: Vec3, b: Vec3): Vec3 { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }; }
/** a·cosθ + (axis × a)·sinθ + axis·(axis·a)(1 − cosθ) — rotation of a vector about a unit axis. */
export function rotateAboutAxis(a: Vec3, axis: Vec3, deg: number): Vec3 {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const k = normalize(axis);
  const kxa = cross(k, a);
  const kd = dot(k, a) * (1 - c);
  return { x: a.x * c + kxa.x * s + k.x * kd, y: a.y * c + kxa.y * s + k.y * kd, z: a.z * c + kxa.z * s + k.z * kd };
}
