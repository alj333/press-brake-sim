/** 2D vector helpers (pure, mm). Imported as a namespace: `import { vec2 } from '../geom'`. */
import type { Vec2 } from '../types';

export const EPS = 1e-6;

export function v2(x: number, y: number): Vec2 { return { x, y }; }
export function add(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y }; }
export function sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
export function scale(a: Vec2, s: number): Vec2 { return { x: a.x * s, y: a.y * s }; }
export function neg(a: Vec2): Vec2 { return { x: -a.x, y: -a.y }; }
export function dot(a: Vec2, b: Vec2): number { return a.x * b.x + a.y * b.y; }
/** z-component of a × b (positive when b is counter-clockwise from a). */
export function cross(a: Vec2, b: Vec2): number { return a.x * b.y - a.y * b.x; }
export function lengthSq(a: Vec2): number { return a.x * a.x + a.y * a.y; }
export function length(a: Vec2): number { return Math.hypot(a.x, a.y); }
export function distSq(a: Vec2, b: Vec2): number { return lengthSq(sub(a, b)); }
export function dist(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }
/** Unit vector; the zero vector is returned unchanged. */
export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}
/** Rotate +90° (counter-clockwise): the left normal of a direction. */
export function perp(a: Vec2): Vec2 { return { x: -a.y, y: a.x }; }
export function lerp(a: Vec2, b: Vec2, t: number): Vec2 { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
export function equals(a: Vec2, b: Vec2, tol = EPS): boolean { return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol; }
export function rotate(a: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}
/** Angle of the vector in degrees, (-180, 180]. */
export function angleDeg(a: Vec2): number { return (Math.atan2(a.y, a.x) * 180) / Math.PI; }
export function midpoint(a: Vec2, b: Vec2): Vec2 { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
