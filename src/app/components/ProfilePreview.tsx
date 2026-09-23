/**
 * ui — canvas preview of a tool cross-section (CCW Polygon2 in the tool frame, y up): the
 * profile, the frame axes through the origin, optionally highlighted vertices (the detected
 * tip arc) and a marker (the chosen reference point); `onPick` receives clicks in model units.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent } from 'react';
import type { Vec2 } from '../../core/types';
import { emptyBox, fitBox, growBox, boxValid, prepareCanvas, tracePolygon, useElementSize } from './canvas';
import type { Fit } from './canvas';

export interface ProfilePreviewProps {
  points: readonly Vec2[];
  highlight?: readonly number[] | undefined;
  marker?: Vec2 | null | undefined;
  onPick?: ((p: Vec2) => void) | undefined;
  /** Draw the x / y axes through the origin (tool frame). Default true. */
  showFrame?: boolean | undefined;
  /** Include the origin in the fitted box. Default = showFrame. */
  includeOrigin?: boolean | undefined;
  height?: number | undefined;
  label?: string | undefined;
  mirrored?: boolean | undefined;
  className?: string | undefined;
  testId?: string | undefined;
}

export function ProfilePreview({ points, highlight, marker, onPick, showFrame = true, includeOrigin, height = 180, label, mirrored, className, testId }: ProfilePreviewProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(wrap);
  const pts = useMemo(() => (mirrored ? points.map(p => ({ x: -p.x, y: p.y })) : points), [points, mirrored]);

  const fit = useMemo<Fit | null>(() => {
    if (size.width < 10) return null;
    const box = growBox(emptyBox(), pts);
    if (includeOrigin ?? showFrame) growBox(box, [{ x: 0, y: 0 }]);
    if (marker) growBox(box, [marker]);
    if (!boxValid(box)) return null;
    return fitBox(box, size.width, height, 16);
  }, [pts, size.width, height, showFrame, includeOrigin, marker]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width < 10) return;
    const ctx = prepareCanvas(canvas, size.width, height);
    if (!ctx || !fit) return;
    if (showFrame) {
      const o = fit.toPx({ x: 0, y: 0 });
      ctx.strokeStyle = '#b8c0ca';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, o.y); ctx.lineTo(size.width, o.y);
      ctx.moveTo(o.x, 0); ctx.lineTo(o.x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (pts.length >= 2) {
      ctx.beginPath();
      tracePolygon(ctx, pts, fit);
      ctx.fillStyle = 'rgba(89, 99, 111, 0.55)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#2b3340';
      ctx.stroke();
    }
    if (highlight && highlight.length) {
      ctx.fillStyle = '#c8102e';
      for (const i of highlight) {
        const p = pts[i];
        if (!p) continue;
        const q = fit.toPx(p);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (showFrame) {
      const o = fit.toPx({ x: 0, y: 0 });
      ctx.strokeStyle = '#1f9d55';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(o.x - 6, o.y); ctx.lineTo(o.x + 6, o.y);
      ctx.moveTo(o.x, o.y - 6); ctx.lineTo(o.x, o.y + 6);
      ctx.stroke();
    }
    if (marker) {
      const m = fit.toPx(marker);
      ctx.strokeStyle = '#c8102e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 5, 0, Math.PI * 2);
      ctx.moveTo(m.x - 9, m.y); ctx.lineTo(m.x + 9, m.y);
      ctx.moveTo(m.x, m.y - 9); ctx.lineTo(m.x, m.y + 9);
      ctx.stroke();
    }
    if (label) {
      ctx.fillStyle = '#3d4552';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(label, 6, 13);
    }
    // scale
    const mmPer60px = 60 / fit.scale;
    const nice = [0.5, 1, 2, 5, 10, 20, 50, 100].find(v => v >= mmPer60px * 0.6) ?? 100;
    const barPx = nice * fit.scale;
    ctx.strokeStyle = '#3d4552';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(6, height - 8); ctx.lineTo(6 + barPx, height - 8);
    ctx.stroke();
    ctx.fillStyle = '#3d4552';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`${nice} mm`, 9 + barPx, height - 5);
  }, [pts, fit, size.width, height, highlight, marker, showFrame, label]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    if (!onPick || !fit) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = fit.toModel({ x: e.clientX - r.left, y: e.clientY - r.top });
    onPick(mirrored ? { x: -p.x, y: p.y } : p);
  };

  return (
    <div ref={wrap} className={className ? `profile-preview ${className}` : 'profile-preview'} style={{ height }} data-testid={testId}>
      <canvas ref={canvasRef} style={{ width: '100%', height, display: 'block', cursor: onPick ? 'crosshair' : 'default' }} onClick={onClick} role="img" aria-label={label ?? 'profile'} />
    </div>
  );
}
