/**
 * ui — canvas of the flat pattern: outline, holes, bend zones and bend lines (up = blue,
 * down = orange), selection by click, and a two-click "add bend" mode with snapping to the
 * outline (vertices first, then edges). FLAT y points up on screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { FlatPattern, PartModel, Vec2 } from '../../core/types';
import { useI18n } from '../../i18n';
import { emptyBox, fitBox, growBox, boxValid, pointToSegmentDistance, prepareCanvas, tracePolygon, useElementSize } from './canvas';
import type { Fit } from './canvas';

export interface FlatViewProps {
  flat: FlatPattern | null;
  part?: PartModel | null | undefined;
  selectedBendId?: string | null | undefined;
  onSelectBend?: ((id: string | null) => void) | undefined;
  /** Two-click add-bend mode. */
  addMode?: boolean | undefined;
  onAddBend?: ((p0: Vec2, p1: Vec2) => void) | undefined;
  height?: number | undefined;
  className?: string | undefined;
}

const FLAT_COLORS = {
  sheet: '#dfe4ea',
  sheetStroke: '#3d4552',
  hole: '#f6f7f9',
  up: '#2f6fd1',
  down: '#e07b1a',
  zoneUp: 'rgba(47, 111, 209, 0.14)',
  zoneDown: 'rgba(224, 123, 26, 0.16)',
  selected: '#c8102e',
  snap: '#1f9d55',
} as const;

const SNAP_PX = 10;
const PICK_PX = 8;

function snapToOutline(p: Vec2, flat: FlatPattern, fit: Fit): Vec2 {
  const loops = [flat.outline, ...flat.holes];
  const tolModel = SNAP_PX / fit.scale;
  let best: { d: number; p: Vec2 } | null = null;
  for (const loop of loops) for (const v of loop) {
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d <= tolModel && (!best || d < best.d)) best = { d, p: v };
  }
  if (best) return { x: best.p.x, y: best.p.y };
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      const r = pointToSegmentDistance(p, a, b);
      if (r.dist <= tolModel && (!best || r.dist < best.d)) best = { d: r.dist, p: r.point };
    }
  }
  return best ? best.p : p;
}

export function FlatView({ flat, part, selectedBendId, onSelectBend, addMode, onAddBend, height = 260, className }: FlatViewProps) {
  const { t } = useI18n();
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(wrap);
  const [first, setFirst] = useState<Vec2 | null>(null);
  const [hover, setHover] = useState<Vec2 | null>(null);

  if (!addMode && (first || hover)) { setFirst(null); setHover(null); }   // leaving add mode drops the rubber band

  const fit = useMemo<Fit | null>(() => {
    if (!flat || size.width < 10) return null;
    const box = growBox(emptyBox(), flat.outline);
    for (const b of flat.bends) growBox(box, [b.p0, b.p1]);
    if (!boxValid(box)) return null;
    return fitBox(box, size.width, height, 18);
  }, [flat, size.width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width < 10) return;
    const ctx = prepareCanvas(canvas, size.width, height);
    if (!ctx) return;
    if (!flat || !fit) {
      ctx.fillStyle = '#6b7381';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t('part.noPart'), size.width / 2, height / 2);
      return;
    }
    // sheet with holes (even-odd)
    ctx.beginPath();
    tracePolygon(ctx, flat.outline, fit);
    for (const h of flat.holes) tracePolygon(ctx, h, fit);
    ctx.fillStyle = FLAT_COLORS.sheet;
    ctx.fill('evenodd');
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = FLAT_COLORS.sheetStroke;
    ctx.stroke();
    // bend zones (BA wide) then bend lines
    for (const b of flat.bends) {
      const ba = part?.bendAllowance[b.id];
      const dx = b.p1.x - b.p0.x, dy = b.p1.y - b.p0.y, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const selected = b.id === selectedBendId;
      if (ba && ba > 0) {
        const h = ba / 2;
        const quad: Vec2[] = [
          { x: b.p0.x + nx * h, y: b.p0.y + ny * h }, { x: b.p1.x + nx * h, y: b.p1.y + ny * h },
          { x: b.p1.x - nx * h, y: b.p1.y - ny * h }, { x: b.p0.x - nx * h, y: b.p0.y - ny * h },
        ];
        ctx.beginPath();
        tracePolygon(ctx, quad, fit);
        ctx.fillStyle = b.direction === 'up' ? FLAT_COLORS.zoneUp : FLAT_COLORS.zoneDown;
        ctx.fill();
      }
      const p0 = fit.toPx(b.p0), p1 = fit.toPx(b.p1);
      if (selected) {
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
        ctx.lineWidth = 7;
        ctx.strokeStyle = 'rgba(200, 16, 46, 0.25)';
        ctx.setLineDash([]);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
      ctx.lineWidth = selected ? 2.6 : 1.8;
      ctx.strokeStyle = selected ? FLAT_COLORS.selected : b.direction === 'up' ? FLAT_COLORS.up : FLAT_COLORS.down;
      ctx.setLineDash(b.direction === 'up' ? [] : [7, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      {
        const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
        const label = `${b.id} ${b.direction === 'up' ? '↑' : '↓'} ${Math.round(b.angle * 10) / 10}°`;
        ctx.font = 'bold 11px system-ui, sans-serif';
        const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.fillRect(mx - w / 2, my - 16, w, 14);
        ctx.fillStyle = selected ? FLAT_COLORS.selected : b.direction === 'up' ? FLAT_COLORS.up : FLAT_COLORS.down;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, mx, my - 9);
      }
    }
    // add-bend rubber band
    if (addMode) {
      const a = first ? fit.toPx(first) : null;
      const h = hover ? fit.toPx(hover) : null;
      if (a && h) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(h.x, h.y);
        ctx.strokeStyle = FLAT_COLORS.snap;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const q of [a, h]) {
        if (!q) continue;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = FLAT_COLORS.snap;
        ctx.fill();
      }
    }
    // scale bar
    const mmPer100px = 100 / fit.scale;
    const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(v => v >= mmPer100px * 0.6) ?? 1000;
    const barPx = nice * fit.scale;
    ctx.strokeStyle = '#3d4552';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(10, height - 10); ctx.lineTo(10 + barPx, height - 10);
    ctx.moveTo(10, height - 14); ctx.lineTo(10, height - 6);
    ctx.moveTo(10 + barPx, height - 14); ctx.lineTo(10 + barPx, height - 6);
    ctx.stroke();
    ctx.fillStyle = '#3d4552';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${nice} mm`, 14 + barPx, height - 7);
  }, [flat, part, fit, size.width, height, selectedBendId, addMode, first, hover, t]);

  const modelPoint = (e: MouseEvent<HTMLCanvasElement>): Vec2 | null => {
    if (!fit) return null;
    const r = e.currentTarget.getBoundingClientRect();
    return fit.toModel({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    if (!flat || !fit) return;
    const p = modelPoint(e);
    if (!p) return;
    if (addMode) {
      const s = snapToOutline(p, flat, fit);
      if (!first) { setFirst(s); return; }
      if (Math.hypot(s.x - first.x, s.y - first.y) > 0.5) onAddBend?.(first, s);
      setFirst(null);
      setHover(null);
      return;
    }
    const tol = PICK_PX / fit.scale;
    let best: { id: string; d: number } | null = null;
    for (const b of flat.bends) {
      const d = pointToSegmentDistance(p, b.p0, b.p1).dist;
      if (d <= tol && (!best || d < best.d)) best = { id: b.id, d };
    }
    onSelectBend?.(best ? best.id : null);
  };

  const onMove = (e: MouseEvent<HTMLCanvasElement>): void => {
    if (!addMode || !flat || !fit) return;
    const p = modelPoint(e);
    if (p) setHover(snapToOutline(p, flat, fit));
  };

  return (
    <div ref={wrap} className={className ? `flatview ${className}` : 'flatview'} style={{ height }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height, display: 'block', cursor: addMode ? 'crosshair' : 'pointer' }}
        onClick={onClick}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={t('part.flatView')}
      />
      {addMode && <div className="flatview-hint">{t('part.addBendHint')}</div>}
    </div>
  );
}
