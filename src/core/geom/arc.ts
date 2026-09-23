/** Arc flattening (chord-error driven), pure. */
import type { Vec2 } from '../types';
import { sub, add, scale, perp, length, midpoint } from './vec2';

const DEG = Math.PI / 180;

/** Max angular step (deg) so the chord error stays ≤ chordTol; capped to 90°. */
export function arcStepDeg(r: number, chordTol = 0.05): number {
  if (!(r > 0) || chordTol >= r) return 90;
  const step = (2 * Math.acos(1 - chordTol / r)) / DEG;
  return Math.min(90, Math.max(step, 1e-3));
}

/**
 * Points along a circular arc from a0 to a1 (degrees), inclusive of both ends.
 * Sweep is normalised to (0, 360]: a1 = a0 + 360 gives a full circle (first point repeated at
 * the end), a0 = a1 gives a single point.
 */
export function arcToPoints(center: Vec2, r: number, a0Deg: number, a1Deg: number, ccw: boolean, chordTol = 0.05): Vec2[] {
  const at = (deg: number): Vec2 => ({ x: center.x + r * Math.cos(deg * DEG), y: center.y + r * Math.sin(deg * DEG) });
  const rawSweep = ccw ? a1Deg - a0Deg : a0Deg - a1Deg;
  let sweep = ((rawSweep % 360) + 360) % 360;
  if (sweep === 0) {
    if (rawSweep === 0) return [at(a0Deg)];
    sweep = 360;
  }
  let n = Math.max(1, Math.ceil(sweep / arcStepDeg(r, chordTol) - 1e-9));
  if (sweep >= 360 - 1e-9) n = Math.max(n, 8);
  const pts: Vec2[] = [];
  const sign = ccw ? 1 : -1;
  for (let i = 0; i <= n; i++) pts.push(at(a0Deg + (sign * sweep * i) / n));
  return pts;
}

/**
 * DXF bulge arc from p0 to p1 (bulge = tan(θ/4); > 0 ⇒ counter-clockwise), inclusive of both
 * ends. bulge = 0 ⇒ [p0, p1].
 */
export function bulgeArcToPoints(p0: Vec2, p1: Vec2, bulge: number, chordTol = 0.05): Vec2[] {
  const chord = sub(p1, p0);
  const c = length(chord);
  if (c < 1e-12) return [p0];
  if (Math.abs(bulge) < 1e-12) return [p0, p1];
  const theta = 4 * Math.atan(bulge);                 // signed included angle (rad)
  const alpha = Math.abs(theta) / 2;
  const r = c / (2 * Math.sin(alpha));
  const dCentre = (c / 2) / Math.tan(alpha);          // signed distance of the centre from the chord midpoint (negative for > 180°)
  const n = scale(perp(chord), 1 / c);                // left normal of the chord
  const m = midpoint(p0, p1);
  const centre = add(m, scale(n, Math.sign(bulge) * dCentre));
  const a0 = Math.atan2(p0.y - centre.y, p0.x - centre.x) / DEG;
  const a1 = a0 + theta / DEG;
  const pts = arcToPoints(centre, r, a0, a1, bulge > 0, chordTol);
  pts[0] = p0;
  pts[pts.length - 1] = p1;
  return pts;
}
