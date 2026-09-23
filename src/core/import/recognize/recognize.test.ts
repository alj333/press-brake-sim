import { describe, it, expect, beforeAll } from 'vitest';
import { SAMPLE_NAMES, loadTruth, readSampleBytes, flatsEquivalent } from '../../testing/fixtures';
import type { SampleName, Truth } from '../../testing/fixtures';
import { importStep, importMesh } from '../index';
import { recognizeSheet, matchToDxf } from './index';
import type { RecognizedSheet, TriangleMesh } from '../../types';
import { mat4, vec3 } from '../../geom';
import { buildPartModel, foldGeometry, finishedState, partBoundsFolded } from '../../part';

const OPTS = { materialId: 'std:mild-steel', kFactor: 0.44 };

const meshes = new Map<string, TriangleMesh>();

async function loadMesh(name: SampleName, kind: 'step' | 'stl'): Promise<TriangleMesh> {
  const key = `${name}/${kind}`;
  let m = meshes.get(key);
  if (!m) {
    const imported = kind === 'step'
      ? await importStep(readSampleBytes(name, 'step'), name)
      : await importMesh(readSampleBytes(name, 'stl'), 'stl', { name });
    const { warnings: _w, ...mesh } = imported;
    m = mesh;
    meshes.set(key, m);
  }
  return m;
}

/** Rigidly move a mesh (rotation about an arbitrary axis + translation); face groups are kept. */
function moveMesh(mesh: TriangleMesh, m: number[]): TriangleMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = mat4.applyToPoint(m, { x: mesh.positions[i]!, y: mesh.positions[i + 1]!, z: mesh.positions[i + 2]! });
    positions[i] = p.x; positions[i + 1] = p.y; positions[i + 2] = p.z;
  }
  return { ...mesh, positions, name: `${mesh.name}-moved` };
}

function sorted(xs: number[]): number[] { return xs.slice().sort((a, b) => a - b); }

function expectMatchesTruth(rec: RecognizedSheet, truth: Truth): void {
  expect(Math.abs(rec.thickness - truth.thickness)).toBeLessThanOrEqual(0.05);
  expect(rec.bendCount).toBe(truth.expected.bendCount);
  expect(rec.flat.bends.length).toBe(truth.expected.bendCount);
  expect(rec.bends3d.length).toBe(truth.expected.bendCount);
  const recAngles = sorted(rec.flat.bends.map(b => b.angle)), truthAngles = sorted(truth.flat.bends.map(b => b.angle));
  recAngles.forEach((a, i) => expect(Math.abs(a - truthAngles[i]!)).toBeLessThanOrEqual(0.5));
  const recRadii = sorted(rec.flat.bends.map(b => b.innerRadius)), truthRadii = sorted(truth.flat.bends.map(b => b.innerRadius));
  recRadii.forEach((r, i) => expect(Math.abs(r - truthRadii[i]!)).toBeLessThanOrEqual(0.1));
  // bends3d agree with the flat bends
  for (const b3 of rec.bends3d) {
    const fb = rec.flat.bends.find(b => b.id === b3.id)!;
    expect(fb).toBeDefined();
    expect(Math.abs(fb.angle - b3.angle)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(fb.innerRadius - b3.innerRadius)).toBeLessThanOrEqual(1e-6);
    const len = Math.hypot(fb.p1.x - fb.p0.x, fb.p1.y - fb.p0.y);
    expect(Math.abs(len - b3.length)).toBeLessThanOrEqual(0.05);
    expect(rec.faces.some(f => f.id === b3.faceA)).toBe(true);
    expect(rec.faces.some(f => f.id === b3.faceB)).toBe(true);
  }
  const eq = flatsEquivalent(rec.flat, truth.flat, { tol: 0.5 });
  expect(eq.reasons, eq.reasons.join('; ')).toEqual([]);
  expect(eq.equivalent).toBe(true);
  expect(rec.flat.holes.length).toBe(truth.expected.holeCount);
  expect(rec.confidence).toBe(1);
  expect(rec.issues.filter(m => m.severity !== 'info')).toEqual([]);
  expect(rec.flat.thickness).toBe(rec.thickness);
  expect(rec.flat.sourceUnits).toBe('mm');
  expect(rec.flat.warnings).toBe(rec.issues);
  // planar faces of one side only: root first, tree order, one per flange
  expect(rec.faces.length).toBe(truth.expected.flangeCount);
  expect(rec.faces[0]!.id).toBe('F1');
}

function expectMeshToPart(rec: RecognizedSheet, mesh: TriangleMesh): void {
  const part = buildPartModel(rec.flat);
  expect(part.warnings).toEqual([]);
  const folded = foldGeometry(part, finishedState(part));
  const pb = partBoundsFolded(folded, rec.thickness);
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = mat4.applyToPoint(rec.meshToPart, { x: mesh.positions[i]!, y: mesh.positions[i + 1]!, z: mesh.positions[i + 2]! });
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
  }
  for (const k of ['x', 'y', 'z'] as const) {
    expect(Math.abs(min[k] - pb.min[k])).toBeLessThanOrEqual(0.1);
    expect(Math.abs(max[k] - pb.max[k])).toBeLessThanOrEqual(0.1);
  }
  // rigid: determinant 1
  expect(Math.abs(mat4.determinant(rec.meshToPart) - 1)).toBeLessThanOrEqual(1e-6);
  // every reference face maps to z = +t/2 for the root, and outlines are CCW about their normal
  const root = rec.faces[0]!;
  for (const p of root.outline) expect(Math.abs(mat4.applyToPoint(rec.meshToPart, p).z - rec.thickness / 2)).toBeLessThanOrEqual(1e-3);
  expect(Math.abs(mat4.applyToDir(rec.meshToPart, root.normal).z - 1)).toBeLessThanOrEqual(1e-6);
}

describe('recognizeSheet on the samples', () => {
  beforeAll(async () => {
    for (const name of SAMPLE_NAMES) { await loadMesh(name, 'step'); await loadMesh(name, 'stl'); }
  });

  for (const name of SAMPLE_NAMES) {
    for (const kind of ['step', 'stl'] as const) {
      it(`${name}.${kind}: thickness, bends, angles, radii, equivalent flat, holes, match, meshToPart`, async () => {
        const truth = loadTruth(name);
        const mesh = await loadMesh(name, kind);
        const rec = recognizeSheet(mesh, OPTS);
        expectMatchesTruth(rec, truth);
        const src = kind === 'step' ? 'step' : 'mesh';
        for (const b of rec.flat.bends) expect(b.sources).toEqual({ geometry: src, angle: src, radius: src, direction: src });
        expect(rec.flat.provenance?.format).toBe(kind === 'step' ? 'step' : 'mesh');
        expect(rec.flat.materialId).toBe('std:mild-steel');
        for (const b of rec.flat.bends) expect(b.kFactor).toBe(0.44);
        // bend directions match the truth exactly (the root side is chosen so that most bends are 'up')
        const eq = flatsEquivalent(rec.flat, truth.flat);
        expect(eq.mirrored).toBe(false);
        // matchToDxf pairs every bend
        const m = matchToDxf(rec, truth.flat);
        expect(m.pairs.length).toBe(truth.expected.bendCount);
        expect(m.unmatchedDxf).toEqual([]);
        expect(m.unmatchedRec).toEqual([]);
        expect(m.mirrored).toBe(false);
        for (const b of m.flat.bends) {
          const t = truth.flat.bends.find(x => x.id === b.id)!;
          expect(b.direction).toBe(t.direction);
          expect(Math.abs(b.angle - t.angle)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(b.innerRadius - t.innerRadius)).toBeLessThanOrEqual(0.1);
          expect(b.sources.angle).toBe(src);
          expect(b.sources.geometry).toBe('dxf');
          expect(b.p0).toEqual(t.p0);
        }
        expectMeshToPart(rec, mesh);
      });
    }
  }

  it('a rigidly moved mesh (arbitrary rotation + translation) gives the same result', async () => {
    const move = mat4.multiply(mat4.translationXYZ(123.4, -56.7, 89), mat4.fromAxisAngle(vec3.normalize({ x: 1, y: 2, z: 3 }), 37));
    for (const name of SAMPLE_NAMES) {
      const truth = loadTruth(name);
      for (const kind of ['step', 'stl'] as const) {
        const mesh = await loadMesh(name, kind);
        const base = recognizeSheet(mesh, OPTS);
        const moved = moveMesh(mesh, move);
        const rec = recognizeSheet(moved, OPTS);
        expectMatchesTruth(rec, truth);
        expect(Math.abs(rec.thickness - base.thickness)).toBeLessThanOrEqual(1e-3);
        expect(rec.bendCount).toBe(base.bendCount);
        const a = sorted(rec.flat.bends.map(b => b.angle)), b = sorted(base.flat.bends.map(x => x.angle));
        a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(0.01));
        const ra = sorted(rec.flat.bends.map(x => x.innerRadius)), rb = sorted(base.flat.bends.map(x => x.innerRadius));
        ra.forEach((v, i) => expect(Math.abs(v - rb[i]!)).toBeLessThanOrEqual(0.005));
        const eq = flatsEquivalent(rec.flat, base.flat, { tol: 0.05, angleTol: 0.05 });
        expect(eq.reasons, `${name}.${kind}: ${eq.reasons.join('; ')}`).toEqual([]);
        // the flat frame is canonical: the same flat up to numerical noise
        expect(rec.flat.outline.length).toBe(base.flat.outline.length);
        rec.flat.bends.forEach((bl, i) => {
          const bb = base.flat.bends[i]!;
          expect(bl.direction).toBe(bb.direction);
          expect(Math.hypot(bl.p0.x - bb.p0.x, bl.p0.y - bb.p0.y)).toBeLessThanOrEqual(0.02);
          expect(Math.hypot(bl.p1.x - bb.p1.x, bl.p1.y - bb.p1.y)).toBeLessThanOrEqual(0.02);
        });
        expectMeshToPart(rec, moved);
        // bends3d live in the mesh frame: every axis moved with the mesh (as a set — a symmetric part
        // may legitimately number its physical bends differently)
        for (const b3 of rec.bends3d) {
          const hit = base.bends3d.some(b0 => {
            const movedAxis = mat4.applyToDir(move, b0.axisDir);
            if (Math.abs(Math.abs(vec3.dot(movedAxis, b3.axisDir)) - 1) > 1e-6) return false;
            const d = vec3.sub(mat4.applyToPoint(move, b0.axisPoint), b3.axisPoint);
            return vec3.length(vec3.cross(d, b3.axisDir)) <= 1e-3 && Math.abs(b0.innerRadius - b3.innerRadius) <= 1e-3;
          });
          expect(hit, `${name}.${kind} ${b3.id}`).toBe(true);
        }
      }
    }
  });

  it('thicknessHint and name options', async () => {
    const mesh = await loadMesh('L-bracket', 'step');
    const rec = recognizeSheet(mesh, { ...OPTS, thicknessHint: 2, name: 'my-part' });
    expect(rec.flat.id).toBe('my-part');
    expect(rec.flat.name).toBe('my-part');
    expect(rec.thickness).toBeCloseTo(2, 3);
    // a wrong hint does not override a clear measurement
    const rec2 = recognizeSheet(mesh, { ...OPTS, thicknessHint: 3 });
    expect(rec2.thickness).toBeCloseTo(2, 3);
  });

  it('is fast enough on the 2-CPU box (< 150 ms per sample)', async () => {
    for (const name of SAMPLE_NAMES) {
      const mesh = await loadMesh(name, 'stl');
      recognizeSheet(mesh, OPTS);
      const t0 = performance.now();
      recognizeSheet(mesh, OPTS);
      expect(performance.now() - t0).toBeLessThan(150);
    }
  });
});
