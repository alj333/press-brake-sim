import { describe, it, expect } from 'vitest';
import { loadTruth, SAMPLE_NAMES } from '../core/testing/fixtures';
import { buildPartModel, foldGeometry, finishedState, flatState, derivePart, isStraightZone } from '../core/part';
import type { FoldedBend } from '../core/part';
import { mat4, vec3, area, centroid } from '../core/geom';
import type { FoldState, PartModel, Vec3 } from '../core/types';
import {
  buildFlangeGeometry, buildBendZoneGeometry, fillBendZoneArrays, zoneIndices, zoneHandedness, zoneToLocal,
  zoneParentFlangeIndex, zoneVertexCount, zoneIndexCount, meshDataBounds, ZONE_SEGMENTS,
} from './partGeometry';
import type { MeshData } from './partGeometry';

const truth = loadTruth('L-bracket');
const part = buildPartModel(truth.flat);
const t = truth.flat.thickness;

function checkMesh(d: MeshData): void {
  const nv = d.positions.length / 3;
  expect(Number.isInteger(nv)).toBe(true);
  expect(d.normals.length).toBe(d.positions.length);
  expect(d.indices.length % 3).toBe(0);
  for (const v of d.positions) expect(Number.isFinite(v)).toBe(true);
  for (const v of d.normals) expect(Number.isFinite(v)).toBe(true);
  for (const i of d.indices) expect(i).toBeLessThan(nv);
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(d.normals[3 * i]!, d.normals[3 * i + 1]!, d.normals[3 * i + 2]!);
    expect(l).toBeCloseTo(1, 5);
  }
}

/** Every non-degenerate triangle's geometric normal agrees with its vertex normals. */
function checkWinding(d: MeshData): void {
  const p = (i: number): Vec3 => ({ x: d.positions[3 * i]!, y: d.positions[3 * i + 1]!, z: d.positions[3 * i + 2]! });
  const n = (i: number): Vec3 => ({ x: d.normals[3 * i]!, y: d.normals[3 * i + 1]!, z: d.normals[3 * i + 2]! });
  let checked = 0;
  for (let k = 0; k < d.indices.length; k += 3) {
    const a = d.indices[k]!, b = d.indices[k + 1]!, c = d.indices[k + 2]!;
    const g = vec3.cross(vec3.sub(p(b), p(a)), vec3.sub(p(c), p(a)));
    const len = vec3.length(g);
    if (len < 1e-6) continue;
    const avg = vec3.add(vec3.add(n(a), n(b)), n(c));
    expect(vec3.dot(vec3.scale(g, 1 / len), vec3.normalize(avg))).toBeGreaterThan(0.5);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
}

function inside(b: { min: Vec3; max: Vec3 }, box: { min: Vec3; max: Vec3 }, tol = 1e-6): boolean {
  return b.min.x >= box.min.x - tol && b.min.y >= box.min.y - tol && b.min.z >= box.min.z - tol &&
    b.max.x <= box.max.x + tol && b.max.y <= box.max.y + tol && b.max.z <= box.max.z + tol;
}

function distToAxis(p: Vec3, b: FoldedBend): number {
  const d = vec3.sub(p, b.axisPoint);
  const along = vec3.dot(d, b.axisDir);
  return vec3.length(vec3.sub(d, vec3.scale(b.axisDir, along)));
}

describe('buildFlangeGeometry', () => {
  const folded = foldGeometry(part, finishedState(part));

  it('L-bracket flanges: consistent indices, no NaN, unit normals, bounds inside the folded bounds', () => {
    expect(part.flanges.length).toBe(2);
    part.flanges.forEach((_, i) => {
      const d = buildFlangeGeometry(part, i, t);
      checkMesh(d);
      checkWinding(d);
      const bounds = meshDataBounds(d, folded.flanges[i]!.transform);
      expect(inside(bounds, folded.bounds, 1e-3)).toBe(true);   // float32 storage
    });
  });

  it('vertex/triangle counts follow the extrusion layout (top + bottom + one quad per edge)', () => {
    const root = part.flanges.findIndex(f => f.id === part.rootFlangeId);
    const flange = part.flanges[root]!;
    const nOutline = flange.regions.reduce((s, r) => s + r.polygon.length, 0);
    const nHoleVerts = flange.regions.reduce((s, r) => s + r.holes.reduce((q, h) => q + h.length, 0), 0);
    const holes = flange.regions.reduce((s, r) => s + r.holes.length, 0);
    expect(holes).toBe(1);   // the L-bracket hole sits in the root flange
    const d = buildFlangeGeometry(part, root, t);
    const nRing = nOutline + nHoleVerts;
    expect(d.positions.length / 3).toBe(2 * nRing + 4 * nRing);
    const capTriangles = flange.regions.reduce((s, r) => s + (r.polygon.length + r.holes.reduce((q, h) => q + h.length, 0) + 2 * r.holes.length - 2), 0);
    expect(d.indices.length / 3).toBe(2 * capTriangles + 2 * nRing);
    // extruded ±t/2 in FLAT coordinates
    const b = meshDataBounds(d);
    expect(b.min.z).toBeCloseTo(-t / 2, 6);
    expect(b.max.z).toBeCloseTo(t / 2, 6);
    expect(b.max.x - b.min.x).toBeLessThan(truth.expected.flatBounds.w + 1e-3);
  });

  it('every sample flange builds and fits its folded bounds (flat and finished)', () => {
    for (const name of SAMPLE_NAMES) {
      const tr = loadTruth(name);
      const p = buildPartModel(tr.flat);
      for (const state of [flatState(p), finishedState(p)]) {
        const f = foldGeometry(p, state);
        p.flanges.forEach((_, i) => {
          const d = buildFlangeGeometry(p, i, tr.flat.thickness);
          checkMesh(d);
          expect(inside(meshDataBounds(d, f.flanges[i]!.transform), f.bounds, 1e-5)).toBe(true);
        });
      }
    }
  });

  it('rejects a bad flange index', () => {
    expect(() => buildFlangeGeometry(part, 99, t)).toThrow(RangeError);
  });
});

describe('buildBendZoneGeometry', () => {
  it('finished L-bracket: constant counts, radii ri / ri + t about the axis, bounds inside, consistent winding', () => {
    const folded = foldGeometry(part, finishedState(part));
    const zone = folded.bends[0]!;
    expect(zone.currentAngle).toBeCloseTo(90, 9);
    const d = buildBendZoneGeometry(zone, t);
    checkMesh(d);
    checkWinding(d);
    expect(d.positions.length / 3).toBe(zoneVertexCount());
    expect(d.indices.length).toBe(zoneIndexCount());
    expect(zoneVertexCount()).toBe(8 * (ZONE_SEGMENTS + 1));
    expect(zoneIndexCount()).toBe(24 * ZONE_SEGMENTS);
    const n1 = ZONE_SEGMENTS + 1;
    const p = (i: number): Vec3 => ({ x: d.positions[3 * i]!, y: d.positions[3 * i + 1]!, z: d.positions[3 * i + 2]! });
    for (let i = 0; i < 2 * n1; i++) {
      expect(distToAxis(p(i), zone)).toBeCloseTo(zone.innerRadius, 4);              // inner strip
      expect(distToAxis(p(2 * n1 + i), zone)).toBeCloseTo(zone.innerRadius + t, 4); // outer strip
    }
    expect(zone.innerRadius).toBeCloseTo(truth.flat.bends[0]!.innerRadius, 9);
    expect(inside(meshDataBounds(d), folded.bounds, 1e-4)).toBe(true);
    // the inner surface normals point toward the axis
    for (let i = 0; i < 2 * n1; i++) {
      const q = p(i), n = { x: d.normals[3 * i]!, y: d.normals[3 * i + 1]!, z: d.normals[3 * i + 2]! };
      const toAxis = vec3.sub(zone.axisPoint, q);
      const radial = vec3.sub(toAxis, vec3.scale(zone.axisDir, vec3.dot(toAxis, zone.axisDir)));
      expect(vec3.dot(vec3.normalize(radial), n)).toBeCloseTo(1, 4);
    }
  });

  it('mid-fold and overbend states keep the counts, the bounds and the winding', () => {
    for (const f of [0.02, 0.5, 1.02]) {
      const folded = foldGeometry(part, { B1: f });
      const zone = folded.bends[0]!;
      const d = buildBendZoneGeometry(zone, t);
      checkMesh(d);
      checkWinding(d);
      expect(d.positions.length / 3).toBe(zoneVertexCount());
      expect(inside(meshDataBounds(d), folded.bounds, 1e-4)).toBe(true);
    }
  });

  it('a straight (flat) zone is a BA × t strip with the same layout', () => {
    const folded = foldGeometry(part, flatState(part));
    const zone = folded.bends[0]!;
    const d = buildBendZoneGeometry(zone, t);
    checkMesh(d);
    checkWinding(d);
    const b = meshDataBounds(d);
    const ba = part.bendAllowance['B1']!;
    expect(b.max.x - b.min.x).toBeCloseTo(ba, 4);       // the L-bracket bend line runs along v: strip width along u
    expect(b.max.z - b.min.z).toBeCloseTo(t, 4);
    expect(b.max.y - b.min.y).toBeCloseTo(80, 4);
    expect(inside(b, folded.bounds, 1e-3)).toBe(true);
  });

  it('fills preallocated arrays in place and matches a fresh build', () => {
    const folded = foldGeometry(part, { B1: 0.6 });
    const zone = folded.bends[0]!;
    const positions = new Float32Array(3 * zoneVertexCount());
    const normals = new Float32Array(3 * zoneVertexCount());
    const d = buildBendZoneGeometry(zone, t, ZONE_SEGMENTS, { positions, normals });
    expect(d.positions).toBe(positions);
    expect(d.normals).toBe(normals);
    const fresh = buildBendZoneGeometry(zone, t);
    expect(Array.from(d.positions)).toEqual(Array.from(fresh.positions));
    expect(Array.from(d.indices)).toEqual(Array.from(fresh.indices));
    // refill with another fraction changes the arrays
    fillBendZoneArrays(foldGeometry(part, { B1: 0.9 }).bends[0]!, t, ZONE_SEGMENTS, positions, normals);
    expect(Array.from(positions)).not.toEqual(Array.from(fresh.positions));
    expect(() => fillBendZoneArrays(zone, t, ZONE_SEGMENTS, new Float32Array(3), normals)).toThrow(RangeError);
  });

  it('handedness is constant per bend across curved fractions; the straight state may differ (down bends)', () => {
    let straightDiffers = 0;
    for (const name of SAMPLE_NAMES) {
      const tr = loadTruth(name);
      const p: PartModel = buildPartModel(tr.flat);
      const ids = p.flat.bends.map(b => b.id);
      const at = (f: number): FoldState => Object.fromEntries(ids.map(id => [id, f]));
      const ref = new Map(foldGeometry(p, at(0.005)).bends.map(b => [b.bendId, zoneHandedness(b)]));
      for (const f of [0.3, 0.7, 1, 1.05]) {
        for (const b of foldGeometry(p, at(f)).bends) expect(zoneHandedness(b)).toBe(ref.get(b.bendId));
      }
      // the straight strip uses toCentre = +w whatever the direction: 'down' bends flip there
      for (const b of foldGeometry(p, at(0)).bends) {
        const dir = tr.flat.bends.find(x => x.id === b.bendId)!.direction;
        const h = zoneHandedness(b);
        if (h !== ref.get(b.bendId)) { straightDiffers++; expect(dir).toBe('down'); } else expect(dir).toBe('up');
      }
    }
    expect(straightDiffers).toBeGreaterThan(0);
    expect(zoneIndices(1).length).toBe(zoneIndexCount());
    expect(Array.from(zoneIndices(1))).not.toEqual(Array.from(zoneIndices(-1)));
  });

  it('parent-local zones mapped by the parent transform equal the PART-frame zones (hat-channel chain)', () => {
    const tr = loadTruth('hat-channel');
    const p = buildPartModel(tr.flat);
    const folded = foldGeometry(p, finishedState(p));
    let nonTrivial = 0;
    for (const zone of folded.bends) {
      const parent = zoneParentFlangeIndex(p, zone.bendId);
      expect(parent).toBeGreaterThanOrEqual(0);
      const tp = folded.flanges[parent]!.transform;
      if (!mat4.equals(tp, mat4.identity(), 1e-9)) nonTrivial++;
      const local = zoneToLocal(zone, mat4.invert(tp));
      // in the parent's local frame the zone lies in the FLAT plane: the start edge has w = 0
      expect(Math.abs(local.startEdge[0].z)).toBeLessThan(1e-6);
      expect(Math.abs(local.startEdge[1].z)).toBeLessThan(1e-6);
      const dLocal = buildBendZoneGeometry(local, tr.flat.thickness);
      const dPart = buildBendZoneGeometry(zone, tr.flat.thickness);
      expect(zoneHandedness(local)).toBe(zoneHandedness(zone));
      for (let i = 0; i < dLocal.positions.length; i += 3) {
        const q = mat4.applyToPoint(tp, { x: dLocal.positions[i]!, y: dLocal.positions[i + 1]!, z: dLocal.positions[i + 2]! });
        expect(q.x).toBeCloseTo(dPart.positions[i]!, 3);
        expect(q.y).toBeCloseTo(dPart.positions[i + 1]!, 3);
        expect(q.z).toBeCloseTo(dPart.positions[i + 2]!, 3);
      }
    }
    expect(nonTrivial).toBeGreaterThan(0);
  });
});

// ─── Review additions: every sample, down bends, acute, overbend, seams, holes, degenerate inputs ───

function vertex(d: MeshData, i: number): Vec3 {
  return { x: d.positions[3 * i]!, y: d.positions[3 * i + 1]!, z: d.positions[3 * i + 2]! };
}

/** Signed area of the top-face triangles (z = +t/2, normal +w). */
function topFaceArea(d: MeshData, h: number): number {
  let s = 0;
  for (let k = 0; k < d.indices.length; k += 3) {
    const a = d.indices[k]!, b = d.indices[k + 1]!, c = d.indices[k + 2]!;
    if (d.positions[3 * a + 2] !== h || d.positions[3 * b + 2] !== h || d.positions[3 * c + 2] !== h || d.normals[3 * a + 2] !== 1) continue;
    const pa = vertex(d, a), pb = vertex(d, b), pc = vertex(d, c);
    s += ((pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y)) / 2;
  }
  return s;
}

function pointInTriangle(p: { x: number; y: number }, a: Vec3, b: Vec3, c: Vec3): boolean {
  const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

describe('review: zones of every sample at every kind of fraction', () => {
  it('winding, radii, seams and inner normals hold for up/down/acute bends, mid-fold and overbend', () => {
    let downChecked = 0, acuteChecked = 0;
    for (const name of SAMPLE_NAMES) {
      const tr = loadTruth(name);
      const p = buildPartModel(tr.flat);
      const tt = tr.flat.thickness;
      const der = derivePart(p);
      for (const f of [0, 0.004, 0.02, 0.5, 1, 1.1]) {
        const state: FoldState = Object.fromEntries(p.flat.bends.map(b => [b.id, f]));
        const folded = foldGeometry(p, state);
        for (const zone of folded.bends) {
          const bend = p.flat.bends.find(b => b.id === zone.bendId)!;
          if (bend.direction === 'down' && f > 0) downChecked++;
          if (bend.angle > 90 && f > 0) acuteChecked++;
          const d = buildBendZoneGeometry(zone, tt);
          checkMesh(d);
          checkWinding(d);
          expect(inside(meshDataBounds(d), folded.bounds, 1e-3)).toBe(true);
          const n1 = ZONE_SEGMENTS + 1;
          if (isStraightZone(zone)) continue;
          for (let i = 0; i < 2 * n1; i++) {
            expect(distToAxis(vertex(d, i), zone)).toBeCloseTo(Math.max(0, zone.innerRadius), 3);
            expect(distToAxis(vertex(d, 2 * n1 + i), zone)).toBeCloseTo(Math.max(0, zone.innerRadius) + tt, 3);
            // inner normals point at the axis, outer ones away
            const q = vertex(d, i), nIn = vertex({ positions: d.normals } as MeshData, i), nOut = vertex({ positions: d.normals } as MeshData, 2 * n1 + i);
            const toAxis = vec3.sub(zone.axisPoint, q);
            const radial = vec3.normalize(vec3.sub(toAxis, vec3.scale(zone.axisDir, vec3.dot(toAxis, zone.axisDir))));
            expect(vec3.dot(radial, nIn)).toBeCloseTo(1, 3);
            expect(vec3.dot(radial, nOut)).toBeCloseTo(-1, 3);
          }
          // seam φ = 0: the mid-point of the inner/outer rows lies on the parent's start edge;
          // seam φ = θf: it coincides with the child flange's zone-end edge after the child transform
          const link = der.linkByBend.get(zone.bendId)!;
          const child = folded.flanges.find(x => x.flangeId === link.childFlangeId)!;
          for (const lambda of [0, 1] as const) {
            const mid0 = vec3.midpoint(vertex(d, lambda * n1), vertex(d, 2 * n1 + lambda * n1));
            expect(vec3.dist(mid0, zone.startEdge[lambda])).toBeLessThan(1e-3);
            const pFlat = lambda === 0 ? bend.p0 : bend.p1;
            const endFlat = { x: pFlat.x + (link.dHat.x * link.ba) / 2, y: pFlat.y + (link.dHat.y * link.ba) / 2, z: 0 };
            const expected = mat4.applyToPoint(child.transform, endFlat);
            const midEnd = vec3.midpoint(vertex(d, lambda * n1 + ZONE_SEGMENTS), vertex(d, 2 * n1 + lambda * n1 + ZONE_SEGMENTS));
            expect(vec3.dist(midEnd, expected)).toBeLessThan(1e-3);
          }
        }
      }
    }
    expect(downChecked).toBeGreaterThan(0);
    expect(acuteChecked).toBeGreaterThan(0);
  });

  it('zoneIndices(−1) is zoneIndices(1) with every triangle reversed', () => {
    const a = zoneIndices(1), b = zoneIndices(-1);
    expect(a.length).toBe(b.length);
    for (let k = 0; k < a.length; k += 3) {
      expect([b[k], b[k + 1], b[k + 2]]).toEqual([a[k], a[k + 2], a[k + 1]]);
    }
    expect(zoneIndices(1, 3).length).toBe(zoneIndexCount(3));
    expect(zoneVertexCount(3)).toBe(32);
  });

  it('a hem-like zone folded to 180° and a zone with a negative inner radius stay finite (inner clamped to the axis)', () => {
    const tr = loadTruth('L-bracket');
    const flat = structuredClone(tr.flat);
    flat.bends[0]!.angle = 180;
    flat.bends[0]!.innerRadius = 0.5;
    const p = buildPartModel(flat);
    for (const f of [1, 1.4]) {
      const folded = foldGeometry(p, { B1: f });
      const zone = folded.bends[0]!;
      const d = buildBendZoneGeometry(zone, flat.thickness);
      checkMesh(d);
      checkWinding(d);
      const n1 = ZONE_SEGMENTS + 1;
      const rIn = Math.max(0, zone.innerRadius);
      for (let i = 0; i < 2 * n1; i++) {
        expect(distToAxis(vertex(d, i), zone)).toBeCloseTo(rIn, 3);
        expect(distToAxis(vertex(d, 2 * n1 + i), zone)).toBeCloseTo(rIn + flat.thickness, 3);
      }
      if (f > 1) expect(zone.innerRadius).toBeLessThan(0.5);
    }
  });

  it('degenerate bend records (zero-length axis edge, NaN-free) and zoneToLocal of a straight zone', () => {
    const folded = foldGeometry(part, flatState(part));
    const zone = folded.bends[0]!;
    const local = zoneToLocal(zone, mat4.identity());
    expect(local.startEdge[0]).toEqual(zone.startEdge[0]);
    expect(local.toCentre).toEqual(zone.toCentre);
    const degenerate: FoldedBend = { ...zone, startEdge: [zone.startEdge[0], zone.startEdge[0]] };
    const d = buildBendZoneGeometry(degenerate, t);
    for (const v of d.positions) expect(Number.isFinite(v)).toBe(true);
    for (const v of d.normals) expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(zoneHandedness(degenerate))).toBe(1);   // the axial direction falls back to axisDir: still a valid index buffer
    // a curved zone with a zero-length edge is a fan: still finite
    const curved = foldGeometry(part, { B1: 0.5 }).bends[0]!;
    const fan = buildBendZoneGeometry({ ...curved, startEdge: [curved.startEdge[1], curved.startEdge[1]] }, t);
    for (const v of fan.positions) expect(Number.isFinite(v)).toBe(true);
    expect(meshDataBounds({ positions: new Float32Array(0) })).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
  });

  it('zoneParentFlangeIndex: link parents, loose bends, unknown ids', () => {
    const tr = loadTruth('hat-channel');
    const p = buildPartModel(tr.flat);
    for (const l of p.links) expect(p.flanges[zoneParentFlangeIndex(p, l.bendId)]!.id).toBe(l.parentFlangeId);
    expect(zoneParentFlangeIndex(p, 'nope')).toBe(-1);
    // a loose bend (no link) is carried by the first flange whose bendIds contains it — as foldGeometry does
    const loose: PartModel = { ...p, links: p.links.filter(l => l.bendId !== 'B2') };
    const idx = zoneParentFlangeIndex(loose, 'B2');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(loose.flanges[idx]!.bendIds).toContain('B2');
    const folded = foldGeometry(loose, finishedState(loose));
    const zone = folded.bends.find(b => b.bendId === 'B2')!;
    expect(isStraightZone(zone)).toBe(true);
    // its local geometry through that flange's transform reproduces the PART-frame strip
    const tp = folded.flanges[idx]!.transform;
    const local = zoneToLocal(zone, mat4.invert(tp));
    const dl = buildBendZoneGeometry(local, tr.flat.thickness), dp = buildBendZoneGeometry(zone, tr.flat.thickness);
    for (let i = 0; i < dl.positions.length; i += 3) {
      const q = mat4.applyToPoint(tp, { x: dl.positions[i]!, y: dl.positions[i + 1]!, z: dl.positions[i + 2]! });
      expect(q.x).toBeCloseTo(dp.positions[i]!, 3); expect(q.y).toBeCloseTo(dp.positions[i + 1]!, 3); expect(q.z).toBeCloseTo(dp.positions[i + 2]!, 3);
    }
  });
});

describe('review: flange meshes', () => {
  it('top-face area equals region area minus holes for every sample; a point inside the hole is uncovered', () => {
    for (const name of SAMPLE_NAMES) {
      const tr = loadTruth(name);
      const p = buildPartModel(tr.flat);
      p.flanges.forEach((f, i) => {
        const d = buildFlangeGeometry(p, i, tr.flat.thickness);
        const expected = f.regions.reduce((s, r) => s + area(r.polygon) - r.holes.reduce((q, h) => q + area(h), 0), 0);
        expect(topFaceArea(d, tr.flat.thickness / 2)).toBeCloseTo(expected, 2);   // float32 vertices
        for (const r of f.regions) for (const h of r.holes) {
          const c = centroid(h);
          let covered = false;
          for (let k = 0; k < d.indices.length && !covered; k += 3) {
            const a = d.indices[k]!, b = d.indices[k + 1]!, cc = d.indices[k + 2]!;
            if (d.positions[3 * a + 2] !== tr.flat.thickness / 2 || d.normals[3 * a + 2] !== 1) continue;
            covered = pointInTriangle(c, vertex(d, a), vertex(d, b), vertex(d, cc));
          }
          expect(covered).toBe(false);
        }
      });
    }
  });

  it('accepts a region with a duplicated closing point, a CW outline and a CCW hole (winding is normalised)', () => {
    const outline = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 0 }, { x: 0, y: 0 }];   // CW + closing duplicate
    const hole = [{ x: 20, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 30 }, { x: 20, y: 30 }];                   // CCW (should be CW)
    const synthetic: PartModel = {
      ...part,
      flanges: [{ id: 'S', regions: [{ polygon: outline, holes: [hole, [{ x: 1, y: 1 }]] }], area: 5000 - 400, bendIds: [] }],
      rootFlangeId: 'S', links: [],
    };
    const d = buildFlangeGeometry(synthetic, 0, 2);
    checkMesh(d);
    checkWinding(d);
    expect(topFaceArea(d, 1)).toBeCloseTo(5000 - 400, 6);
    // 4 + 4 ring vertices (the closing duplicate is dropped, the 1-point "hole" ignored): 6·8 vertices, 2·(8 + 2 − 2) + 2·8 triangles
    expect(d.positions.length / 3).toBe(48);
    expect(d.indices.length / 3).toBe(2 * 8 + 16);
    // outward wall normals: the wall along y = 0 faces −v, the hole wall along y = 10 faces +v (into the hole)
    const walls = new Map<string, number>();
    for (let i = 16; i < 48; i++) walls.set(`${d.normals[3 * i]},${d.normals[3 * i + 1]}`, (walls.get(`${d.normals[3 * i]},${d.normals[3 * i + 1]}`) ?? 0) + 1);
    expect(walls.get('0,-1')).toBe(8);
    expect(walls.get('0,1')).toBe(8);
    expect(walls.get('1,0')).toBe(8);
    expect(walls.get('-1,0')).toBe(8);
    expect(buildFlangeGeometry({ ...synthetic, flanges: [{ id: 'E', regions: [{ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }], holes: [] }], area: 0, bendIds: [] }] }, 0, 2).indices.length).toBe(0);
  });
});
