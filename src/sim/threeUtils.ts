/**
 * sim-3d — small three.js helpers shared by the scene components (browser only).
 */
import * as THREE from 'three';
import type { Polygon2 } from '../core/types';

/** Extrude a CCW profile polygon (machine XY) along +Z from 0 to `depth`. */
export function profileGeometry(points: Polygon2, depth: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, p.y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(depth, 1e-3), bevelEnabled: false, steps: 1, curveSegments: 1 });
  g.computeBoundingSphere();
  return g;
}

/** Axis-aligned bounds of a polygon. */
export function polygonRect(points: Polygon2): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/** Dispose a geometry when a component unmounts (for useEffect cleanups). */
export function disposeAll(items: Array<{ dispose(): void }>): void {
  for (const it of items) it.dispose();
}
