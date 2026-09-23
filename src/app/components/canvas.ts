/** ui — shared canvas helpers: DPR-aware sizing and a 2D "fit" transform (y up). */
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { Vec2 } from '../../core/types';

export interface Box2 { minX: number; minY: number; maxX: number; maxY: number }

export function emptyBox(): Box2 {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function growBox(b: Box2, pts: readonly Vec2[]): Box2 {
  for (const p of pts) {
    if (p.x < b.minX) b.minX = p.x; if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x; if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

export function boxValid(b: Box2): boolean {
  return Number.isFinite(b.minX) && Number.isFinite(b.maxX) && Number.isFinite(b.minY) && Number.isFinite(b.maxY);
}

/** Maps model (x right, y up) to canvas pixels (y down) with uniform scale. */
export interface Fit {
  scale: number;
  ox: number;
  oy: number;
  toPx(p: Vec2): Vec2;
  toModel(px: Vec2): Vec2;
}

export function fitBox(box: Box2, width: number, height: number, margin = 14): Fit {
  const w = Math.max(box.maxX - box.minX, 1e-6), h = Math.max(box.maxY - box.minY, 1e-6);
  const scale = Math.max(1e-9, Math.min((width - 2 * margin) / w, (height - 2 * margin) / h));
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  const ox = width / 2 - cx * scale;
  const oy = height / 2 + cy * scale;
  return {
    scale, ox, oy,
    toPx: p => ({ x: ox + p.x * scale, y: oy - p.y * scale }),
    toModel: px => ({ x: (px.x - ox) / scale, y: (oy - px.y) / scale }),
  };
}

/** Observed CSS size of an element (0 × 0 before layout). */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => {
      const r = el.getBoundingClientRect();
      setSize(prev => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Prepare a canvas for drawing at the device pixel ratio; returns the 2D context scaled to CSS px. */
export function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const pw = Math.max(1, Math.round(width * dpr)), ph = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

export function tracePolygon(ctx: CanvasRenderingContext2D, poly: readonly Vec2[], fit: Fit): void {
  poly.forEach((p, i) => {
    const q = fit.toPx(p);
    if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
  });
  ctx.closePath();
}

export function pointToSegmentDistance(p: Vec2, a: Vec2, b: Vec2): { dist: number; point: Vec2 } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let u = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const q = { x: a.x + u * dx, y: a.y + u * dy };
  return { dist: Math.hypot(p.x - q.x, p.y - q.y), point: q };
}
