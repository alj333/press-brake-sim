/**
 * Backgauge planning from the FOLDED silhouette (ARCHITECTURE "Bend-sequence planner" §4,
 * docs/specs/planner.md §4): contact type, finger R/X, finger Z positions that see a straight,
 * continuous and solid edge, finger-vs-part / die checks.
 */
import type { FingerSetting, FoldedGeometry, GaugeContact, Message, Polygon2, Polygon3, Vec2, Vec3 } from '../types';
import { mat4, vec3, penetrationDepth, pointInPolygon, planeBasis } from '../geom';
import type { SilhouettePiece } from '../part';
import type { BendInfo, PlanContext, StationInfo } from './context';
import type { PlacementDetails } from './placement';

export interface BackgaugeRequest {
  bend: BendInfo;
  station: StationInfo;
  details: PlacementDetails;
  folded: FoldedGeometry;
  pieces: SilhouettePiece[];
}

export interface BackgaugeResult {
  fingers: FingerSetting[];
  contact: GaugeContact;
  /** Gauge distance (finger stop face X), NaN when no contact. */
  contactX: number;
  warnings: Message[];
  hardErrors: number;
}

/** Contact tolerance along X (mm): pieces within this of the max are "the gauged edge". */
const X_TOL = 0.05;
/** Finger positions are searched in this step (mm). */
const Z_STEP = 2.5;
/** Minimum stop-face overlap with the contact (mm). */
const MIN_CONTACT = 3;
const COLLISION_TOL = 0.2;

const round05 = (v: number): number => Math.round(v * 2) / 2;
const round2 = (v: number): number => Math.round(v * 100) / 100;

function polyMaxX(poly: Polygon2): number {
  let m = -Infinity;
  for (const p of poly) if (p.x > m) m = p.x;
  return m;
}

/**
 * Max X of the polygon restricted to y ∈ [y0, y1] (−Infinity when empty): attained at a vertex
 * inside the band or where an edge crosses y = y0 / y = y1.
 */
export function maxXInBand(poly: Polygon2, y0: number, y1: number): number {
  let m = -Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!;
    if (a.y >= y0 - 1e-9 && a.y <= y1 + 1e-9 && a.x > m) m = a.x;
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-12) continue;
    for (const yc of [y0, y1]) {
      const u = (yc - a.y) / dy;
      if (u >= 0 && u <= 1) { const x = a.x + (b.x - a.x) * u; if (x > m) m = x; }
    }
  }
  return m;
}

/** Y extent of the polygon's vertices within X_TOL of its max x. */
function contactExtent(poly: Polygon2, maxX: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) if (p.x >= maxX - X_TOL) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
  return [lo, hi];
}

function translate(poly: Polygon2, dx: number, dy: number): Polygon2 {
  return poly.map(p => ({ x: p.x + dx, y: p.y + dy }));
}

function rectPoly(x0: number, y0: number, x1: number, y1: number): Polygon2 {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

interface RegionInMachine {
  normal: Vec3;
  outline: Vec2[];
  holes: Vec2[][];
  e1: Vec3; e2: Vec3;
  /** A point on the plane. */
  origin: Vec3;
}

function regionInMachine(req: BackgaugeRequest, flangeId: string, regionIndex: number): RegionInMachine | null {
  const fl = req.folded.flanges.find(f => f.flangeId === flangeId);
  const r = fl?.regions[regionIndex];
  if (!fl || !r || r.midSurface.length < 3) return null;
  const T = req.details.placement.transform;
  const normal = vec3.normalize(mat4.applyToDir(T, fl.normal));
  const { e1, e2 } = planeBasis(normal);
  const to2 = (p: Vec3): Vec2 => ({ x: vec3.dot(p, e1), y: vec3.dot(p, e2) });
  const map = (poly: Polygon3): Vec2[] => poly.map(p => to2(mat4.applyToPoint(T, p)));
  return { normal, outline: map(r.midSurface), holes: r.holes.map(map), e1, e2, origin: mat4.applyToPoint(T, r.midSurface[0]!) };
}

/** Is the 3D point (projected onto the region's plane) inside the region and outside its holes? */
function solidAt(rg: RegionInMachine, p: Vec3): boolean {
  const q = { x: vec3.dot(p, rg.e1), y: vec3.dot(p, rg.e2) };
  if (!pointInPolygon(q, rg.outline)) return false;
  for (const h of rg.holes) if (pointInPolygon(q, h)) return false;
  return true;
}

export function planBackgauge(ctx: PlanContext, req: BackgaugeRequest): BackgaugeResult {
  const { machine, finger, t } = ctx;
  const bg = machine.backgauge;
  const warnings: Message[] = [];
  let hardErrors = 0;
  const none = (key: string): BackgaugeResult => {
    warnings.push({ key, severity: 'warning' });
    return { fingers: [], contact: 'none', contactX: NaN, warnings, hardErrors };
  };
  const pieces = req.pieces;
  if (pieces.length === 0) return none('warnings.gauge.noContact');

  // 1. the gauged edge: the pieces reaching the global max X
  const maxXs = pieces.map(p => polyMaxX(p.polygon));
  let contactX = -Infinity;
  for (const m of maxXs) if (m > contactX) contactX = m;
  if (!Number.isFinite(contactX)) return none('warnings.gauge.noContact');
  const edgeIdx: number[] = [];
  pieces.forEach((_, i) => { if (maxXs[i]! >= contactX - X_TOL) edgeIdx.push(i); });
  // the contact piece: prefer flanges, then the largest contact extent
  let top = edgeIdx[0]!;
  for (const i of edgeIdx) {
    const a = pieces[i]!, b = pieces[top]!;
    if (a.source.kind === 'flange' && b.source.kind !== 'flange') { top = i; continue; }
    if (a.source.kind === b.source.kind) {
      const ea = contactExtent(a.polygon, contactX), eb = contactExtent(b.polygon, contactX);
      if (ea[1] - ea[0] > eb[1] - eb[0] + 1e-9) top = i;
    }
  }
  const topPiece = pieces[top]!;
  const [cy0, cy1] = contactExtent(topPiece.polygon, contactX);

  // 2. contact type and R
  let contact: GaugeContact;
  if (topPiece.source.kind === 'bend') contact = 'radius';
  else contact = cy1 - cy0 <= t + 0.5 ? 'cut-edge' : 'flange-face';
  let R: number;
  if (contact === 'flange-face') {
    if (cy0 >= -0.5) R = cy0 + 2;                       // standing wall: above its outer radius
    else if (cy1 <= t + 0.5) R = cy1 - 2 - finger.stopHeight;   // hanging wall
    else R = (cy0 + cy1) / 2 - finger.stopHeight / 2;
  } else {
    R = (cy0 + cy1) / 2 - finger.stopHeight / 2;
  }
  R = round05(R);
  const X = round2(contactX);
  if (contact === 'radius') warnings.push({ key: 'warnings.gauge.radiusContact', severity: 'warning', params: { bendId: req.bend.id } });

  const overlapOk = (r: number): boolean => Math.min(r + finger.stopHeight, cy1) - Math.max(r, cy0) >= Math.min(MIN_CONTACT, cy1 - cy0 + 1e-9) - 1e-9;
  const clamped = Math.min(bg.rMax, Math.max(bg.rMin, R));
  if (clamped !== R) {
    if (!overlapOk(clamped)) {
      warnings.push({ key: 'warnings.gauge.rOutOfRange', severity: 'error', params: { r: R, rMin: bg.rMin, rMax: bg.rMax } });
      hardErrors++;
    }
    R = clamped;
  }

  // finger body vs die / holder (die at the origin, mirrored when mounted reversed)
  const die = req.station.die;
  const dieProfile: Polygon2 = req.station.station.dieFlipped ? die.profile.points.map(p => ({ x: -p.x, y: p.y })).reverse() : die.profile.points;
  const fingerPoly = (x: number, r: number): Polygon2 => translate(finger.profile.points, x, r);
  const holderTop = -die.height;
  const holder = rectPoly(-machine.table.holderWidth / 2, holderTop - machine.table.holderHeight, machine.table.holderWidth / 2, holderTop);
  const hitsDie = (x: number, r: number): boolean => {
    if (x >= die.bodyWidth / 2 + finger.bodyDepth) return false;
    const fp = fingerPoly(x, r);
    return penetrationDepth(fp, dieProfile) > COLLISION_TOL || penetrationDepth(fp, holder) > COLLISION_TOL;
  };
  if (hitsDie(X, R)) {
    const raised = Math.max(R, 0);
    if (raised !== R && !hitsDie(X, raised) && overlapOk(raised)) {
      // the finger skims the die top (R = 0) to reach a short leg: legitimate, but reported and costed
      R = raised;
      warnings.push({ key: 'warnings.gauge.fingerOverDie', severity: 'info', params: { finger: 1, x: X, r: R } });
    } else { warnings.push({ key: 'warnings.gauge.fingerHitsDie', severity: 'error', params: { finger: 1 } }); hardErrors++; }
  }

  if (X < bg.xMin - 1e-9 || X > bg.xMax + 1e-9) {
    warnings.push({ key: 'warnings.gauge.outOfRange', severity: 'error', params: { x: X, xMin: bg.xMin, xMax: bg.xMax } });
    hardErrors++;
  }

  // 3. finger Z positions
  const stopLo = R, stopHi = R + finger.stopHeight;
  let ez0 = Infinity, ez1 = -Infinity;
  for (const i of edgeIdx) { const [a, b] = pieces[i]!.zRange; if (a < ez0) ez0 = a; if (b > ez1) ez1 = b; }
  const w = finger.width;
  const extent = ez1 - ez0;
  const count = Math.max(1, Math.floor(bg.fingerCount));
  const nominal: number[] = extent < 2 * w || count === 1
    ? [(ez0 + ez1) / 2]
    : Array.from({ length: count }, (_, i) => ez0 + (extent * (i + 0.5)) / count);

  // every flange region in machine coordinates (for the solidity check behind the stop face)
  const regions: RegionInMachine[] = [];
  for (const fl of req.folded.flanges) fl.regions.forEach((_, ri) => { const rg = regionInMachine(req, fl.flangeId, ri); if (rg) regions.push(rg); });
  const region = topPiece.source.kind === 'flange' ? regionInMachine(req, topPiece.source.flangeId, topPiece.source.regionIndex) : null;
  const depth = finger.stopHeight;
  /** Sheet material at a machine point: inside a flange region (within the sheet thickness of its plane, outside holes) or a bend zone piece. */
  const materialAt = (p: Vec3): boolean => {
    for (const rg of regions) {
      if (Math.abs(vec3.dot(vec3.sub(p, rg.origin), rg.normal)) > t / 2 + 0.05) continue;
      if (solidAt(rg, p)) return true;
    }
    for (const piece of pieces) {
      if (piece.source.kind !== 'bend' || p.z < piece.zRange[0] - 1e-9 || p.z > piece.zRange[1] + 1e-9) continue;
      if (pointInPolygon({ x: p.x, y: p.y }, piece.polygon)) return true;
    }
    return false;
  };

  const bandPieces = (z0: number, z1: number): SilhouettePiece[] => pieces.filter(p => p.zRange[1] > z0 + 1e-9 && p.zRange[0] < z1 - 1e-9);

  const bandMax = new Map<SilhouettePiece, number>();
  const pieceMaxInBand = (p: SilhouettePiece): number => {
    let v = bandMax.get(p);
    if (v === undefined) { v = maxXInBand(p.polygon, stopLo, stopHi); bandMax.set(p, v); }
    return v;
  };
  const straightAcross = (z0: number, z1: number): boolean => {
    const bp = bandPieces(z0, z1);
    const cuts = new Set<number>([z0, z1]);
    for (const p of bp) { if (p.zRange[0] > z0 && p.zRange[0] < z1) cuts.add(p.zRange[0]); if (p.zRange[1] > z0 && p.zRange[1] < z1) cuts.add(p.zRange[1]); }
    const zs = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < zs.length; i++) {
      const zm = (zs[i]! + zs[i + 1]!) / 2;
      let mx = -Infinity;
      for (const p of bp) {
        if (p.zRange[0] > zm || p.zRange[1] < zm) continue;
        const v = pieceMaxInBand(p);
        if (v > mx) mx = v;
      }
      if (!Number.isFinite(mx) || Math.abs(mx - contactX) > X_TOL) return false;
    }
    return true;
  };

  const solidBehind = (z0: number, z1: number): boolean => {
    if (!region) return true;
    const n = region.normal;
    const flat = Math.abs(n.y) > 0.99, wall = Math.abs(n.x) > 0.99;
    if (!flat && !wall) return true;
    const nz = Math.max(1, Math.round((z1 - z0) / 2.5));
    const dz = (z1 - z0) / nz;
    if (flat) {
      const y = region.origin.y;
      const nx = Math.max(1, Math.round(depth / 2));
      for (let i = 0; i < nx; i++) {
        const x = contactX - (i + 0.5) * (depth / nx);
        for (let j = 0; j < nz; j++) if (!materialAt({ x, y, z: z0 + (j + 0.5) * dz })) return false;
      }
      return true;
    }
    const x = region.origin.x;
    const y0 = Math.max(stopLo, cy0), y1 = Math.min(stopHi, cy1);
    const ny = Math.max(1, Math.round((y1 - y0) / 2));
    for (let i = 0; i < ny; i++) {
      const y = y0 + (i + 0.5) * ((y1 - y0) / ny);
      for (let j = 0; j < nz; j++) if (!materialAt({ x, y, z: z0 + (j + 0.5) * dz })) return false;
    }
    return true;
  };

  const fingerClear = (z0: number, z1: number): boolean => {
    const fp = fingerPoly(X, R);
    for (const p of bandPieces(z0, z1)) if (penetrationDepth(fp, p.polygon) > COLLISION_TOL) return false;
    return true;
  };

  const validAt = (zc: number): boolean => {
    const z0 = zc - w / 2, z1 = zc + w / 2;
    if (z0 < bg.zMin - 1e-9 || z1 > bg.zMax + 1e-9) return false;
    // the contact interval must cover the finger (unless the edge is narrower than the finger)
    const c0 = Math.max(z0, ez0), c1 = Math.min(z1, ez1);
    if (extent >= w - 1e-9 && (c0 > z0 + 1e-6 || c1 < z1 - 1e-6)) return false;
    if (c1 - c0 < Math.min(w, extent) - 1e-6) return false;
    return straightAcross(c0, c1) && solidBehind(c0, c1) && fingerClear(z0, z1);
  };

  const lo = extent < w ? (ez0 + ez1) / 2 : ez0 + w / 2, hi = extent < w ? (ez0 + ez1) / 2 : ez1 - w / 2;
  const candidates = (from: number, limit: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let k = 0; out.length < limit; k++) {
      const offs = k === 0 ? [0] : [k * Z_STEP, -k * Z_STEP];
      let any = false;
      for (const o of offs) {
        const z = Math.min(hi, Math.max(lo, from + o));
        const key = Math.round(z * 1000);
        if (seen.has(key)) continue;
        seen.add(key); any = true;
        if (validAt(z)) out.push(z);
      }
      if (!any || (from + k * Z_STEP > hi && from - k * Z_STEP < lo)) break;
    }
    return out;
  };

  let chosen: number[] = [];
  const clampZ = (z: number): number => Math.min(hi, Math.max(lo, z));
  if (nominal.length === 1) {
    chosen = candidates(nominal[0]!, 1);
  } else if (nominal.every((n, i) => (i === 0 || clampZ(n) - clampZ(nominal[i - 1]!) >= w - 1e-6) && validAt(clampZ(n)))) {
    chosen = nominal.map(clampZ);
  } else {
    const lists = nominal.map(n => candidates(n, 8));
    // pick one position per finger, minimum total displacement, ≥ width apart
    let best: number[] | null = null, bestCost = Infinity;
    const pick = (i: number, acc: number[], cost: number): void => {
      if (cost >= bestCost) return;
      if (i === lists.length) { best = acc.slice(); bestCost = cost; return; }
      for (const z of lists[i]!) {
        if (acc.some(a => Math.abs(a - z) < w - 1e-6)) continue;
        acc.push(z); pick(i + 1, acc, cost + Math.abs(z - nominal[i]!)); acc.pop();
      }
    };
    pick(0, [], 0);
    if (best) chosen = best;
    else {
      const single = candidates((ez0 + ez1) / 2, 1);
      chosen = single;
      if (single.length > 0) warnings.push({ key: 'warnings.gauge.singleFinger', severity: 'warning', params: { bendId: req.bend.id } });
    }
  }
  if (chosen.length === 0) {
    warnings.push({ key: 'warnings.gauge.contactNotStraight', severity: 'warning', params: { bendId: req.bend.id } });
    chosen = nominal.map(z => Math.min(hi, Math.max(lo, z)));
  }
  chosen.forEach((z, i) => {
    const n = nominal.length === chosen.length ? nominal[i]! : (ez0 + ez1) / 2;
    if (Math.abs(z - n) > 0.5 && nominal.length === chosen.length) {
      warnings.push({ key: 'warnings.gauge.fingerMoved', severity: 'info', params: { finger: i + 1, from: round2(n), to: round2(z) } });
    }
  });

  for (const z of chosen) {
    if (z - w / 2 < bg.zMin - 1e-6 || z + w / 2 > bg.zMax + 1e-6) {
      warnings.push({ key: 'warnings.gauge.zOutOfRange', severity: 'error', params: { z: round2(z), zMin: bg.zMin, zMax: bg.zMax } });
      hardErrors++;
      break;
    }
  }
  const fingers: FingerSetting[] = chosen.map(z => ({ x: X, r: R, z: round2(z) }));
  return { fingers, contact, contactX: X, warnings, hardErrors };
}
