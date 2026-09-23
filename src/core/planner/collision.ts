/**
 * Collision model (ARCHITECTURE "Bend-sequence planner" §3, docs/specs/planner.md §3): the folded
 * part is swept through the bend with `bendPose`; its silhouette pieces (machine XY + Z range)
 * are tested against the machine obstacles active in the same Z range; intended contacts are cut
 * out of the obstacle polygons; the first hit per obstacle kind is reported.
 */
import type { CollisionReport, FingerSetting, ObstacleKind, Polygon2, Vec2 } from '../types';
import { centroid, clipPolygonByHalfPlane, penetrationDepth, pointInPolygon, segmentIntersect } from '../geom';
import { punchTipY } from '../bend';
import { bendPose, isStraightZone, partSilhouette } from '../part';
import type { SilhouettePiece } from '../part';
import type { FoldedGeometry, Mat4 } from '../types';
import { machineObstacles } from '../machine';
import type { MachineObstacle } from '../machine';
import { shoulderTangentX } from '../tools';
import type { BendInfo, PlanContext } from './context';
import type { PlacementDetails } from './placement';
import type { StationAnalysis } from './stations';

/** Penetration threshold (mm). */
export const COLLISION_THRESHOLD = 0.2;
/** Maximum number of sweep samples between f = 0 and f = 1. */
export const MAX_SWEEP_STEPS = 18;

export interface SweepRequest {
  bend: BendInfo;
  station: StationAnalysis;
  details: PlacementDetails;
  doneMask: number;
  fingers: FingerSetting[];
  /** Stop at the first 'error' collision (search mode). */
  stopAtError?: boolean;
  /** Multiplier on sweepStepDeg (coarser sweeps while searching large parts). */
  stepFactor?: number;
  /** Hem-flatten only: fold fraction of the bend reached by the pre-bend (default: the context's HEM_PREBEND fraction). */
  startFraction?: number;
}

/**
 * Pose of the part at fold fraction `f` of `bendId`: `bendPose` for a curved zone, the placement
 * itself while the zone is still straight (θf < 0.01°, e.g. the first sweep sample of a very
 * shallow bend — bendPose would reject the mismatch).
 */
export function poseAtFraction(placement: Mat4, folded: FoldedGeometry, bendId: string, f: number, tipY: number, t: number): Mat4 {
  const zone = folded.bends.find(b => b.bendId === bendId);
  if (!zone || isStraightZone(zone) || !(f > 0)) return placement;
  return bendPose(placement, folded, bendId, f, tipY, t);
}

export interface SweepResult {
  collisions: CollisionReport[];
  /** Max Y of the part over the sweep (mm above the die plane). */
  partHeight: number;
  /** Number of samples evaluated. */
  samples: number;
}

/** Polygon minus the axis-aligned box [x0, x1] × [y0, y1] (infinite bounds allowed), as simple pieces. */
export function cutBox(poly: Polygon2, x0: number, x1: number, y0: number, y1: number): Polygon2[] {
  const out: Polygon2[] = [];
  if (Number.isFinite(x0)) out.push(...clipPolygonByHalfPlane(poly, { x: x0, y: 0 }, { x: -1, y: 0 }));
  if (Number.isFinite(x1)) out.push(...clipPolygonByHalfPlane(poly, { x: x1, y: 0 }, { x: 1, y: 0 }));
  if (Number.isFinite(y0)) out.push(...clipPolygonByHalfPlane(poly, { x: 0, y: y0 }, { x: 0, y: -1 }));
  if (Number.isFinite(y1)) out.push(...clipPolygonByHalfPlane(poly, { x: 0, y: y1 }, { x: 0, y: 1 }));
  return out.filter(p => p.length >= 3);
}

/** Approximate location of the overlap of two polygons: mean of boundary crossings and contained vertices. */
export function overlapLocation(a: Polygon2, b: Polygon2): Vec2 {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i]!, a1 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const hit = segmentIntersect(a0, a1, b[j]!, b[(j + 1) % b.length]!);
      if (hit) { sx += hit.point.x; sy += hit.point.y; n++; }
    }
  }
  for (const p of a) if (pointInPolygon(p, b)) { sx += p.x; sy += p.y; n++; }
  for (const p of b) if (pointInPolygon(p, a)) { sx += p.x; sy += p.y; n++; }
  if (n === 0) { const c = centroid(a); return { x: c.x, y: c.y }; }
  return { x: sx / n, y: sy / n };
}

interface ObstaclePiece {
  kind: ObstacleKind;
  id: string;
  polygon: Polygon2;
  zRange: [number, number] | 'full';
}

function zOverlap(a: [number, number] | 'full', b: [number, number]): [number, number] | null {
  if (a === 'full') return b;
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
  return hi > lo + 1e-9 ? [lo, hi] : null;
}

/** Piece whose projection is exact at every Z of its range (nothing to refine): flat / wall regions, zones with axis ∥ Z. */
function isExactPiece(p: SilhouettePiece, dirZ: number | undefined): boolean {
  if (dirZ === undefined) return true;
  if (p.source.kind === 'flange') return Math.abs(dirZ) < 1e-6 || Math.abs(dirZ) > 1 - 1e-6;
  return Math.abs(dirZ) > 1 - 1e-9;
}

/** Obstacle polygons with the intended contacts cut out, in the tool's local frame (computed once per station). */
interface CutTools {
  /** Punch profile minus the tip zone (local frame: tip at the origin). */
  punch: Polygon2[];
  /** Die profile minus the shoulder zone (die frame). */
  die: Polygon2[] | null;
  /** Finger profile minus the 0.5 mm strip behind the stop face (finger frame). */
  finger: Polygon2[];
}

const cutCache = new WeakMap<PlanContext, Map<string, CutTools>>();

function cutToolsFor(ctx: PlanContext, station: StationAnalysis): CutTools {
  let m = cutCache.get(ctx);
  if (!m) { m = new Map(); cutCache.set(ctx, m); }
  const st = station.station;
  const key = st.station.id;
  let c = m.get(key);
  if (c) return c;
  const die = st.die, punch = st.punch;
  const halfV = die.vWidth > 0 ? die.vWidth / 2 : punch.bodyWidth / 2;
  const prof = st.station.punchFlipped ? punch.profile.points.map(p => ({ x: -p.x, y: p.y })).reverse() : punch.profile.points;
  const dieProf = st.station.dieFlipped ? die.profile.points.map(p => ({ x: -p.x, y: p.y })).reverse() : die.profile.points;
  const xs = die.vWidth > 0 ? shoulderTangentX(die.vWidth, die.vAngle, die.shoulderRadius) + 2 : Infinity;
  c = {
    punch: cutBox(prof, -halfV, halfV, -0.5, Infinity),
    die: Number.isFinite(xs) ? cutBox(dieProf, -xs, xs, -(die.shoulderRadius + 2), Infinity) : null,
    finger: cutBox(ctx.finger.profile.points, -Infinity, 0.5, -Infinity, Infinity),
  };
  m.set(key, c);
  return c;
}

const translate = (poly: Polygon2, dx: number, dy: number): Polygon2 => poly.map(p => ({ x: p.x + dx, y: p.y + dy }));

/**
 * Machine obstacles at a ram position with the intended contacts removed and the station's punch
 * limited to the punch piece's Z range (the tip zone is excluded only along the bend line).
 */
export function obstaclesAt(ctx: PlanContext, station: StationAnalysis, ramY: number, fingers: FingerSetting[], gaugeX: number | null, bendZ: [number, number]): ObstaclePiece[] {
  const st = station.station;
  const raw: MachineObstacle[] = machineObstacles(ctx.machine, ctx.setup, ctx.library, ramY, fingers);
  const cut = cutToolsFor(ctx, station);
  const out: ObstaclePiece[] = [];
  for (const o of raw) {
    if (o.kind === 'punch' && o.id === `punch:${st.station.id}`) {
      const [pz0, pz1] = station.punchZ;
      const a = zOverlap(station.punchZ, bendZ);
      if (a) for (const p of cut.punch) out.push({ kind: o.kind, id: o.id, polygon: translate(p, 0, ramY - st.punch.height), zRange: a });
      if (pz0 < bendZ[0] - 1e-9) out.push({ kind: o.kind, id: o.id, polygon: o.polygon, zRange: [pz0, Math.min(pz1, bendZ[0])] });
      if (pz1 > bendZ[1] + 1e-9) out.push({ kind: o.kind, id: o.id, polygon: o.polygon, zRange: [Math.max(pz0, bendZ[1]), pz1] });
    } else if (o.kind === 'die' && o.id === `die:${st.station.id}` && cut.die) {
      for (const p of cut.die) out.push({ kind: o.kind, id: o.id, polygon: p, zRange: o.zRange });
    } else if (o.kind === 'finger' && gaugeX !== null) {
      const i = Number(o.id.slice('finger:'.length));
      const f = fingers[i];
      if (f) for (const p of cut.finger) out.push({ kind: o.kind, id: o.id, polygon: translate(p, f.x, f.r), zRange: o.zRange });
      else out.push({ kind: o.kind, id: o.id, polygon: o.polygon, zRange: o.zRange });
    } else {
      out.push({ kind: o.kind, id: o.id, polygon: o.polygon, zRange: o.zRange });
    }
  }
  return out;
}

function severityOf(kind: ObstacleKind): 'error' | 'warning' { return kind === 'finger' ? 'warning' : 'error'; }

/** Sweep a bend from f = 0 to the overbend and report the first contact per obstacle kind. */
export function sweepCollisions(ctx: PlanContext, req: SweepRequest): SweepResult {
  const { bend, station, details, doneMask, fingers } = req;
  const t = ctx.t;
  const st = station.station;
  const maths = station.maths;
  const placement = details.placement.transform;
  const reported = new Map<ObstacleKind, CollisionReport>();
  let partHeight = -Infinity;
  const gaugeX = fingers.length > 0 ? fingers[0]!.x : null;
  const retract = ctx.machine.backgauge.retractAtPinch;

  const formAngle = maths.formAngle;
  const formFraction = maths.hemFlatten ? 1 : formAngle / bend.bend.angle;   // fold fraction at φ = 1
  const preBendFraction = req.startFraction ?? ctx.formFraction(bend.index);
  const startPhi = maths.hemFlatten ? (preBendFraction > 0 && preBendFraction < 1 ? preBendFraction : 0.999) : 0;
  const stepDeg = Math.max(0.5, ctx.options.sweepStepDeg) * Math.max(1, req.stepFactor ?? 1);
  const steps = maths.hemFlatten ? 6 : Math.min(MAX_SWEEP_STEPS, Math.max(1, Math.ceil(formAngle / stepDeg)));
  const phis: number[] = [];
  for (let k = 0; k <= steps; k++) phis.push(startPhi + ((1 - startPhi) * k) / steps);
  if (!maths.hemFlatten && maths.overbendAngle > formAngle + 1e-6) phis.push(maths.overbendAngle / formAngle);

  const dirZ = new Map<string, number>();   // flange id → normal z, bend id → axis z (machine frame)
  const mapZ = (m: number[], d: { x: number; y: number; z: number }): number => m[2]! * d.x + m[6]! * d.y + m[10]! * d.z;
  let samples = 0;
  for (const phi of phis) {
    samples++;
    const foldFrac = maths.hemFlatten ? phi : phi * formFraction;
    const state = ctx.foldStateFor(doneMask, bend.index, foldFrac);
    const folded = ctx.folded(state);
    let pose = placement;
    let tipY: number;
    if (maths.hemFlatten) {
      // the flattening punch face descends onto the hem: tip on the part's top
      const sil0 = partSilhouette(folded, placement, t);
      let top = -Infinity;
      for (const p of sil0) for (const v of p.polygon) if (v.y > top) top = v.y;
      tipY = Number.isFinite(top) ? top : 2 * t;
    } else {
      tipY = punchTipY(st.die.vWidth, t, maths.riActual, phi * formAngle, st.die.shoulderRadius, st.die.vAngle);
      pose = poseAtFraction(placement, folded, bend.id, foldFrac, tipY, t);
    }
    const ramY = tipY + st.punch.height;
    const pieces = partSilhouette(folded, pose, t);
    dirZ.clear();
    for (const f of folded.flanges) dirZ.set(`F:${f.flangeId}`, mapZ(pose, f.normal));
    for (const b of folded.bends) dirZ.set(`B:${b.bendId}`, mapZ(pose, b.axisDir));
    for (const p of pieces) for (const v of p.polygon) if (v.y > partHeight) partHeight = v.y;

    const fingersNow: FingerSetting[] = phi > 0 && retract > 0 ? fingers.map(f => ({ ...f, x: f.x + retract })) : fingers;
    const obstacles = obstaclesAt(ctx, station, ramY, fingersNow, phi > 0 && retract > 0 ? null : gaugeX, details.bendZ);

    for (const ob of obstacles) {
      if (reported.has(ob.kind)) continue;
      for (const piece of pieces) {
        const band = zOverlap(ob.zRange, piece.zRange);
        if (!band) continue;
        let depth = penetrationDepth(piece.polygon, ob.polygon);
        if (depth <= COLLISION_THRESHOLD) continue;
        let poly = piece.polygon;
        const dz = piece.source.kind === 'flange' ? dirZ.get(`F:${piece.source.flangeId}`) : dirZ.get(`B:${piece.source.bendId}`);
        if (!isExactPiece(piece, dz)) {
          // refine an oblique piece over the overlap band
          const refined = partSilhouette(folded, pose, t, band).filter(r => JSON.stringify(r.source) === JSON.stringify(piece.source));
          depth = 0; poly = piece.polygon;
          for (const r of refined) { const d = penetrationDepth(r.polygon, ob.polygon); if (d > depth) { depth = d; poly = r.polygon; } }
          if (depth <= COLLISION_THRESHOLD) continue;
        }
        const loc = overlapLocation(poly, ob.polygon);
        const report: CollisionReport = {
          with: ob.kind, atFraction: Math.round(phi * 1000) / 1000, location: { x: loc.x, y: loc.y, z: (band[0] + band[1]) / 2 },
          depth: Math.round(depth * 100) / 100, severity: severityOf(ob.kind),
          message: {
            key: `collisions.${ob.kind}`, severity: severityOf(ob.kind),
            params: { bendId: bend.id, atFraction: Math.round(phi * 100) / 100, depth: Math.round(depth * 100) / 100, x: Math.round(loc.x * 10) / 10, y: Math.round(loc.y * 10) / 10, z: Math.round((band[0] + band[1]) / 2) },
          },
        };
        reported.set(ob.kind, report);
        break;
      }
      if (req.stopAtError && [...reported.values()].some(r => r.severity === 'error')) break;
    }
    if (req.stopAtError && [...reported.values()].some(r => r.severity === 'error')) break;
  }
  const collisions = [...reported.values()].sort((a, b) => a.atFraction - b.atFraction || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return { collisions, partHeight: Number.isFinite(partHeight) ? partHeight : 0, samples };
}
