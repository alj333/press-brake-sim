/**
 * sim-3d — 2D section view of the machine XY plane: obstacles from machineObstacles at the
 * frame's ramY / fingers and the part silhouette from partSilhouette at the frame's transform.
 * Operator side (−X) on the LEFT, backgauge (+X) on the RIGHT, +Y up. See docs/specs/sim-3d.md §4.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { BendProgram, Machine, ObstacleKind, PartModel, Polygon2, ToolSetup } from '../core/types';
import { machineObstacles } from '../core/machine';
import type { MachineObstacle } from '../core/machine';
import { foldGeometry, partSilhouette } from '../core/part';
import type { SilhouettePiece } from '../core/part';
import { useSimStore, currentFrame } from './store';
import { EMPTY_SETUP, idleFrame, sceneFrameOf, stationCentreZ, stationOf, stepOf, collisionKinds } from './scene';
import type { SceneFrame, SimLibrary } from './scene';
import { withFallback } from './labels';
import type { TranslateFn } from './labels';

export interface SectionViewProps {
  part: PartModel | null;
  program: BendProgram | null;
  machine: Machine;
  library: SimLibrary;
  setup?: ToolSetup | undefined;
  /** Frame to draw; default: the store's current frame (idle preview without keyframes). */
  frame?: SceneFrame | null | undefined;
  /** Section Z (mm); default: the active station's centre, else the bed centre. */
  sectionZ?: number | undefined;
  t?: TranslateFn | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

interface Box2 { minX: number; minY: number; maxX: number; maxY: number }

const FIT_MARGIN = 0.08;
const SHRINK_RATIO = 0.55;

const STYLE: Record<ObstacleKind, { fill: string; stroke: string }> = {
  punch: { fill: '#8b94a3', stroke: '#3d4552' },
  die: { fill: '#8b94a3', stroke: '#3d4552' },
  clamp: { fill: '#b9bfc8', stroke: '#6b7381' },
  ram: { fill: '#c9ced6', stroke: '#7b8494' },
  holder: { fill: '#c9ced6', stroke: '#7b8494' },
  table: { fill: '#d3d7dd', stroke: '#7b8494' },
  finger: { fill: '#9dbbe6', stroke: '#2f5f9e' },
  'backgauge-beam': { fill: '#b7c8e3', stroke: '#2f5f9e' },
  frame: { fill: '#d3d7dd', stroke: '#7b8494' },
  self: { fill: '#f0a24b', stroke: '#8a4b00' },
};

function boxOf(polys: Polygon2[], seed?: Box2): Box2 {
  const b: Box2 = seed ? { ...seed } : { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const poly of polys) for (const p of poly) {
    if (p.x < b.minX) b.minX = p.x; if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x; if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

function expand(b: Box2, f: number): Box2 {
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  return { minX: b.minX - w * f, maxX: b.maxX + w * f, minY: b.minY - h * f, maxY: b.maxY + h * f };
}

function contains(outer: Box2, inner: Box2): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

function area(b: Box2): number { return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY); }

function inZ(zRange: [number, number] | 'full', z: number): boolean {
  return zRange === 'full' || (z >= zRange[0] - 1e-9 && z <= zRange[1] + 1e-9);
}

interface DrawArgs {
  frame: SceneFrame;
  part: PartModel | null;
  program: BendProgram | null;
  machine: Machine;
  setup: ToolSetup;
  library: SimLibrary;
  sectionZ: number;
  t: TranslateFn;
}

/** Required fit window for a frame: die, punch tip band, fingers and the part. */
function requiredBox(obstacles: MachineObstacle[], pieces: SilhouettePiece[], machine: Machine): Box2 {
  let b = boxOf(obstacles.filter(o => o.kind === 'die' || o.kind === 'finger').map(o => o.polygon));
  b = boxOf(pieces.map(p => p.polygon), b);
  if (!Number.isFinite(b.minX)) b = { minX: -100, maxX: 100, minY: -60, maxY: 60 };
  // always show a band above the die for the punch tip and some room in front of the bend line
  b.maxY = Math.max(b.maxY, 0) + 50;
  b.minY = Math.min(b.minY, -machine.table.holderHeight);
  b.minX = Math.min(b.minX, -80);
  b.maxX = Math.max(b.maxX, 80);
  return b;
}

function draw(canvas: HTMLCanvasElement, args: DrawArgs, view: { current: Box2 | null }): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const W = canvas.clientWidth || 300, H = canvas.clientHeight || 200;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, W, H);

  const { frame, part, program, machine, setup, library, sectionZ, t } = args;
  const obstacles = machineObstacles(machine, setup, library, frame.ramY, frame.backgauge).filter(o => o.kind !== 'frame');
  const thickness = part?.flat.thickness ?? 1;
  const pieces: SilhouettePiece[] = part ? partSilhouette(foldGeometry(part, frame.foldState), frame.partTransform, thickness) : [];
  const kinds = collisionKinds(frame.collisions);

  // auto-fit with hysteresis
  const req = requiredBox(obstacles, pieces, machine);
  const cur = view.current;
  if (!cur || !contains(cur, req) || area(req) < SHRINK_RATIO * area(cur)) view.current = expand(req, FIT_MARGIN);
  const box = view.current!;
  const pad = 28;
  const scale = Math.min((W - 2 * pad) / Math.max(1e-6, box.maxX - box.minX), (H - 2 * pad) / Math.max(1e-6, box.maxY - box.minY));
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  const X = (x: number) => W / 2 + (x - cx) * scale;
  const Y = (y: number) => H / 2 - (y - cy) * scale;

  const path = (poly: Polygon2): void => {
    ctx.beginPath();
    poly.forEach((p, i) => { if (i === 0) ctx.moveTo(X(p.x), Y(p.y)); else ctx.lineTo(X(p.x), Y(p.y)); });
    ctx.closePath();
  };

  // die plane and bend line
  ctx.strokeStyle = '#9aa3ad';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(0), 0); ctx.lineTo(X(0), H); ctx.stroke();
  ctx.setLineDash([]);

  // obstacles: big/faint ones first
  const order: ObstacleKind[] = ['table', 'holder', 'ram', 'clamp', 'backgauge-beam', 'die', 'punch', 'finger', 'frame', 'self'];
  const sorted = obstacles.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const o of sorted) {
    const st = STYLE[o.kind];
    const active = inZ(o.zRange, sectionZ);
    const hit = kinds.has(o.kind);
    ctx.globalAlpha = active ? 1 : 0.3;
    path(o.polygon);
    ctx.fillStyle = hit ? 'rgba(214, 59, 59, 0.35)' : st.fill;
    ctx.fill();
    ctx.strokeStyle = hit ? '#d63b3b' : st.stroke;
    ctx.lineWidth = hit ? 2 : 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // part silhouette
  const partHit = frame.collisions.length > 0;
  for (const p of pieces) {
    const active = inZ(p.zRange, sectionZ);
    ctx.globalAlpha = active ? 0.9 : 0.3;
    path(p.polygon);
    ctx.fillStyle = partHit ? 'rgba(214, 59, 59, 0.55)' : p.source.kind === 'bend' ? '#d98c2f' : '#f0a24b';
    ctx.fill();
    ctx.strokeStyle = partHit ? '#d63b3b' : '#8a4b00';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // collision markers
  for (const c of frame.collisions) {
    const x = X(c.location.x), y = Y(c.location.y), r = 6;
    ctx.strokeStyle = c.severity === 'error' ? '#d63b3b' : '#e08a00';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y - r); ctx.stroke();
  }

  // labels
  ctx.fillStyle = '#3d4552';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(`◀ ${t('sim.operator')}`, 8, 6);
  ctx.textAlign = 'right';
  ctx.fillText(`${t('sim.backgauge')} ▶`, W - 8, 6);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';
  ctx.fillText(t('sim.ramY', { y: frame.ramY.toFixed(1) }), W - 8, H - 6);
  ctx.textAlign = 'left';
  const step = stepOf(program, frame);
  const caption = step
    ? `${t('sim.step', { index: step.index + 1, bendId: step.bendId })}${frame.phase ? ' · ' + t(`sim.phase.${frame.phase}`) : ''}`
    : t('sim.idle');
  ctx.fillText(caption, 8, H - 6);
  frame.backgauge.forEach((f, i) => {
    ctx.fillText(t('sim.finger', { index: i + 1, x: f.x.toFixed(1), r: f.r.toFixed(1), z: f.z.toFixed(0) }), 8, H - 6 - 15 * (i + 1));
  });
  // axes
  const ax = 40, ay = H - 40;
  ctx.strokeStyle = '#6b7381'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + 24, ay); ctx.moveTo(ax, ay); ctx.lineTo(ax, ay - 24); ctx.stroke();
  ctx.fillStyle = '#6b7381';
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText('X', ax + 28, ay);
  ctx.textBaseline = 'bottom'; ctx.textAlign = 'center'; ctx.fillText('Y', ax, ay - 26);
}

export function SectionView({ part, program, machine, library, setup, frame, sectionZ, t, className, style }: SectionViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<Box2 | null>(null);
  const storeFrame = useSimStore(currentFrame);
  const effSetup = setup ?? program?.setup ?? EMPTY_SETUP;
  const idle = useMemo(() => idleFrame(part, machine, effSetup, library), [part, machine, effSetup, library]);
  const effFrame: SceneFrame = useMemo(() => frame ?? (storeFrame ? sceneFrameOf(storeFrame) : idle), [frame, storeFrame, idle]);
  const step = stepOf(program, effFrame);
  // section at the active station's centre; idle: the first station (as the viewport frames it), else the bed centre
  const z = sectionZ ?? stationCentreZ(stationOf(effSetup, step) ?? effSetup.stations[0], machine);
  const tt = useMemo(() => withFallback(t), [t]);

  // reset the fit window when the part or program changes
  useEffect(() => { viewRef.current = null; }, [part, program]);

  const drawRef = useRef<() => void>(() => {});
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => draw(canvas, { frame: effFrame, part, program, machine, setup: effSetup, library, sectionZ: z, t: tt }, viewRef);
    drawRef.current = render;
    render();
  }, [effFrame, part, program, machine, effSetup, library, z, tt]);

  // redraw on resize (one observer for the component's lifetime)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="section-view"
      className={className ? `pbsim-section ${className}` : 'pbsim-section'}
      style={{ width: '100%', height: '100%', display: 'block', ...style }}
    />
  );
}
