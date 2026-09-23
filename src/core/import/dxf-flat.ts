/**
 * DXF flat-pattern importer: outline + holes from the closed loops, bend lines from the bend
 * layers (trimmed / extended to the outline), bend notes ("UP 90.00° R 1.00") parsed when
 * present. See docs/specs/import-files.md §2.
 */
import type { FlatPattern, BendLine, BendDirection, ImportResult, Message, Polygon2, Vec2 } from '../types';
import { vec2, ensureCCW, ensureCW, classifyPoint, pointSegmentDistance, pointInPolygon } from '../geom';
import { ImportError, warn, r3 } from './errors';
import {
  parseDxf, chainLoops, isBendLayer, CHAIN_TOL, DEFAULT_KFACTOR,
} from './dxf-common';
import type { DxfLoop, DxfPath, DxfText, DxfUnits, LayerClass } from './dxf-common';

export interface DxfFlatOptions {
  thickness: number;
  materialId: string;
  name: string;
  /** Default bend angle from flat (deg), default 90. */
  defaultAngle?: number;
  /** Default inner radius (mm); default = air-bend rule with V = 8·t (see spec §2.2). */
  defaultRadius?: number;
  /** Default k-factor, default 0.44. */
  kFactor?: number;
  /** Material properties for the default radius rule (mild steel values when absent). */
  material?: { tensileStrength: number; minInnerRadiusFactor: number };
  /** FlatPattern.id, default = name. */
  id?: string;
  /** Drawing units override ('auto' = $INSUNITS, unitless ⇒ mm unless small enough to be inches). */
  units?: 'auto' | DxfUnits;
}

/** Move of a bend-line end below which no warning is issued (mm). */
const SILENT_SNAP = 0.1;
/** Below this length a (trimmed) bend line is dropped. */
const MIN_BEND_LENGTH = 0.01;

/** Default inner radius: the air-bend rule with an unknown V = 8·t (spec §2.2). */
export function defaultInnerRadius(thickness: number, material?: { tensileStrength: number; minInnerRadiusFactor: number }): number {
  const rm = material?.tensileStrength ?? 420;
  const minR = material?.minInnerRadiusFactor ?? 0.8;
  const natural = 0.16 * 8 * thickness * rm / 420;
  return Math.round(Math.max(natural, minR * thickness) * 100) / 100;
}

export function importDxfFlat(text: string, opts: DxfFlatOptions): ImportResult {
  if (!(opts.thickness > 0)) throw new ImportError('errors.import.badThickness', { thickness: opts.thickness });
  const doc = parseDxf(text, { units: opts.units });
  const warnings: Message[] = [...doc.warnings];

  // ── outline & holes ──
  const geometry = doc.paths.filter(p => p.cls === 'geometry' || p.cls === 'outline-hint' || p.cls === 'hole-hint');
  const chained = chainLoops(geometry);
  warnings.push(...chained.warnings);
  const { outline, holes, outlineLayer } = pickOutline(chained.loops, warnings);

  // ── bend lines ──
  const bendPaths = doc.paths.filter(p => isBendLayer(p.cls));
  const bends = buildBendLines(bendPaths, outline, opts, warnings);
  applyBendNotes(doc.texts.filter(t => isBendLayer(t.cls)), bends, doc.scale, warnings);
  if (bends.length === 0) warnings.push(warn('warnings.dxf.noBendLines', undefined, 'info'));

  const bendLayers = [...new Set(bendPaths.map(p => p.layer))];
  const flat: FlatPattern = {
    id: opts.id ?? opts.name,
    name: opts.name,
    thickness: opts.thickness,
    materialId: opts.materialId,
    outline,
    holes,
    bends,
    sourceUnits: doc.units === 'in' ? 'in' : 'mm',
    provenance: {
      file: opts.name,
      format: 'dxf',
      units: doc.units,
      insunits: doc.insunits === undefined ? '' : String(doc.insunits),
      outlineLayer,
      bendLayers: bendLayers.join(','),
      layers: doc.layers.join(','),
    },
    warnings,
  };
  return { flat, warnings };
}

// ─── Outline selection ───────────────────────────────────────────────────────

function pickOutline(loops: DxfLoop[], warnings: Message[]): { outline: Polygon2; holes: Polygon2[]; outlineLayer: string } {
  if (loops.length === 0) throw new ImportError('errors.import.dxfNoOutline');
  const hinted = loops.filter(l => l.cls === 'outline-hint');
  const notHoles = loops.filter(l => l.cls !== 'hole-hint');
  const pool = hinted.length > 0 ? hinted : notHoles.length > 0 ? notHoles : loops;
  let best = pool[0]!;
  for (const l of pool) if (l.area > best.area) best = l;
  const outline = ensureCCW(best.points);
  const holes: Polygon2[] = [];
  for (const l of loops) {
    if (l === best) continue;
    let inside = 0;
    for (const p of l.points) if (pointInPolygon(p, outline, 1e-6)) inside++;
    if (inside * 2 >= l.points.length) holes.push(ensureCW(l.points));
    else warnings.push(warn('warnings.dxf.loopOutsideOutline', { layer: l.layer }));
  }
  return { outline, holes, outlineLayer: best.layer };
}

// ─── Bend lines ──────────────────────────────────────────────────────────────

function buildBendLines(paths: DxfPath[], outline: Polygon2, opts: DxfFlatOptions, warnings: Message[]): BendLine[] {
  const angle = opts.defaultAngle ?? 90;
  const radius = opts.defaultRadius ?? defaultInnerRadius(opts.thickness, opts.material);
  const k = opts.kFactor ?? DEFAULT_KFACTOR;
  const segments: Array<{ p0: Vec2; p1: Vec2; cls: LayerClass }> = [];
  for (const p of paths) {
    const ends = bendSegment(p);
    if (!ends) {
      warnings.push(warn('warnings.dxf.bendEntityIgnored', { type: p.type, layer: p.layer }));
      continue;
    }
    const [p0, p1] = ends;
    if (vec2.dist(p0, p1) < MIN_BEND_LENGTH) continue;
    const dup = segments.some(s =>
      (vec2.dist(s.p0, p0) <= CHAIN_TOL && vec2.dist(s.p1, p1) <= CHAIN_TOL) ||
      (vec2.dist(s.p0, p1) <= CHAIN_TOL && vec2.dist(s.p1, p0) <= CHAIN_TOL));
    if (dup) continue;
    segments.push({ p0, p1, cls: p.cls });
  }
  const bends: BendLine[] = [];
  for (const s of segments) {
    const id = `B${bends.length + 1}`;
    const fitted = fitToOutline(id, s.p0, s.p1, outline, warnings);
    if (!fitted) continue;
    const direction: BendDirection = s.cls === 'bend-down' ? 'down' : 'up';
    bends.push({
      id, p0: fitted.p0, p1: fitted.p1, direction, angle, innerRadius: radius, kFactor: k,
      sources: { geometry: 'dxf', angle: 'default', radius: 'default', direction: 'dxf' },
    });
  }
  return bends;
}

/** The two end points of a straight open path (a LINE, or a collinear polyline); null otherwise. */
function bendSegment(p: DxfPath): [Vec2, Vec2] | null {
  if (p.closed || p.points.length < 2) return null;
  const a = p.points[0]!, b = p.points[p.points.length - 1]!;
  if (p.points.length === 2) return [a, b];
  for (let i = 1; i < p.points.length - 1; i++) {
    if (pointSegmentDistance(p.points[i]!, a, b) > CHAIN_TOL) return null;
  }
  return [a, b];
}

/** Parameters s (along the unit direction e from p0) where the infinite line meets the outline. */
export function lineOutlineCrossings(p0: Vec2, e: Vec2, outline: Polygon2, eps = 1e-9): number[] {
  const out: number[] = [];
  const n = outline.length;
  const sOf = (q: Vec2): number => vec2.dot(vec2.sub(q, p0), e);
  for (let i = 0; i < n; i++) {
    const a = outline[i]!, b = outline[(i + 1) % n]!;
    const da = vec2.cross(e, vec2.sub(a, p0));
    const db = vec2.cross(e, vec2.sub(b, p0));
    if (Math.abs(da) <= eps) out.push(sOf(a));                       // vertex on the line (each vertex once)
    else if (Math.abs(db) > eps && da * db < 0) {
      const t = da / (da - db);
      out.push(sOf(vec2.add(a, vec2.scale(vec2.sub(b, a), t))));
    }
  }
  out.sort((x, y) => x - y);
  const dedup: number[] = [];
  for (const s of out) if (dedup.length === 0 || s - dedup[dedup.length - 1]! > 1e-6) dedup.push(s);
  return dedup;
}

/**
 * Snap both ends to the outline along the line: an end that is not on the boundary (inside the
 * material or outside it, e.g. in a relief slot) moves to the nearest crossing of the line with
 * the outline in either direction — the minimal change that puts the end on the outline; an end
 * on the boundary stays. Returns null when the result is degenerate.
 */
function fitToOutline(id: string, p0: Vec2, p1: Vec2, outline: Polygon2, warnings: Message[]): { p0: Vec2; p1: Vec2 } | null {
  const len = vec2.dist(p0, p1);
  const e = vec2.scale(vec2.sub(p1, p0), 1 / len);
  const crossings = lineOutlineCrossings(p0, e, outline);
  const at = (s: number): Vec2 => vec2.add(p0, vec2.scale(e, s));

  const fitEnd = (s: number, other: number, toward: 1 | -1): number => {
    if (classifyPoint(at(s), outline, 1e-6) === 'edge') return s;
    let best = s, bestD = Infinity;
    for (const c of crossings) {
      const inRange = toward > 0 ? c < other - MIN_BEND_LENGTH : c > other + MIN_BEND_LENGTH;
      if (!inRange) continue;
      const d = Math.abs(c - s);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  };

  const s0 = fitEnd(0, len, 1);
  const s1 = fitEnd(len, s0, -1);
  if (s1 - s0 < MIN_BEND_LENGTH) {
    warnings.push(warn('warnings.dxf.bendDegenerate', { bendId: id }));
    return null;
  }
  report(id, 0, 0, s0, warnings);
  report(id, 1, len, s1, warnings);
  return { p0: s0 === 0 ? p0 : at(s0), p1: s1 === len ? p1 : at(s1) };
}

function report(id: string, end: 0 | 1, from: number, to: number, warnings: Message[]): void {
  const amount = Math.abs(to - from);
  if (amount <= SILENT_SNAP) return;
  const extended = end === 0 ? to < from : to > from;
  warnings.push(warn(extended ? 'warnings.dxf.bendExtended' : 'warnings.dxf.bendTrimmed', { bendId: id, end, amount: r3(amount) }));
}

// ─── Bend notes ──────────────────────────────────────────────────────────────

export interface BendNote { direction?: BendDirection; angle?: number; radius?: number; kFactor?: number }

/** Parse "UP 90.00° R 1.00", "DOWN 45 R2", "A=135 R=1.5 K=0.44" … Returns null when nothing useful. */
export function parseBendNote(raw: string): BendNote | null {
  const text = raw.replace(/(\d),(\d)/g, '$1.$2');
  const note: BendNote = {};
  const dir = /\b(UP|DOWN)\b/i.exec(text);
  if (dir) note.direction = dir[1]!.toUpperCase() === 'UP' ? 'up' : 'down';
  const ang = /(-?\d+(?:\.\d+)?)\s*(?:°|º|˚|DEG(?:REES?)?\b)/i.exec(text) ?? /\bA\s*[=:]\s*(-?\d+(?:\.\d+)?)/i.exec(text);
  if (ang) note.angle = Number(ang[1]);
  else if (dir) {
    const after = /\b(?:UP|DOWN)\b\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i.exec(text);
    if (after) note.angle = Number(after[1]);
  }
  const rad = /\bR\s*[=:]?\s*(\d*\.?\d+)/i.exec(text);
  if (rad) note.radius = Number(rad[1]);
  const k = /\bK\s*[=:]?\s*(\d*\.?\d+)/i.exec(text);
  if (k) note.kFactor = Number(k[1]);
  if (note.angle !== undefined && !(note.angle > 0 && note.angle <= 180)) delete note.angle;
  if (note.radius !== undefined && !(note.radius >= 0)) delete note.radius;
  if (note.kFactor !== undefined && !(note.kFactor > 0 && note.kFactor < 1)) delete note.kFactor;
  if (note.direction === undefined && note.angle === undefined && note.radius === undefined && note.kFactor === undefined) return null;
  return note;
}

/** `scale` = drawing units → mm (a note radius is written in the drawing's units). */
function applyBendNotes(texts: DxfText[], bends: BendLine[], scale: number, warnings: Message[]): void {
  for (const t of texts) {
    const note = parseBendNote(t.text);
    if (!note) continue;
    const maxDist = Math.max(20, 5 * t.height);
    let best: BendLine | null = null, bestD = maxDist;
    for (const b of bends) {
      const d = pointSegmentDistance(t.position, b.p0, b.p1);
      if (d <= bestD) { bestD = d; best = b; }
    }
    if (!best) { warnings.push(warn('warnings.dxf.bendTextUnassigned', { text: t.text })); continue; }
    if (note.angle !== undefined) {
      best.angle = note.angle; best.sources.angle = 'dxf';
      if (note.angle >= 180) best.hem = 'closed';
    }
    if (note.radius !== undefined) { best.innerRadius = note.radius * scale; best.sources.radius = 'dxf'; }
    if (note.kFactor !== undefined) best.kFactor = note.kFactor;
    if (note.direction !== undefined && note.direction !== best.direction) {
      warnings.push(warn('warnings.dxf.bendTextConflict', { bendId: best.id }));
      best.direction = note.direction;
    }
  }
}
