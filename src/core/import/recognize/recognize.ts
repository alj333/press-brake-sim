/**
 * recognizeSheet: mesh → faces → thickness → bends → reference side → tree → flat pattern.
 * See docs/specs/recognize-3d.md §1.
 */
import type { BendSource, FlatPattern, Mat4, Message, RecognizedSheet, TriangleMesh, Vec3 } from '../../types';
import { vec3 } from '../../geom';
import { buildTopology } from './topology';
import { buildPlanarFace, groupFaces } from './faces';
import type { PlanarFace } from './faces';
import { cylinderFitOk, fitCylinder } from './cylinders';
import { detectThickness } from './thickness';
import { pairCylinders } from './bends';
import type { CylFace } from './bends';
import { buildTree, propagateSides, unfold } from './unfold';
import type { Side, UnfoldResult } from './unfold';
import { issue, round3, roundAngle } from './messages';

export interface RecognizeOptions {
  materialId: string;
  kFactor: number;
  /** Expected sheet thickness (mm); breaks ties between candidate thicknesses. */
  thicknessHint?: number;
  /** FlatPattern id / name (default: mesh.name). */
  name?: string;
}

function rigidTransform(e1: Vec3, e2: Vec3, n: Vec3, t: Vec3): Mat4 {
  return [
    e1.x, e2.x, n.x, 0,
    e1.y, e2.y, n.y, 0,
    e1.z, e2.z, n.z, 0,
    t.x, t.y, t.z, 1,
  ];
}

function emptyResult(name: string, opts: RecognizeOptions, issues: Message[], thickness: number): RecognizedSheet {
  const flat: FlatPattern = {
    id: name, name, thickness, materialId: opts.materialId, outline: [], holes: [], bends: [], sourceUnits: 'mm',
    provenance: { file: name, format: 'mesh' }, warnings: issues,
  };
  return { thickness, bendCount: 0, bends3d: [], faces: [], flat, meshToPart: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], confidence: 0, issues };
}

/** Recognise sheet-metal features of a triangle mesh and unfold it into a FlatPattern. */
export function recognizeSheet(mesh: TriangleMesh, opts: RecognizeOptions): RecognizedSheet {
  const issues: Message[] = [];
  const name = opts.name ?? mesh.name;
  const source: BendSource = mesh.faceGroups && mesh.faceGroups.length > 0 ? 'step' : 'mesh';
  let confidence = 1;

  const topo = buildTopology(mesh);
  if (topo.triCount === 0) {
    issues.push(issue('noPlanarFaces', undefined, 'error'));
    return emptyResult(name, opts, issues, opts.thicknessHint ?? 0);
  }
  if (topo.openEdges > 0 || topo.nonManifoldEdges > 0) {
    issues.push(issue('meshNotClosed', { open: topo.openEdges, nonManifold: topo.nonManifoldEdges }, 'info'));
    confidence -= 0.1;
  }

  const grouping = groupFaces(topo);
  const planar: PlanarFace[] = [];
  const cylinders: CylFace[] = [];
  let nonSheet = 0;
  for (const [id, f] of grouping.faces.entries()) {
    if (f.kind === 'planar') { planar.push(buildPlanarFace(topo, id, f.tris, grouping.faceOf)); continue; }
    const fit = fitCylinder(topo, f.tris);
    if (fit && cylinderFitOk(fit)) cylinders.push({ id, tris: f.tris, fit });
    else nonSheet++;
  }
  if (nonSheet > 0) issues.push(issue('nonSheetFace', { count: nonSheet }, 'info'));
  const planarById = new Map(planar.map(p => [p.id, p]));
  if (planar.length === 0) {
    issues.push(issue('noPlanarFaces', undefined, 'error'));
    return emptyResult(name, opts, issues, opts.thicknessHint ?? 0);
  }

  // thickness
  const th = detectThickness(planar, opts.thicknessHint);
  const thickness = th.thickness;
  if (th.none) {
    issues.push(issue('thicknessUnknown', undefined, opts.thicknessHint ? 'warning' : 'error'));
    confidence -= opts.thicknessHint ? 0.3 : 0.5;
  }

  // bends
  const pairing = pairCylinders(topo, grouping, planarById, cylinders, thickness);
  for (const c of pairing.unpaired) {
    issues.push(issue('unpairedCylinder', { faceId: `C${c.id}`, radius: round3(c.fit.radius) }));
    confidence -= 0.2;
  }
  if (pairing.flangesMissing > 0) {
    issues.push(issue('bendFlangesMissing', { count: pairing.flangesMissing }));
    confidence -= 0.2 * pairing.flangesMissing;
  }

  // reference side and tree: the largest planar face. Faces of (nearly) the same area — the two
  // sides of the largest flange always tie — are all tried: the side reaching the most bends wins,
  // then the side with the most 'up' bends, then the greatest canonical flat signature (so the
  // choice depends on the geometry only, never on the mesh's face order).
  const byArea = planar.slice().sort((a, b) => b.area - a.area);
  const candidates = byArea.filter(f => f.area >= 0.99 * byArea[0]!.area);
  interface Choice { side: Map<number, Side>; tree: ReturnType<typeof buildTree>; issues: Message[]; uf: UnfoldResult; ups: number; signature: string }
  let best: Choice | null = null;
  for (const cand of candidates) {
    const side = propagateSides(cand.id, pairing.bends, planarById);
    const candIssues: Message[] = [];
    const tree = buildTree(cand.id, pairing.bends, side, candIssues);
    const uf = unfold(topo, grouping, planarById, cand.id, tree.order, thickness, opts.kFactor, source, candIssues);
    const ups = tree.order.filter(t => t.direction === 'up').length;
    const signature = uf.bends.map(b => `${b.p0.x.toFixed(2)}:${b.p0.y.toFixed(2)}:${b.direction}`).join('|');
    const choice: Choice = { side, tree, issues: candIssues, uf, ups, signature };
    if (!best || tree.order.length > best.tree.order.length
      || (tree.order.length === best.tree.order.length && (ups > best.ups || (ups === best.ups && signature > best.signature)))) best = choice;
  }
  const { side, tree, uf } = best!;
  issues.push(...best!.issues);
  if (issues.some(m => m.key === 'warnings.recognize.bendCycle')) confidence -= 0.2;
  // sheet faces that neither got a side nor are the back of a face that did = material the flat misses
  let ignored = 0;
  const covered = new Set<number>();
  for (const [a, b] of th.sheetPairs) if (side.has(a) || side.has(b)) { covered.add(a); covered.add(b); }
  for (const id of th.sheetFaces) if (!covered.has(id)) ignored++;
  if (ignored > 0) { issues.push(issue('facesIgnored', { count: ignored })); confidence -= 0.2; }
  if (tree.order.length === 0) issues.push(issue('noBends', undefined, 'info'));
  confidence -= uf.confidencePenalty;

  const faceIdOf = new Map<number, string>();
  tree.faces.forEach((id, i) => faceIdOf.set(id, `F${i + 1}`));
  const faces: RecognizedSheet['faces'] = tree.faces.map(id => {
    const f = planarById.get(id)!;
    return { id: faceIdOf.get(id)!, normal: f.normal, origin: f.origin, outline: f.outline3, holes: f.holes3 };
  });
  const bends3d: RecognizedSheet['bends3d'] = uf.treeIndexOf.map((ti, i) => {
    const tb = tree.order[ti]!;
    // axisDir oriented like FoldedGeometry: a right-hand rotation by +angle about it folds faceB out of
    // faceA's plane into place (maps faceA's normal onto faceB's)
    const nA = planarById.get(tb.parent)!.normal, nB = planarById.get(tb.child)!.normal;
    let axisDir = tb.bend.axisDir;
    if (vec3.dot(vec3.rotateAboutAxis(nA, axisDir, tb.bend.angle), nB) < vec3.dot(vec3.rotateAboutAxis(nA, vec3.neg(axisDir), tb.bend.angle), nB)) axisDir = vec3.neg(axisDir);
    return {
      id: `B${i + 1}`,
      axisPoint: tb.bend.axisPoint, axisDir,
      innerRadius: round3(tb.bend.innerRadius), angle: roundAngle(tb.bend.angle), length: round3(tb.bend.length),
      faceA: faceIdOf.get(tb.parent)!, faceB: faceIdOf.get(tb.child)!,
    };
  });

  const o = uf.origin;
  const meshToPart = rigidTransform(uf.e1, uf.e2, uf.normal, {
    x: -(uf.e1.x * o.x + uf.e1.y * o.y + uf.e1.z * o.z) + uf.shift.x,
    y: -(uf.e2.x * o.x + uf.e2.y * o.y + uf.e2.z * o.z) + uf.shift.y,
    z: -(uf.normal.x * o.x + uf.normal.y * o.y + uf.normal.z * o.z) + thickness / 2,
  });

  const flat: FlatPattern = {
    id: name, name, thickness, materialId: opts.materialId,
    outline: uf.outline, holes: uf.holes, bends: uf.bends, sourceUnits: 'mm',
    provenance: {
      file: mesh.name, format: source === 'step' ? 'step' : 'mesh',
      faces: String(planar.length), cylinders: String(cylinders.length),
    },
    warnings: issues,
  };
  return {
    thickness, bendCount: bends3d.length, bends3d, faces, flat, meshToPart,
    confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)), issues,
  };
}
