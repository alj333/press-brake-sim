/**
 * Shared DXF machinery for the flat-pattern and tool-profile importers (pure TS):
 * a raw group-code pre-scan (extrusions dxf-parser drops, LWPOLYLINE vertex ids), parsing with
 * dxf-parser, units, layer classification, entity flattening (LINE, LWPOLYLINE, POLYLINE, ARC,
 * CIRCLE, ELLIPSE, SPLINE, INSERT, TEXT/MTEXT) into 2D paths in mm, and chaining of open segments
 * into closed loops (double-drawn entities removed). See docs/specs/import-files.md §1.
 */
import DxfParser from 'dxf-parser';
import type {
  IDxf, IEntity, IBlock, IPoint, ILineEntity, ILwpolylineEntity, IPolylineEntity, IArcEntity,
  ICircleEntity, IEllipseEntity, ISplineEntity, IInsertEntity, ITextEntity, IMtextEntity,
} from 'dxf-parser';
import type { Vec2, Message } from '../types';
import {
  vec2, arcToPoints, bulgeArcToPoints, arcStepDeg, dedupe, area as polyArea,
  affineMultiply, affineRotation, affineTranslation, affineMirrorX, affineApply, affineIdentity,
} from '../geom';
import type { Affine2 } from '../geom';
import { ImportError, warn, r3 } from './errors';

// ─── Types ───────────────────────────────────────────────────────────────────

export type LayerClass = 'bend-up' | 'bend-down' | 'ignore' | 'outline-hint' | 'hole-hint' | 'geometry';

export type DxfUnits =
  | 'mm' | 'in' | 'ft' | 'cm' | 'm' | 'yd' | 'mil' | 'uin' | 'um' | 'dm' | 'dam' | 'hm' | 'km';

/** A flattened 2D path in mm. */
export interface DxfPath {
  points: Vec2[];
  closed: boolean;
  layer: string;
  cls: LayerClass;
  /** DXF entity type that produced it (LINE, LWPOLYLINE, ARC, …). */
  type: string;
}

/** A TEXT / MTEXT entity (position in mm, formatting stripped). */
export interface DxfText {
  text: string;
  position: Vec2;
  height: number;
  layer: string;
  cls: LayerClass;
}

export interface DxfDocument {
  paths: DxfPath[];
  texts: DxfText[];
  /** Source units and the factor applied to bring the geometry to mm. */
  units: DxfUnits;
  scale: number;
  insunits: number | undefined;
  unitsGuessed: boolean;
  /** Layer names carrying geometry, in order of first appearance. */
  layers: string[];
  warnings: Message[];
}

/** A closed loop assembled from paths (points in mm, winding as drawn). */
export interface DxfLoop {
  points: Vec2[];
  layer: string;
  cls: LayerClass;
  /** |signed area| in mm². */
  area: number;
}

export const CHAIN_TOL = 0.01;       // mm, end-point matching
export const CLOSE_TOL = 0.5;        // mm, max gap closed with a warning
export const CHORD_TOL = 0.05;       // mm, arc flattening
export const DEFAULT_KFACTOR = 0.44;

// ─── Layer classification ────────────────────────────────────────────────────

const BEND_PREFIXES = ['IV_BEND', 'BEND'];
const IGNORE_PREFIXES = [
  'IV_ARC_CENTERS', 'IV_TANGENT', 'IV_FEATURE_PROFILES', 'IV_ALTREP', 'IV_TOOL_CENTER', 'IV_ROLL',
  'IV_UNCONSUMED_SKETCHES', 'DIMENSION', 'TEXT', 'DEFPOINTS', 'NOTES', 'TITLE', 'BORDER',
];
const HOLE_HINT_PREFIXES = ['IV_INTERIOR_PROFILES', 'INTERIOR', 'INNER', 'HOLE', 'CUTOUT', 'CUT_OUT', 'CUT OUT'];
const OUTLINE_HINT_PREFIXES = ['IV_OUTER_PROFILE', 'OUTER', 'OUTLINE', 'CONTOUR', 'CUT', 'PROFILE'];

function hasPrefix(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some(p => name.startsWith(p));
}

/** Case-insensitive prefix classification of a layer name (see spec §1.2). */
export function classifyLayer(layer: string | undefined): LayerClass {
  const name = (layer ?? '0').trim().toUpperCase();
  if (hasPrefix(name, BEND_PREFIXES)) return name.includes('DOWN') ? 'bend-down' : 'bend-up';
  if (hasPrefix(name, IGNORE_PREFIXES)) return 'ignore';
  if (hasPrefix(name, HOLE_HINT_PREFIXES)) return 'hole-hint';
  if (hasPrefix(name, OUTLINE_HINT_PREFIXES)) return 'outline-hint';
  return 'geometry';
}

export function isBendLayer(cls: LayerClass): boolean { return cls === 'bend-up' || cls === 'bend-down'; }

// ─── Units ───────────────────────────────────────────────────────────────────

const INSUNITS: Record<number, { units: DxfUnits; scale: number }> = {
  1: { units: 'in', scale: 25.4 },
  2: { units: 'ft', scale: 304.8 },
  4: { units: 'mm', scale: 1 },
  5: { units: 'cm', scale: 10 },
  6: { units: 'm', scale: 1000 },
  8: { units: 'uin', scale: 2.54e-5 },
  9: { units: 'mil', scale: 0.0254 },
  10: { units: 'yd', scale: 914.4 },
  13: { units: 'um', scale: 1e-3 },
  14: { units: 'dm', scale: 100 },
  15: { units: 'dam', scale: 1e4 },
  16: { units: 'hm', scale: 1e5 },
  17: { units: 'km', scale: 1e6 },
};

/** Max raw extent (drawing units) below which an unitless drawing is taken as inches. */
export const UNITLESS_INCH_EXTENT = 12;

const UNIT_SCALE: Record<DxfUnits, number> = {
  mm: 1, in: 25.4, ft: 304.8, cm: 10, m: 1000, yd: 914.4, mil: 0.0254, uin: 2.54e-5, um: 1e-3, dm: 100, dam: 1e4, hm: 1e5, km: 1e6,
};

export interface ParseDxfOptions {
  /** Force the drawing units instead of reading `$INSUNITS` / guessing (default 'auto'). */
  units?: 'auto' | DxfUnits;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

type ParserCtor = new () => { parseSync(text: string): IDxf | null };

function resolveParser(): ParserCtor {
  // dxf-parser ships a UMD main and an ESM module; interop may wrap the class in `default`.
  const mod: unknown = DxfParser;
  if (typeof mod === 'function') return mod as ParserCtor;
  const inner = (mod as { default?: unknown } | null)?.default;
  if (typeof inner === 'function') return inner as ParserCtor;
  throw new ImportError('errors.import.dxfParse', { detail: 'dxf-parser unavailable' });
}

// ─── Raw pre-scan ────────────────────────────────────────────────────────────
//
// dxf-parser drops two things we need: the extrusion direction (210/220/230) of CIRCLE, ELLIPSE
// and TEXT entities (a mirrored OCS, extrusion (0, 0, −1), is common in CAD exports of mirrored
// parts and moves every circle to the wrong side), and it stops reading LWPOLYLINE vertices at a
// vertex-identifier group (91, AutoCAD 2010+). A cheap walk over the raw group codes collects the
// extrusions per container (ENTITIES / block name) and entity ordinal, and strips the 91 groups.

const EXTRUSION_TYPES: ReadonlySet<string> = new Set(['CIRCLE', 'ELLIPSE', 'TEXT']);

/** Extrusion vectors per `${container}\0${type}`, in entity order within that container. */
type ExtrusionTable = Map<string, Array<{ x: number; y: number; z: number }>>;

const ENTITIES_CONTAINER = 'E';
function blockContainer(name: string): string { return `B:${name}`; }

interface Prescan { text: string; extrusion: ExtrusionTable }

function prescanDxf(text: string): Prescan {
  const lines = text.split(/\r\n|\r|\n/);
  const extrusion: ExtrusionTable = new Map();
  const drop = new Set<number>();               // indices of code lines to remove (with their value line)
  let section = '';
  let container = ENTITIES_CONTAINER;
  let entityType = '';
  let current: { x: number; y: number; z: number } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!, 10);
    if (!Number.isFinite(code)) continue;
    const value = lines[i + 1]!.trim();
    if (code === 0) {
      current = null;
      entityType = value;
      if (value === 'SECTION' || value === 'ENDSEC' || value === 'ENDBLK') {
        if (value !== 'ENDBLK') section = '';
        container = ENTITIES_CONTAINER;
        continue;
      }
      if (EXTRUSION_TYPES.has(value) && (section === 'ENTITIES' || section === 'BLOCKS')) {
        const key = `${container}\0${value}`;
        current = { x: 0, y: 0, z: 1 };
        const list = extrusion.get(key);
        if (list) list.push(current); else extrusion.set(key, [current]);
      }
      continue;
    }
    if (code === 2 && entityType === 'SECTION') { section = value; continue; }
    if (code === 2 && entityType === 'BLOCK') { container = blockContainer(value); continue; }
    if (current) {
      if (code === 210) current.x = Number(value);
      else if (code === 220) current.y = Number(value);
      else if (code === 230) current.z = Number(value);
    } else if (code === 91 && entityType === 'LWPOLYLINE') {
      drop.add(i);
    }
  }
  if (drop.size === 0) return { text, extrusion };
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) { i++; continue; }
    kept.push(lines[i]!);
  }
  return { text: kept.join('\n'), extrusion };
}

function parseRaw(text: string): IDxf {
  let dxf: IDxf | null;
  try {
    const Parser = resolveParser();
    dxf = new Parser().parseSync(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ImportError('errors.import.dxfParse', { detail }, detail);
  }
  if (!dxf || !Array.isArray(dxf.entities)) {
    throw new ImportError('errors.import.dxfParse', { detail: 'no ENTITIES section' }, 'no ENTITIES section');
  }
  return dxf;
}

/**
 * Parse a DXF text into flattened paths and texts in mm.
 * Units: `$INSUNITS` when known; unitless files are mm unless the raw extent ≤ 12 (⇒ inches).
 */
export function parseDxf(text: string, options: ParseDxfOptions = {}): DxfDocument {
  const pre = prescanDxf(text);
  const dxf = parseRaw(pre.text);
  const warnings: Message[] = [];
  const header = dxf.header ?? {};
  const rawIns = header['$INSUNITS'];
  const insunits = typeof rawIns === 'number' ? rawIns : undefined;

  let units: DxfUnits = 'mm';
  let scale = 1;
  const forced = options.units !== undefined && options.units !== 'auto' ? options.units : undefined;
  const unitless = forced === undefined && (insunits === undefined || insunits === 0);
  if (forced !== undefined) {
    units = forced; scale = UNIT_SCALE[forced];
  } else if (!unitless) {
    const u = INSUNITS[insunits!];
    if (u) { units = u.units; scale = u.scale; }
    else warnings.push(warn('warnings.dxf.unitsUnknown', { insunits: insunits! }));
  }

  // First flattening: chord tolerance in raw units for the (provisional) scale.
  let flat = flattenDocument(dxf, CHORD_TOL / scale, pre.extrusion);
  let unitsGuessed = false;
  if (unitless) {
    const ext = rawExtent(flat.paths);
    if (ext > 0 && ext <= UNITLESS_INCH_EXTENT) {
      units = 'in'; scale = 25.4; unitsGuessed = true;
      warnings.push(warn('warnings.dxf.unitsGuessed', { units: 'in' }, 'info'));
      flat = flattenDocument(dxf, CHORD_TOL / scale, pre.extrusion);   // re-flatten at the right chord error
    }
  }
  warnings.push(...flat.warnings);

  const layers: string[] = [];
  const seen = new Set<string>();
  const paths: DxfPath[] = flat.paths.map(p => {
    if (!seen.has(p.layer)) { seen.add(p.layer); layers.push(p.layer); }
    return scale === 1 ? p : { ...p, points: p.points.map(q => ({ x: q.x * scale, y: q.y * scale })) };
  });
  const texts: DxfText[] = flat.texts.map(t => scale === 1 ? t : {
    ...t, position: { x: t.position.x * scale, y: t.position.y * scale }, height: t.height * scale,
  });
  return { paths, texts, units, scale, insunits, unitsGuessed, layers, warnings };
}

function rawExtent(paths: DxfPath[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const q of p.points) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.max(maxX - minX, maxY - minY);
}

// ─── Entity flattening ───────────────────────────────────────────────────────

interface FlatOut { paths: DxfPath[]; texts: DxfText[]; warnings: Message[] }

interface Ctx {
  out: FlatOut;
  blocks: Record<string, IBlock>;
  extrusion: ExtrusionTable;
  nonPlanarWarned: Set<string>;
  missingBlocks: Set<string>;
  splineApproxWarned: boolean;
}

function flattenDocument(dxf: IDxf, chordTol: number, extrusion: ExtrusionTable): FlatOut {
  const ctx: Ctx = {
    out: { paths: [], texts: [], warnings: [] },
    blocks: dxf.blocks ?? {},
    extrusion,
    nonPlanarWarned: new Set(),
    missingBlocks: new Set(),
    splineApproxWarned: false,
  };
  flattenEntities(dxf.entities, ENTITIES_CONTAINER, affineIdentity(), chordTol, undefined, 0, ctx);
  return ctx.out;
}

function pt(p: IPoint | undefined): Vec2 { return { x: p?.x ?? 0, y: p?.y ?? 0 }; }
const RAD2DEG = 180 / Math.PI;

function flattenEntities(entities: IEntity[] | undefined, container: string, xf: Affine2, chordTol: number,
  layerOverride: string | undefined, depth: number, ctx: Ctx): void {
  if (!entities) return;
  // Extrusions dxf-parser drops (CIRCLE / ELLIPSE / TEXT) are looked up by entity ordinal within
  // this container (see prescanDxf); the counters restart for every traversal of a block.
  const ordinals = new Map<string, number>();
  const extrusionOf = (type: string): { x: number; y: number; z: number } => {
    const i = ordinals.get(type) ?? 0;
    ordinals.set(type, i + 1);
    return ctx.extrusion.get(`${container}\0${type}`)?.[i] ?? { x: 0, y: 0, z: 1 };
  };
  for (const e of entities) {
    let layer = e.layer ?? '0';
    if (layerOverride !== undefined && layer === '0') layer = layerOverride;
    const cls = classifyLayer(layer);
    switch (e.type) {
      case 'LINE': {
        const v = (e as ILineEntity).vertices;
        if (v && v.length >= 2) emit([pt(v[0]), pt(v[1])], false, layer, cls, e.type, xf, ctx);
        break;
      }
      case 'LWPOLYLINE': {
        const le = e as ILwpolylineEntity;
        const mirrored = (le.extrusionDirectionZ ?? 1) < 0;
        checkPlanar(le.extrusionDirectionX ?? 0, le.extrusionDirectionY ?? 0, le.extrusionDirectionZ ?? 1, e.type, ctx);
        const verts = (le.vertices ?? []).map(v => ({ p: pt(v), bulge: v.bulge ?? 0 }));
        const { points, closed } = polylinePoints(verts, !!le.shape, chordTol);
        emit(points, closed, layer, cls, e.type, ocs(xf, mirrored), ctx);
        break;
      }
      case 'POLYLINE': {
        const pe = e as IPolylineEntity;
        if (pe.isPolyfaceMesh || pe.is3dPolygonMesh) { nonPlanar(e.type, ctx); break; }
        const ez = pe.extrusionDirection?.z ?? 1;
        checkPlanar(pe.extrusionDirection?.x ?? 0, pe.extrusionDirection?.y ?? 0, ez, e.type, ctx);
        const verts = (pe.vertices ?? []).map(v => ({ p: { x: v.x ?? 0, y: v.y ?? 0 }, bulge: v.bulge ?? 0 }));
        const { points, closed } = polylinePoints(verts, !!pe.shape, chordTol);
        emit(points, closed, layer, cls, e.type, ocs(xf, ez < 0), ctx);
        break;
      }
      case 'ARC': {
        const ae = e as IArcEntity;
        const ez = ae.extrusionDirectionZ ?? 1;
        checkPlanar(ae.extrusionDirectionX ?? 0, ae.extrusionDirectionY ?? 0, ez, e.type, ctx);
        const r = ae.radius ?? 0;
        if (!(r > 0)) break;
        const a0 = (ae.startAngle ?? 0) * RAD2DEG;
        let a1 = (ae.endAngle ?? 0) * RAD2DEG;
        if (Math.abs(a1 - a0) < 1e-9) a1 = a0 + 360;
        const points = arcToPoints(pt(ae.center), r, a0, a1, true, chordTol);
        const full = Math.abs(((a1 - a0) % 360 + 360) % 360) < 1e-9;
        emit(points, full, layer, cls, e.type, ocs(xf, ez < 0), ctx);
        break;
      }
      case 'CIRCLE': {
        const ce = e as ICircleEntity;
        const ex = extrusionOf(e.type);
        checkPlanar(ex.x, ex.y, ex.z, e.type, ctx);
        const r = ce.radius ?? 0;
        if (!(r > 0)) break;
        const points = arcToPoints(pt(ce.center), r, 0, 360, true, chordTol);
        emit(points, true, layer, cls, e.type, ocs(xf, ex.z < 0), ctx);
        break;
      }
      case 'ELLIPSE': {
        const el = e as IEllipseEntity;
        const ex = extrusionOf(e.type);
        checkPlanar(ex.x, ex.y, ex.z, e.type, ctx);
        // ELLIPSE is a WCS entity: centre / major axis are world coordinates, the extrusion only
        // orients the minor axis (N × major), so a −Z extrusion flips the minor axis.
        const points = ellipsePoints(el, chordTol, ex.z < 0 ? -1 : 1);
        if (points) emit(points.points, points.closed, layer, cls, e.type, xf, ctx);
        break;
      }
      case 'SPLINE': {
        const se = e as ISplineEntity;
        const res = splinePoints(se, chordTol);
        if (res.approx && !ctx.splineApproxWarned) {
          ctx.splineApproxWarned = true;
          ctx.out.warnings.push(warn('warnings.dxf.splineApprox'));
        }
        if (res.points.length >= 2) emit(res.points, !!se.closed, layer, cls, e.type, xf, ctx);
        break;
      }
      case 'INSERT': {
        const ie = e as IInsertEntity;
        const ez = ie.extrusionDirection?.z ?? 1;
        checkPlanar(ie.extrusionDirection?.x ?? 0, ie.extrusionDirection?.y ?? 0, ez, e.type, ctx);
        flattenInsert(ie, ocs(xf, ez < 0), chordTol, layer, depth, ctx);
        break;
      }
      case 'TEXT': {
        const te = e as ITextEntity;
        const ex = extrusionOf(e.type);
        checkPlanar(ex.x, ex.y, ex.z, e.type, ctx);
        const text = cleanText(te.text ?? '');
        if (!text) break;
        // Aligned / fitted / justified text is positioned by its second alignment point (11).
        const halign = te.halign ?? 0, valign = te.valign ?? 0;
        let anchor = pt(te.startPoint);
        if (te.endPoint && (halign !== 0 || valign !== 0)) {
          const end = pt(te.endPoint);
          anchor = halign === 3 || halign === 5 ? vec2.midpoint(anchor, end) : end;
        }
        const position = affineApply(ocs(xf, ex.z < 0), anchor);
        ctx.out.texts.push({ text, position, height: (te.textHeight ?? 0) * affineScale(xf), layer, cls });
        break;
      }
      case 'MTEXT': {
        const me = e as IMtextEntity;
        const text = cleanText(me.text ?? '');
        if (text) ctx.out.texts.push({ text, position: affineApply(xf, pt(me.position)), height: (me.height ?? 0) * affineScale(xf), layer, cls });
        break;
      }
      default:
        // POINT, DIMENSION, SOLID, 3DFACE, ATTDEF, … carry no outline geometry.
        break;
    }
  }
}

function emit(points: Vec2[], closed: boolean, layer: string, cls: LayerClass, type: string, xf: Affine2, ctx: Ctx): void {
  const mapped = points.map(p => affineApply(xf, p));
  if (mapped.length < 2) return;
  ctx.out.paths.push({ points: mapped, closed, layer, cls, type });
}

function ocs(xf: Affine2, mirrored: boolean): Affine2 {
  return mirrored ? affineMultiply(xf, affineMirrorX()) : xf;
}

function nonPlanar(type: string, ctx: Ctx): void {
  if (ctx.nonPlanarWarned.has(type)) return;
  ctx.nonPlanarWarned.add(type);
  ctx.out.warnings.push(warn('warnings.dxf.nonPlanar', { type }));
}

function checkPlanar(ex: number, ey: number, ez: number, type: string, ctx: Ctx): void {
  if (Math.abs(ex) > 1e-6 || Math.abs(ey) > 1e-6 || Math.abs(Math.abs(ez) - 1) > 1e-6) nonPlanar(type, ctx);
}

/** Uniform scale factor of an affine map (sqrt |det|). */
function affineScale(m: Affine2): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

function affineScaling(sx: number, sy: number): Affine2 { return [sx, 0, 0, sy, 0, 0]; }

function flattenInsert(ins: IInsertEntity, xf: Affine2, chordTol: number, layer: string, depth: number, ctx: Ctx): void {
  const name = ins.name ?? '';
  const block = ctx.blocks[name];
  if (!block) {
    if (!ctx.missingBlocks.has(name)) {
      ctx.missingBlocks.add(name);
      ctx.out.warnings.push(warn('warnings.dxf.blockMissing', { name }));
    }
    return;
  }
  if (depth > 8) return;
  const sx = ins.xScale ?? 1, sy = ins.yScale ?? 1;
  const rot = ins.rotation ?? 0;
  const pos = pt(ins.position);
  const base = pt(block.position);
  const cols = Math.max(1, ins.columnCount ?? 1), rows = Math.max(1, ins.rowCount ?? 1);
  const cs = ins.columnSpacing ?? 0, rs = ins.rowSpacing ?? 0;
  const childChord = chordTol / Math.max(Math.abs(sx), Math.abs(sy), 1e-9);
  const container = blockContainer(name);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      // world = xf · T(pos) · R(rot) · T(i·cs, j·rs) · S(sx, sy) · T(−base)
      let m = affineMultiply(affineTranslation(pos.x, pos.y), affineRotation(rot));
      m = affineMultiply(m, affineTranslation(i * cs, j * rs));
      m = affineMultiply(m, affineScaling(sx, sy));
      m = affineMultiply(m, affineTranslation(-base.x, -base.y));
      flattenEntities(block.entities, container, affineMultiply(xf, m), childChord, layer, depth + 1, ctx);
    }
  }
}

/** Expand a (LW)POLYLINE vertex list with bulges into points; closed when flagged or first ≈ last. */
function polylinePoints(verts: Array<{ p: Vec2; bulge: number }>, closedFlag: boolean, chordTol: number): { points: Vec2[]; closed: boolean } {
  if (verts.length === 0) return { points: [], closed: false };
  const n = verts.length;
  const closed = closedFlag || (n > 2 && vec2.dist(verts[0]!.p, verts[n - 1]!.p) <= CHAIN_TOL);
  const pts: Vec2[] = [verts[0]!.p];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i]!, b = verts[(i + 1) % n]!;
    if (Math.abs(a.bulge) > 1e-12 && vec2.dist(a.p, b.p) > 1e-9) {
      const arc = bulgeArcToPoints(a.p, b.p, a.bulge, chordTol);
      for (let k = 1; k < arc.length; k++) pts.push(arc[k]!);
    } else {
      pts.push(b.p);
    }
  }
  if (closed && pts.length > 1 && vec2.dist(pts[0]!, pts[pts.length - 1]!) <= 1e-9) pts.pop();
  return { points: pts, closed };
}

function ellipsePoints(el: IEllipseEntity, chordTol: number, minorSign: 1 | -1 = 1): { points: Vec2[]; closed: boolean } | null {
  const c = pt(el.center);
  const M = pt(el.majorAxisEndPoint);
  const rMajor = vec2.length(M);
  if (!(rMajor > 0)) return null;
  const ratio = el.axisRatio ?? 1;
  const minor = vec2.scale(vec2.perp(M), ratio * minorSign);
  let s = el.startAngle ?? 0, e = el.endAngle ?? 2 * Math.PI;
  while (e <= s + 1e-12) e += 2 * Math.PI;
  const sweep = e - s;
  const closed = Math.abs(sweep - 2 * Math.PI) < 1e-9;
  const stepRad = arcStepDeg(rMajor, chordTol) / RAD2DEG;
  const n = Math.max(closed ? 8 : 1, Math.ceil(sweep / stepRad - 1e-9));
  const points: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    if (closed && i === n) break;
    const th = s + (sweep * i) / n;
    points.push(vec2.add(c, vec2.add(vec2.scale(M, Math.cos(th)), vec2.scale(minor, Math.sin(th)))));
  }
  return { points, closed };
}

// ─── Splines (De Boor, non-rational) ─────────────────────────────────────────

function splinePoints(se: ISplineEntity, chordTol: number): { points: Vec2[]; approx: boolean } {
  const ctrl = (se.controlPoints ?? []).map(pt);
  const fit = (se.fitPoints ?? []).map(pt);
  const p = se.degreeOfSplineCurve ?? 3;
  const U = se.knotValues ?? [];
  const n = ctrl.length - 1;
  const validKnots = ctrl.length >= 2 && p >= 1 && U.length === n + p + 2 && n >= p && isNonDecreasing(U);
  if (!validKnots) {
    if (fit.length >= 2) return { points: fit, approx: false };
    return { points: ctrl, approx: ctrl.length >= 2 };
  }
  let polyLen = 0;
  for (let i = 1; i < ctrl.length; i++) polyLen += vec2.dist(ctrl[i]!, ctrl[i - 1]!);
  const spacing = chordTol * 10;                       // ≈ 0.5 mm at the default chord tolerance
  const samples = Math.min(4000, Math.max(16, Math.ceil(polyLen / spacing)));
  const u0 = U[p]!, u1 = U[n + 1]!;
  const raw: Vec2[] = [];
  for (let i = 0; i < samples; i++) {
    const u = u0 + ((u1 - u0) * i) / (samples - 1);
    raw.push(deBoor(u, p, U, ctrl));
  }
  return { points: douglasPeucker(raw, chordTol / 5), approx: false };
}

function isNonDecreasing(a: number[]): boolean {
  for (let i = 1; i < a.length; i++) if (a[i]! < a[i - 1]!) return false;
  return true;
}

function deBoor(u: number, p: number, U: number[], P: Vec2[]): Vec2 {
  const n = P.length - 1;
  // knot span k with U[k] ≤ u < U[k+1]; u at the end of the domain maps to the last span.
  let k: number;
  if (u >= U[n + 1]!) {
    k = n;
    while (k > p && U[k]! >= U[k + 1]!) k--;
  } else {
    k = p;
    while (k < n && u >= U[k + 1]!) k++;
  }
  const d: Vec2[] = [];
  for (let j = 0; j <= p; j++) d.push(P[j + k - p]!);
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = U[i + p - r + 1]! - U[i]!;
      const alpha = den > 0 ? (u - U[i]!) / den : 0;
      d[j] = vec2.lerp(d[j - 1]!, d[j]!, alpha);
    }
  }
  return d[p]!;
}

/** Ramer–Douglas–Peucker polyline simplification (open polyline, keeps end points). */
export function douglasPeucker(points: Vec2[], tol: number): Vec2[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    let best = -1, bestD = tol;
    const pa = points[a]!, pb = points[b]!;
    const ab = vec2.sub(pb, pa);
    const l2 = vec2.lengthSq(ab);
    for (let i = a + 1; i < b; i++) {
      const pi = points[i]!;
      let d: number;
      if (l2 === 0) d = vec2.dist(pi, pa);
      else d = Math.abs(vec2.cross(ab, vec2.sub(pi, pa))) / Math.sqrt(l2);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** Strip MTEXT formatting codes and AutoCAD %% / \U+XXXX escapes. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\P/g, ' ')                        // paragraph
    .replace(/\\~/g, ' ')                        // non-breaking space
    .replace(/\\[ACFHQTWLOKfpXxN][^;]*;/g, '')    // \A1; \fArial|b0|i0; \H2.5; …
    .replace(/\\[LlOoKk]/g, '')                    // underline / overline / strike toggles
    .replace(/[{}]/g, '')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Chaining ────────────────────────────────────────────────────────────────

interface EndRef { path: number; end: 0 | 1 }

/**
 * Assemble closed loops: closed paths as they are, open paths chained end to end (tol), gaps
 * ≤ closeTol closed with a warning, longer chains dropped with a warning.
 */
/** Same polyline within tol, forward or reversed (open paths). */
function samePath(a: Vec2[], b: Vec2[], tol: number): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  let fwd = true, rev = true;
  for (let k = 0; k < n && (fwd || rev); k++) {
    if (fwd && vec2.dist(a[k]!, b[k]!) > tol) fwd = false;
    if (rev && vec2.dist(a[k]!, b[n - 1 - k]!) > tol) rev = false;
  }
  return fwd || rev;
}

/** Same closed loop within tol, up to a cyclic shift and reversal. */
function sameLoop(a: Vec2[], b: Vec2[], tol: number): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  for (let j = 0; j < n; j++) {
    if (vec2.dist(a[0]!, b[j]!) > tol) continue;
    let fwd = true, rev = true;
    for (let k = 1; k < n && (fwd || rev); k++) {
      if (fwd && vec2.dist(a[k]!, b[(j + k) % n]!) > tol) fwd = false;
      if (rev && vec2.dist(a[k]!, b[(j - k + n) % n]!) > tol) rev = false;
    }
    if (fwd || rev) return true;
  }
  return false;
}

export function chainLoops(paths: DxfPath[], tol = CHAIN_TOL, closeTol = CLOSE_TOL): { loops: DxfLoop[]; warnings: Message[] } {
  const warnings: Message[] = [];
  const loops: DxfLoop[] = [];
  let tiny = 0, duplicates = 0;
  const pushLoop = (points: Vec2[], layer: string, cls: LayerClass): void => {
    const pts = dedupe(points, tol);
    if (pts.length < 3) { tiny++; return; }
    const a = polyArea(pts);
    if (a < 1e-6) { tiny++; return; }
    // a double-drawn closed entity (two identical circles …) would become two identical holes
    for (const l of loops) {
      if (l.points.length === pts.length && Math.abs(l.area - a) <= 1e-6 * Math.max(1, a) && sameLoop(l.points, pts, tol)) { duplicates++; return; }
    }
    loops.push({ points: pts, layer, cls, area: a });
  };

  const open: DxfPath[] = [];
  for (const p of paths) {
    if (p.closed) pushLoop(p.points, p.layer, p.cls);
    else if (p.points.length >= 2) open.push(p);
  }

  // Spatial hash of open-path end points.
  const cell = (v: number): number => Math.floor(v / tol);
  const key = (p: Vec2): string => `${cell(p.x)},${cell(p.y)}`;
  const index = new Map<string, EndRef[]>();
  const endPoint = (ref: EndRef): Vec2 => {
    const pts = open[ref.path]!.points;
    return ref.end === 0 ? pts[0]! : pts[pts.length - 1]!;
  };
  for (let i = 0; i < open.length; i++) {
    for (const end of [0, 1] as const) {
      const k = key(endPoint({ path: i, end }));
      const list = index.get(k);
      if (list) list.push({ path: i, end }); else index.set(k, [{ path: i, end }]);
    }
  }
  const used = new Uint8Array(open.length);
  const forEachNear = (p: Vec2, fn: (ref: EndRef, d: number) => void): void => {
    const cx = cell(p.x), cy = cell(p.y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = index.get(`${cx + dx},${cy + dy}`);
      if (!list) continue;
      for (const ref of list) {
        if (used[ref.path]) continue;
        const d = vec2.dist(p, endPoint(ref));
        if (d <= tol) fn(ref, d);
      }
    }
  };
  // Exact duplicates (double-drawn entities, forward or reversed) would hijack the chain at their
  // shared end points and leave the true continuation dangling: drop them up front.
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    const pts = open[i]!.points;
    forEachNear(pts[0]!, ref => {
      if (ref.path > i && samePath(pts, open[ref.path]!.points, tol)) { used[ref.path] = 1; duplicates++; }
    });
  }
  // Nearest unused end point; at a junction (several ends within tol) a path of the same layer
  // class as the chain wins, so a stray construction line touching the outline cannot hijack it.
  const findNear = (p: Vec2, cls: LayerClass): EndRef | null => {
    let best: EndRef | null = null, bestD = Infinity, bestSame = false;
    forEachNear(p, (ref, d) => {
      const same = open[ref.path]!.cls === cls;
      if ((same && !bestSame) || (same === bestSame && d < bestD)) { bestD = d; best = ref; bestSame = same; }
    });
    return best;
  };

  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const start = open[i]!;
    let chain = start.points.slice();
    let hint = start.cls === 'outline-hint';
    const layers = [start.layer];
    let closed = false;
    // grow at the tail
    for (;;) {
      const tail = chain[chain.length - 1]!;
      if (chain.length > 2 && vec2.dist(chain[0]!, tail) <= tol) { closed = true; break; }
      const ref = findNear(tail, start.cls);
      if (!ref) break;
      used[ref.path] = 1;
      const p = open[ref.path]!;
      const pts = ref.end === 0 ? p.points : p.points.slice().reverse();
      for (let k = 1; k < pts.length; k++) chain.push(pts[k]!);
      if (p.cls === 'outline-hint') hint = true;
      layers.push(p.layer);
    }
    // grow at the head
    if (!closed) {
      for (;;) {
        const head = chain[0]!;
        if (chain.length > 2 && vec2.dist(head, chain[chain.length - 1]!) <= tol) { closed = true; break; }
        const ref = findNear(head, start.cls);
        if (!ref) break;
        used[ref.path] = 1;
        const p = open[ref.path]!;
        const pts = ref.end === 1 ? p.points : p.points.slice().reverse();   // ends at the head
        const prefix = pts.slice(0, pts.length - 1);
        chain = prefix.concat(chain);
        if (p.cls === 'outline-hint') hint = true;
        layers.push(p.layer);
      }
    }
    const gap = vec2.dist(chain[0]!, chain[chain.length - 1]!);
    if (!closed && chain.length > 2 && gap <= closeTol) {
      closed = true;
      warnings.push(warn('warnings.dxf.loopClosed', { gap: r3(gap) }));
    }
    if (!closed) {
      let length = 0;
      for (let k = 1; k < chain.length; k++) length += vec2.dist(chain[k]!, chain[k - 1]!);
      warnings.push(warn('warnings.dxf.openChain', { length: r3(length), gap: r3(gap), layer: start.layer }));
      continue;
    }
    pushLoop(chain, layers[0]!, hint ? 'outline-hint' : start.cls);
  }
  if (tiny > 0) warnings.push(warn('warnings.dxf.tinyLoopDropped', { count: tiny }));
  if (duplicates > 0) warnings.push(warn('warnings.dxf.duplicateEntities', { count: duplicates }, 'info'));
  return { loops, warnings };
}

/**
 * Decode DXF bytes: UTF-8 (BOM tolerated) when the bytes are valid UTF-8, otherwise the ANSI
 * code page most DXF writers use (windows-1252 — e.g. a "°" byte 0xB0 in a bend note).
 */
export function decodeDxfText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}
