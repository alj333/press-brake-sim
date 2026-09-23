import { describe, it, expect } from 'vitest';
import { loadTruth, SAMPLE_NAMES } from '../testing/fixtures';
import type { BendLine, FlatPattern, FoldedGeometry, Mat4, PartModel, Polygon2, Vec3 } from '../types';
import { mat4, vec3, area, bounds, isCCW, centroid } from '../geom';
import { punchTipY } from '../bend';
import { buildPartModel } from './build';
import { foldGeometry, flatState, finishedState, derivePart } from './fold';
import { bendPose } from './pose';
import { partSilhouette } from './silhouette';
import { zoneCentrePoint, isStraightZone } from './zone';
import { flangeExtentFromBend } from './extent';
import { bendFrame, regionsSideOfBend } from './frame';

const src = { geometry: 'user', angle: 'user', radius: 'user', direction: 'user' } as const;
const bend = (id: string, p0: [number, number], p1: [number, number], direction: 'up' | 'down' = 'up', angle = 90, ri = 2, k = 0.44): BendLine =>
  ({ id, p0: { x: p0[0], y: p0[1] }, p1: { x: p1[0], y: p1[1] }, direction, angle, innerRadius: ri, kFactor: k, sources: src });
const rect = (w: number, h: number): Polygon2 => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const flatOf = (outline: Polygon2, bends: BendLine[], holes: Polygon2[] = [], t = 2): FlatPattern =>
  ({ id: 'e', name: 'e', thickness: t, materialId: 'std:mild-steel', outline, holes, bends });
const circle = (cx: number, cy: number, r: number, n = 24): Polygon2 =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(-2 * Math.PI * i / n), y: cy + r * Math.sin(-2 * Math.PI * i / n) }));
const BA90 = (Math.PI / 2) * (2 + 0.44 * 2); // 4.5239 for t2 ri2 k0.44

/**
 * Planner-style placement PART → MACHINE for `bendId` from the folded geometry BEFORE the bend
 * (this bend at 0): bend line on Z at X = 0, lower face on Y = 0, d·n → +Y, child toward ±X.
 */
function placementFromFolded(part: PartModel, folded: FoldedGeometry, bendId: string, childToPlusX: boolean): Mat4 {
  const b = folded.bends.find(x => x.bendId === bendId)!;
  const bl = part.flat.bends.find(x => x.id === bendId)!;
  const sigma = bl.direction === 'up' ? 1 : -1;
  const t = part.flat.thickness;
  const c = vec3.add(vec3.midpoint(b.startEdge[0], b.startEdge[1]), vec3.scale(b.tangent, b.zoneWidth / 2)); // bend line centre
  const Y = vec3.scale(b.toCentre, sigma);                       // straight zone: toCentre = parent +w
  let Zm = vec3.normalize(vec3.sub(b.startEdge[1], b.startEdge[0]));
  let X = vec3.cross(Y, Zm);
  if ((vec3.dot(X, b.tangent) > 0) !== childToPlusX) { Zm = vec3.neg(Zm); X = vec3.cross(Y, Zm); }
  const R: Mat4 = [X.x, Y.x, Zm.x, 0, X.y, Y.y, Zm.y, 0, X.z, Y.z, Zm.z, 0, 0, 0, 0, 1];
  const rc = mat4.applyToDir(R, c);
  R[12] = -rc.x; R[13] = -rc.y + t / 2; R[14] = -rc.z;
  return R;
}

describe('buildPartModel — bend lines that do not exactly span the part', () => {
  it('a bend line short of the outline by up to 0.1 mm behaves as if it reached it', () => {
    for (const gap of [1e-6, 1e-4, 0.005, 0.05, 0.099]) {
      const part = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, gap], [50, 50 - gap])]));
      expect(part.warnings, `gap ${gap}`).toEqual([]);
      expect(part.flanges.length, `gap ${gap}`).toBe(2);
      for (const f of part.flanges) {
        expect(f.regions.length, `gap ${gap}`).toBe(1);
        expect(f.regions[0]!.polygon.length, `gap ${gap}: seam vertices simplified`).toBe(4);
      }
      expect(part.links.length).toBe(1);
      const total = part.flanges.reduce((s, f) => s + f.area, 0);
      expect(total).toBeCloseTo(5000 - BA90 * 50, 1);
      const folded = foldGeometry(part, finishedState(part));
      const child = folded.flanges.find(f => f.flangeId !== part.rootFlangeId)!;
      expect(Math.abs(child.normal.z)).toBeLessThan(1e-9);
    }
  });

  it('a bend line extending beyond the outline gives the same model as the exact one', () => {
    const exact = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, 0], [50, 50])]));
    const long = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, -7], [50, 61])]));
    expect(long.warnings).toEqual([]);
    expect(long.flanges.map(f => f.area)).toEqual(exact.flanges.map(f => f.area));
    expect(long.links).toEqual(exact.links);
    for (const f of long.flanges) expect(f.regions[0]!.polygon.length).toBe(4);
  });

  it('a bend line ending inside the material: one flange with the strip as a hole, specific warnings, a flat zone', () => {
    const part = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, 10], [50, 40])]));
    expect(part.flanges.length).toBe(1);
    expect(part.links).toEqual([]);
    const root = part.flanges[0]!;
    expect(root.regions.length).toBe(1);
    expect(root.regions[0]!.polygon.length).toBe(4);
    expect(root.regions[0]!.holes.length).toBe(1);
    expect(area(root.regions[0]!.holes[0]!)).toBeCloseTo(BA90 * 30, 6);
    expect(root.area).toBeCloseTo(5000 - BA90 * 30, 6);
    const keys = part.warnings.map(w => w.key);
    expect(keys.filter(k => k === 'warnings.part.bendEndInMaterial').length).toBe(2);
    expect(keys).not.toContain('warnings.part.bendCycle');
    expect(part.warnings[0]!.params).toEqual({ bendId: 'B1', end: 0, gap: 10 });
    // the zone material is still there for rendering: a straight strip attached to the root, at any state
    for (const state of [flatState(part), finishedState(part), { B1: 0.5 }]) {
      const folded = foldGeometry(part, state);
      expect(folded.bends.length).toBe(1);
      const z = folded.bends[0]!;
      expect(z.bendId).toBe('B1');
      expect(isStraightZone(z)).toBe(true);
      expect(z.zoneWidth).toBeCloseTo(BA90, 12);
      expect(Math.abs(z.startEdge[0]!.x - 50) + z.zoneWidth / 2).toBeCloseTo(BA90 / 2 + BA90 / 2, 9);
      expect(folded.flanges[0]!.transform).toEqual(mat4.identity());
    }
    // one end only inside the material (relief on the other end) is reported for that end alone
    const one = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, 0], [50, 40])]));
    expect(one.warnings.filter(w => w.key === 'warnings.part.bendEndInMaterial').map(w => w.params?.end)).toEqual([1]);
  });

  it('a bend line drawn across relief slots (CAD style) links a parent whose centroid is beyond the bend line', () => {
    // plate with two arms reaching past the tab; tab x ∈ [12, 50] × [11, 19]; relief slots x ∈ [8, 50] cut
    // through the zone band x ∈ [8, 12]; bend line x = 10 drawn across the slots (10 long for an 8 wide tab)
    const outline: Polygon2 = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 10 }, { x: 8, y: 10 }, { x: 8, y: 11 }, { x: 50, y: 11 },
      { x: 50, y: 19 }, { x: 8, y: 19 }, { x: 8, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 30 }, { x: 0, y: 30 }];
    const b = bend('B1', [10, 10], [10, 20], 'up', 90, 1.12, 0.44);  // BA = π/2·2 ≈ 3.1416? use ri so that BA/2 = 2 exactly below
    b.innerRadius = 4 / (Math.PI / 2) - 0.88;                          // BA = 4 → zone x ∈ [8, 12]
    const part = buildPartModel(flatOf(outline, [b]));
    expect(part.bendAllowance['B1']).toBeCloseTo(4, 12);
    expect(part.warnings).toEqual([]);
    expect(part.flanges.length).toBe(2);
    const root = part.flanges.find(f => f.id === part.rootFlangeId)!;
    expect(root.area).toBeCloseTo(50 * 30 - 42 * 10, 9);
    expect(root.regions.length).toBe(1);
    expect(root.regions[0]!.polygon.length).toBe(8); // slot ends and the zone edge merge into one x = 8 edge
    const tab = part.flanges.find(f => f.id !== part.rootFlangeId)!;
    expect(tab.area).toBeCloseTo(38 * 8, 9);
    expect(part.links).toEqual([{ bendId: 'B1', parentFlangeId: root.id, childFlangeId: tab.id }]);
    // the plate's centroid is on the tab's side of the bend line, yet it is adjacent on the other side
    const frame = bendFrame(b, 4);
    const c = centroid(root.regions[0]!.polygon);
    expect(c.x).toBeGreaterThan(10);
    expect(regionsSideOfBend(root.regions.map(r => r.polygon), frame)).toBe(1);
    expect(regionsSideOfBend(tab.regions.map(r => r.polygon), frame)).toBe(-1);
    // extents: the plate reaches 40 mm past the bend line on the far side
    const ext = flangeExtentFromBend(part, root.id, 'B1');
    expect(ext.max).toBeCloseTo(10, 9);
    expect(ext.min).toBeCloseTo(-40, 9);
    const te = flangeExtentFromBend(part, tab.id, 'B1');
    expect(te.min).toBeCloseTo(2, 9); expect(te.max).toBeCloseTo(40, 9);
    // folding: the tab rises toward +w, the plate (with its arms) stays flat
    const folded = foldGeometry(part, finishedState(part));
    const tabF = folded.flanges.find(f => f.flangeId === tab.id)!;
    expect(tabF.regions[0]!.midSurface.every(p => p.z > 2)).toBe(true);
    expect(folded.flanges.find(f => f.flangeId === root.id)!.regions[0]!.midSurface.every(p => p.z === 0)).toBe(true);
  });

  it('holes crossing artificial seams are kept; a hole inside the removed strip is dropped', () => {
    const tab = loadTruth('tabbed-plate').flat;
    const withSeamHole = buildPartModel({ ...tab, holes: [circle(20, 25, 4), circle(60, 55, 3), ...tab.holes] });
    expect(withSeamHole.warnings).toEqual([]);
    const root = withSeamHole.flanges.find(f => f.id === withSeamHole.rootFlangeId)!;
    expect(root.regions.length).toBe(1);
    expect(root.regions[0]!.holes.length).toBe(3);
    for (const h of root.regions[0]!.holes) expect(isCCW(h)).toBe(false);
    // a hole inside a bend-inside-material strip island is not attached to the surrounding region
    const island = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, 10], [50, 40])], [circle(50, 25, 1)]));
    expect(island.warnings.some(w => w.key === 'warnings.part.holeDropped')).toBe(true);
    expect(island.flanges[0]!.regions[0]!.holes.length).toBe(1); // the strip only
    // a 4-vertex slot across the zone of a relieved tab: its vertices all lie in the (U-shaped) root,
    // but its edges cross the region boundary → dropped, never attached to the wrong region
    const slotted = buildPartModel({ ...tab, holes: [[{ x: 116, y: 20 }, { x: 116, y: 60 }, { x: 119.5, y: 60 }, { x: 119.5, y: 20 }]] });
    expect(slotted.warnings.map(w => w.key)).toEqual(['warnings.part.holeDropped']);
    expect(slotted.flanges.every(f => f.regions.every(r => r.holes.length === 0))).toBe(true);
  });

  it('every sample flange is a single polygon after merging, with the box root a plain rectangle', () => {
    for (const name of SAMPLE_NAMES) {
      const part = buildPartModel(loadTruth(name).flat);
      for (const f of part.flanges) {
        expect(f.regions.length, `${name} ${f.id}`).toBe(1);
        expect(isCCW(f.regions[0]!.polygon)).toBe(true);
      }
    }
    const box = buildPartModel(loadTruth('box-4-flange').flat);
    const root = box.flanges.find(f => f.id === box.rootFlangeId)!;
    expect(root.regions[0]!.polygon.length).toBe(4);
    for (const f of box.flanges) expect(f.regions[0]!.polygon.length).toBe(4);
  });

  it('two separate pieces on one side: warning, the larger is linked, the other is disconnected', () => {
    const outline: Polygon2 = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 51, y: 20 }, { x: 51, y: 28 }, { x: 100, y: 28 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const part = buildPartModel(flatOf(outline, [bend('B1', [50, 0], [50, 50])]));
    expect(part.flanges.length).toBe(3);
    expect(part.warnings.map(w => w.key)).toEqual(['warnings.part.multipleFlangesOnSide', 'warnings.part.flangeDisconnected']);
    expect(part.warnings[0]!.params).toEqual({ bendId: 'B1', side: '-', count: 2 });
    expect(part.links.length).toBe(1);
    const child = part.flanges.find(f => f.id === part.links[0]!.childFlangeId)!;
    expect(child.area).toBeCloseTo(22 * (50 - BA90 / 2), 6);
    const loose = part.flanges.find(f => f.id !== part.rootFlangeId && f.id !== child.id)!;
    expect(loose.area).toBeCloseTo(20 * (50 - BA90 / 2), 6);
    const folded = foldGeometry(part, finishedState(part));
    expect(folded.flanges.find(f => f.flangeId === loose.id)!.transform).toEqual(mat4.identity());
    expect(folded.bends.length).toBe(1);
  });

  it('invalid bend inputs never destroy the outline', () => {
    const nan = buildPartModel(flatOf(rect(100, 50), [{ ...bend('B1', [50, 0], [50, 50]), innerRadius: NaN }]));
    expect(nan.flanges.length).toBe(1);
    expect(nan.flanges[0]!.area).toBeCloseTo(5000, 9);
    expect(Number.isNaN(nan.bendAllowance['B1'])).toBe(true);
    expect(nan.warnings.filter(w => w.key === 'warnings.part.bendNoMaterial').length).toBe(2);
    expect(foldGeometry(nan, finishedState(nan)).bends.length).toBe(0);
    const badPt = buildPartModel(flatOf(rect(100, 50), [bend('B1', [NaN, 0], [50, 50])]));
    expect(badPt.flanges.length).toBe(1);
    expect(badPt.warnings.filter(w => w.key === 'warnings.part.bendNoMaterial').length).toBe(2);
    expect(foldGeometry(badPt, finishedState(badPt)).bends.length).toBe(0);
    // a negative angle gives a zero-width (sharp) zone that never folds; no material is lost
    const neg = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, 0], [50, 50], 'up', -90)]));
    expect(neg.bendAllowance['B1']).toBe(0);
    expect(neg.flanges.reduce((s, f) => s + f.area, 0)).toBeCloseTo(5000, 9);
    const nf = foldGeometry(neg, finishedState(neg));
    for (const f of nf.flanges) expect(mat4.equals(f.transform, mat4.identity())).toBe(true);
  });
});

describe('foldGeometry — directions, angles, composition', () => {
  it('Z-bracket: the up leg goes to +w, the down leg to −w, both perpendicular to the root', () => {
    const truth = loadTruth('Z-bracket');
    const part = buildPartModel(truth.flat);
    const folded = foldGeometry(part, finishedState(part));
    const root = folded.flanges.find(f => f.flangeId === part.rootFlangeId)!;
    expect(root.regions[0]!.midSurface[0]!.x).toBeGreaterThan(38); // the middle plate is the root
    const up = part.links.find(l => l.bendId === 'B1')!, down = part.links.find(l => l.bendId === 'B2')!;
    const upZ = folded.flanges.find(f => f.flangeId === up.childFlangeId)!.regions[0]!.midSurface.map(p => p.z);
    const downZ = folded.flanges.find(f => f.flangeId === down.childFlangeId)!.regions[0]!.midSurface.map(p => p.z);
    expect(Math.min(...upZ)).toBeGreaterThan(2); expect(Math.max(...upZ)).toBeCloseTo(39, 5);
    expect(Math.max(...downZ)).toBeLessThan(-2); expect(Math.min(...downZ)).toBeCloseTo(-39, 5);
    expect(folded.bounds.max.z - folded.bounds.min.z).toBeCloseTo(78, 3);
  });

  it('non-90° angles, overbend and clamped fractions', () => {
    const acute = buildPartModel(loadTruth('acute-bracket').flat);
    for (const f of [0.5, 1, 1.1]) {
      const folded = foldGeometry(acute, { B1: f });
      const root = folded.flanges.find(x => x.flangeId === acute.rootFlangeId)!;
      const child = folded.flanges.find(x => x.flangeId !== acute.rootFlangeId)!;
      const ang = Math.acos(Math.max(-1, Math.min(1, vec3.dot(root.normal, child.normal)))) * 180 / Math.PI;
      expect(ang).toBeCloseTo(Math.min(180, 135 * f), 9);
      expect(folded.bends[0]!.currentAngle).toBeCloseTo(135 * f, 12);
    }
    const hem = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, 0], [50, 50], 'up', 180, 1)]));
    const hf = foldGeometry(hem, finishedState(hem));
    const child = hf.flanges.find(x => x.flangeId !== hem.rootFlangeId)!;
    expect(child.normal.z).toBeCloseTo(-1, 9);                          // folded back over the root
    for (const p of child.regions[0]!.midSurface) expect(p.z).toBeCloseTo(2 * (1 + 1), 9); // gap 2·rm, rm = ri + t/2 = 2
    expect(hf.bends[0]!.innerRadius).toBeCloseTo(1, 9);
    // negative / NaN / missing fractions are flat
    const part = buildPartModel(loadTruth('L-bracket').flat);
    for (const v of [-1, NaN, undefined]) {
      const folded = foldGeometry(part, v === undefined ? {} : { B1: v as number });
      expect(folded.bends[0]!.currentAngle).toBe(0);
      expect(mat4.equals(folded.flanges[1]!.transform, mat4.identity())).toBe(true);
    }
    // unknown ids are ignored
    expect(foldGeometry(part, { nope: 1 }).bends[0]!.currentAngle).toBe(0);
  });

  it('child transform = R(axisPoint, axisDir, θf) · T_parent · T(−BA·d̂) for every link, deep in the tree', () => {
    const part = buildPartModel(loadTruth('hat-channel').flat);
    const state = { B1: 0.7, B2: 1, B3: 0.4, B4: 1.2 };
    const folded = foldGeometry(part, state);
    const d = derivePart(part);
    for (const l of d.links) {
      const parent = folded.flanges.find(f => f.flangeId === l.parentFlangeId)!;
      const child = folded.flanges.find(f => f.flangeId === l.childFlangeId)!;
      const zone = folded.bends.find(b => b.bendId === l.bendId)!;
      const R = mat4.rotationAxisAngle(zone.axisPoint, zone.axisDir, zone.currentAngle);
      const T = mat4.translation({ x: -l.ba * l.dHat.x, y: -l.ba * l.dHat.y, z: 0 });
      const expected = mat4.multiply(R, mat4.multiply(parent.transform, T));
      expect(mat4.equals(expected, child.transform, 1e-9), l.bendId).toBe(true);
      // the zone's start edge lies on the parent's zone-start line and the arc end meets the child
      const s0 = mat4.applyToPoint(parent.transform, { x: l.s0.x, y: l.s0.y, z: 0 });
      expect(vec3.equals(zone.startEdge[0], s0, 1e-9)).toBe(true);
      const endFlat = { x: l.s1.x + l.ba * l.dHat.x, y: l.s1.y + l.ba * l.dHat.y, z: 0 };
      const endChild = mat4.applyToPoint(child.transform, endFlat);
      const phi = zone.currentAngle * Math.PI / 180;
      const C1 = vec3.add(zone.startEdge[1], vec3.scale(zone.toCentre, zone.midRadius));
      const onArc = vec3.add(C1, vec3.add(vec3.scale(zone.toCentre, -zone.midRadius * Math.cos(phi)), vec3.scale(zone.tangent, zone.midRadius * Math.sin(phi))));
      expect(vec3.dist(onArc, endChild)).toBeLessThan(1e-9);
    }
    expect(folded.bends.map(b => b.bendId).sort()).toEqual(['B1', 'B2', 'B3', 'B4']);
  });

  it('derivePart is not memoised: editing a bend in place is picked up', () => {
    const part = buildPartModel(loadTruth('L-bracket').flat);
    const a = foldGeometry(part, finishedState(part));
    part.flat.bends[0]!.direction = 'down';
    const b = foldGeometry(part, finishedState(part));
    expect(a.bends[0]!.toCentre.z).toBeCloseTo(1, 12);
    expect(b.bends[0]!.toCentre.z).toBeCloseTo(-1, 12);
  });
});

describe('bendPose / partSilhouette — placements the planner will produce', () => {
  it('non-root parent (hat channel brim): symmetric legs, root carried along, silhouette sane', () => {
    const truth = loadTruth('hat-channel');
    const part = buildPartModel(truth.flat);
    const t = truth.thickness;
    const before = foldGeometry(part, { B2: 1, B1: 0 });
    for (const childToPlusX of [true, false]) {
      const pl = placementFromFolded(part, before, 'B1', childToPlusX);
      // placement contract
      const z0 = before.bends.find(b => b.bendId === 'B1')!;
      const c = vec3.add(vec3.midpoint(z0.startEdge[0], z0.startEdge[1]), vec3.scale(z0.tangent, z0.zoneWidth / 2));
      const cm = mat4.applyToPoint(pl, c);
      expect(Math.abs(cm.x)).toBeLessThan(1e-9); expect(cm.y).toBeCloseTo(t / 2, 9);
      const wall = before.flanges.find(f => f.flangeId === part.links.find(l => l.bendId === 'B1')!.parentFlangeId)!;
      expect(mat4.applyToDir(pl, wall.normal).y).toBeCloseTo(1, 9);
      expect(mat4.applyToDir(pl, z0.tangent).x > 0).toBe(childToPlusX);
      for (const f of [0, 0.3, 0.8, 1, 1.03]) {
        const folded = foldGeometry(part, { B2: 1, B1: f });
        const tipY = punchTipY(16, t, 2.56, 90 * f, 1.5);
        const pose = bendPose(pl, folded, 'B1', f, tipY, t);
        if (f === 0) { expect(mat4.equals(pose, pl, 1e-9)).toBe(true); continue; }
        const zone = folded.bends.find(b => b.bendId === 'B1')!;
        const m = mat4.applyToPoint(pose, zoneCentrePoint(zone));
        expect(Math.abs(m.x)).toBeLessThan(1e-9);
        expect(m.y).toBeCloseTo(tipY - t / 2, 9);
        const C = mat4.applyToPoint(pose, zone.axisPoint);
        expect(Math.abs(C.x)).toBeLessThan(1e-9);
        expect(C.y).toBeCloseTo(m.y + zone.midRadius, 9);
        // both legs at θf/2 from horizontal, on opposite sides of X = 0
        const wallN = mat4.applyToDir(pose, folded.flanges.find(x => x.flangeId === wall.flangeId)!.normal);
        const brim = folded.flanges.find(x => x.flangeId === part.links.find(l => l.bendId === 'B1')!.childFlangeId)!;
        const brimN = mat4.applyToDir(pose, brim.normal);
        expect(Math.acos(wallN.y) * 180 / Math.PI).toBeCloseTo(45 * f, 6);
        expect(Math.acos(brimN.y) * 180 / Math.PI).toBeCloseTo(45 * f, 6);
        expect(wallN.x).toBeCloseTo(-brimN.x, 9);
        // the root (attached to the wall by the finished B2) is carried rigidly: still ⟂ to the wall
        const rootN = mat4.applyToDir(pose, folded.flanges.find(x => x.flangeId === part.rootFlangeId)!.normal);
        expect(Math.abs(vec3.dot(rootN, wallN))).toBeLessThan(1e-9);
        // the two legs adjacent to the bend stay above the apex; the hat's top hangs below the die in
        // this placement (a planner collision, not a geometry issue) — the silhouette must still be sane
        const sil = partSilhouette(folded, pose, t);
        expect(sil.length).toBeGreaterThanOrEqual(5);
        for (const s of sil) {
          expect(isCCW(s.polygon)).toBe(true);
          for (const p of s.polygon) expect(Number.isFinite(p.x + p.y)).toBe(true);
          expect(s.zRange[0]).toBeLessThanOrEqual(s.zRange[1]);
          const b = bounds(s.polygon);
          if (s.source.kind === 'flange' && (s.source.flangeId === wall.flangeId || s.source.flangeId === brim.flangeId)) {
            expect(b.min.y).toBeGreaterThan(tipY - t - 1e-6);
          }
        }
        const rootPiece = sil.find(s => s.source.kind === 'flange' && s.source.flangeId === part.rootFlangeId)!;
        expect(bounds(rootPiece.polygon).min.y).toBeLessThan(-10);
        const zonePiece = sil.find(s => s.source.kind === 'bend' && s.source.bendId === 'B1')!;
        expect(bounds(zonePiece.polygon).min.y).toBeCloseTo(tipY - t, 6);
      }
    }
  });

  it('child toward −X: the bend-line centre stays at X = 0 and the pose translation is −BA/2', () => {
    const part = buildPartModel(flatOf(rect(100, 50), [bend('B1', [60, 0], [60, 50])]));
    const ba = part.bendAllowance['B1']!;
    const pl = placementFromFolded(part, foldGeometry(part, flatState(part)), 'B1', false);
    const folded = foldGeometry(part, { B1: 1 });
    const tipY = punchTipY(16, 2, 2.56, 90);
    const pose = bendPose(pl, folded, 'B1', 1, tipY, 2);
    const m = mat4.applyToPoint(pose, zoneCentrePoint(folded.bends[0]!));
    expect(Math.abs(m.x)).toBeLessThan(1e-9);
    // pose = T · R · placement with T.x = −apex.x = −BA/2 (the arc centre sits on the parent side, +X)
    const R = mat4.rotationAxisAngle(mat4.applyToPoint(pl, folded.bends[0]!.axisPoint), mat4.applyToDir(pl, folded.bends[0]!.axisDir), -45);
    const T = mat4.multiply(pose, mat4.invert(mat4.multiply(R, pl)));
    expect(T[12]).toBeCloseTo(-ba / 2, 9);
    expect(Math.hypot(T[0]! - 1, T[5]! - 1, T[10]! - 1, T[1]!, T[2]!, T[4]!)).toBeLessThan(1e-9);
    // the root leg is on +X, the child leg on −X, both tilted 45° from horizontal and rising
    const rootFar = mat4.applyToPoint(pose, { x: 0, y: 25, z: 0 });
    const child = folded.flanges.find(x => x.flangeId !== part.rootFlangeId)!;
    const childFar = mat4.applyToPoint(pose, mat4.applyToPoint(child.transform, { x: 100, y: 25, z: 0 }));
    expect(rootFar.x).toBeGreaterThan(0); expect(childFar.x).toBeLessThan(0);
    expect(rootFar.y).toBeGreaterThan(m.y + 30); expect(childFar.y).toBeGreaterThan(m.y + 20);
    const nRoot = mat4.applyToDir(pose, { x: 0, y: 0, z: 1 }), nChild = mat4.applyToDir(pose, child.normal);
    expect(Math.acos(nRoot.y) * 180 / Math.PI).toBeCloseTo(45, 9);
    expect(Math.acos(nChild.y) * 180 / Math.PI).toBeCloseTo(45, 9);
    expect(nRoot.x).toBeCloseTo(-nChild.x, 9);
  });

  it('a folded geometry inconsistent with the fraction is rejected', () => {
    const part = buildPartModel(loadTruth('L-bracket').flat);
    const pl = placementFromFolded(part, foldGeometry(part, flatState(part)), 'B1', true);
    expect(() => bendPose(pl, foldGeometry(part, flatState(part)), 'B1', 0.5, 0, 2)).toThrow(/does not match/);
    expect(() => bendPose(pl, foldGeometry(part, finishedState(part)), 'B1', 0, 2, 2)).toThrow(/does not match/);
    expect(() => bendPose(pl, foldGeometry(part, { B1: 1e-5 }), 'B1', 1e-5, 2, 2)).not.toThrow();
    expect(() => bendPose(pl, foldGeometry(part, { B1: 0.5 }), 'B1', 0.5, 0, 2)).not.toThrow();
  });

  it("'down' bend: the placement flips the root so the concave side faces the punch", () => {
    const part = buildPartModel(flatOf(rect(100, 50), [bend('B1', [50, 0], [50, 50], 'down')]));
    const pl = placementFromFolded(part, foldGeometry(part, flatState(part)), 'B1', true);
    expect(mat4.applyToDir(pl, { x: 0, y: 0, z: 1 }).y).toBeCloseTo(-1, 9); // root +w → −Y (flipped)
    const folded = foldGeometry(part, { B1: 0.6 });
    const tipY = punchTipY(16, 2, 2.56, 54);
    const pose = bendPose(pl, folded, 'B1', 0.6, tipY, 2);
    const C = mat4.applyToPoint(pose, folded.bends[0]!.axisPoint);
    expect(C.y).toBeCloseTo(tipY - 1 + folded.bends[0]!.midRadius, 9);
    expect(Math.abs(C.x)).toBeLessThan(1e-9);
  });

  it('oblique bend zones are clipped to the zBand (tighter than the full hull) and stay inside it', () => {
    const tr = loadTruth('box-4-flange');
    const p = buildPartModel(tr.flat);
    const folded = foldGeometry(p, finishedState(p));
    const R: Mat4 = [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]; // PART x → Z, y → X, z → Y (B1 ∥ Z, B2/B4 ∥ X)
    const full = partSilhouette(folded, R, 2).filter(s => s.source.kind === 'bend' && s.source.bendId === 'B2')[0]!;
    const zr = full.zRange;
    expect(zr[1] - zr[0]).toBeGreaterThan(3); // the arc spans ~ri + t in Z
    const half: [number, number] = [zr[0], zr[0] + (zr[1] - zr[0]) * 0.4];
    const clipped = partSilhouette(folded, R, 2, half).filter(s => s.source.kind === 'bend' && s.source.bendId === 'B2')[0]!;
    expect(clipped.zRange[0]).toBeCloseTo(half[0], 9); expect(clipped.zRange[1]).toBeCloseTo(half[1], 9);
    expect(area(clipped.polygon)).toBeLessThan(area(full.polygon) * 0.7);
    const fb = bounds(full.polygon), cb = bounds(clipped.polygon);
    expect(cb.min.x).toBeGreaterThanOrEqual(fb.min.x - 1e-9); expect(cb.max.x).toBeLessThanOrEqual(fb.max.x + 1e-9);
    expect(cb.min.y).toBeGreaterThanOrEqual(fb.min.y - 1e-9); expect(cb.max.y).toBeLessThanOrEqual(fb.max.y + 1e-9);
    // the X extent (axial) is unchanged, the Y extent shrinks
    expect(cb.max.x - cb.min.x).toBeCloseTo(fb.max.x - fb.min.x, 6);
    expect(cb.max.y - cb.min.y).toBeLessThan(fb.max.y - fb.min.y);
    // a band with no overlap drops the zone
    expect(partSilhouette(folded, R, 2, [zr[1] + 1, zr[1] + 2]).some(s => s.source.kind === 'bend' && s.source.bendId === 'B2')).toBe(false);
  });

  it('every sample at f = 0.5 on each bend yields finite CCW silhouettes with zRange inside the part bounds', () => {
    for (const name of SAMPLE_NAMES) {
      const truth = loadTruth(name);
      const part = buildPartModel(truth.flat);
      const t = truth.thickness;
      for (const l of part.links) {
        const before: Record<string, number> = {};
        for (const other of part.links) if (other !== l) before[other.bendId] = 1;
        const pl = placementFromFolded(part, foldGeometry(part, { ...before, [l.bendId]: 0 }), l.bendId, true);
        const folded = foldGeometry(part, { ...before, [l.bendId]: 0.5 });
        const pose = bendPose(pl, folded, l.bendId, 0.5, punchTipY(16, t, 2.56, 45), t);
        const sil = partSilhouette(folded, pose, t);
        const pb = foldGeometry(part, { ...before, [l.bendId]: 0.5 });
        const bb = ((): { min: Vec3; max: Vec3 } => {
          const pts: Vec3[] = [];
          for (const f of pb.flanges) for (const r of f.regions) for (const q of r.midSurface) pts.push(mat4.applyToPoint(pose, q));
          return { min: { x: 0, y: 0, z: Math.min(...pts.map(q => q.z)) - t }, max: { x: 0, y: 0, z: Math.max(...pts.map(q => q.z)) + t } };
        })();
        expect(sil.length).toBeGreaterThanOrEqual(part.flanges.length + part.links.length);
        for (const s of sil) {
          expect(isCCW(s.polygon), `${name} ${l.bendId}`).toBe(true);
          expect(area(s.polygon)).toBeGreaterThan(0);
          expect(s.zRange[0]).toBeGreaterThanOrEqual(bb.min.z - 1e-6);
          expect(s.zRange[1]).toBeLessThanOrEqual(bb.max.z + 1e-6);
        }
      }
    }
  });
});
