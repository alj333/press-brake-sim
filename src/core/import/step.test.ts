import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth, readSampleBytes } from '../testing/fixtures';
import { importStep } from './step';
import { mergeOcctMeshes } from './step-merge';
import { loadOcct, OCCT_PARAMS } from './occt-loader';
import { positionsBounds } from './weld';
import { ImportError } from './errors';

function extents(positions: Float32Array): [number, number, number] {
  const b = positionsBounds(positions);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

describe('importStep (Node path: occt in-process)', () => {
  for (const name of SAMPLE_NAMES) {
    it(`${name}.step: bounds within 0.1 mm of expected.foldedBounds, face groups partition the triangles, vertices welded`, async () => {
      const truth = loadTruth(name);
      const bytes = readSampleBytes(name, 'step');
      const mesh = await importStep(bytes, name);
      expect(mesh.units).toBe('mm');
      expect(mesh.name).toBe(name);
      expect(mesh.warnings).toEqual([]);
      const [dx, dy, dz] = extents(mesh.positions);
      const fb = truth.expected.foldedBounds;
      expect(Math.abs(dx - fb.x)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(dy - fb.y)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(dz - fb.z)).toBeLessThanOrEqual(0.1);
      // face groups: non-empty, in order, contiguous and covering every triangle exactly once
      const groups = mesh.faceGroups!;
      expect(groups.length).toBeGreaterThan(0);
      const triCount = mesh.indices.length / 3;
      let next = 0;
      for (const g of groups) {
        expect(g.first).toBe(next);
        expect(g.last).toBeGreaterThanOrEqual(g.first);
        next = g.last + 1;
      }
      expect(next).toBe(triCount);
      // welded: fewer vertices than occt's per-face vertices, every index valid
      const occt = await loadOcct();
      const raw = mergeOcctMeshes(occt.ReadStepFile(bytes, OCCT_PARAMS));
      expect(mesh.positions.length).toBeLessThan(raw.positions.length);
      expect(mesh.indices.length).toBe(raw.indices.length);
      let max = 0;
      for (const i of mesh.indices) if (i > max) max = i;
      expect(max).toBeLessThan(mesh.positions.length / 3);
    });
  }

  it('L-bracket: 11 B-rep faces, 404 triangles, shared edges after welding', async () => {
    const mesh = await importStep(readSampleBytes('L-bracket', 'step'));
    expect(mesh.faceGroups!.length).toBe(11);
    expect(mesh.indices.length / 3).toBe(404);
    expect(mesh.name).toBe('step');
    // every edge of a closed solid is shared by exactly 2 triangles once vertices are welded
    const edges = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (let k = 0; k < 3; k++) {
        const a = tri[k]!, b = tri[(k + 1) % 3]!;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every(c => c === 2)).toBe(true);
    // Euler characteristic of a genus-0 solid with one through hole: V − E + F = 0
    const V = mesh.positions.length / 3, E = edges.size, F = mesh.indices.length / 3;
    expect(V - E + F).toBe(0);
  });

  it('rejects an empty buffer and a non-STEP file with typed errors', async () => {
    await expect(importStep(new Uint8Array(0))).rejects.toBeInstanceOf(ImportError);
    await expect(importStep(new TextEncoder().encode('this is not a step file'))).rejects.toMatchObject({ key: 'errors.import.stepFailed' });
  });

  it('mergeOcctMeshes offsets indices and face groups across bodies', () => {
    const body = (n: number, tris: number, faces: number) => ({
      name: `b${n}`, brep_faces: Array.from({ length: faces }, (_, f) => ({ first: f * (tris / faces), last: (f + 1) * (tris / faces) - 1, color: null })),
      attributes: { position: { array: Array.from({ length: tris * 9 }, (_, i) => i + n * 1000) } },
      index: { array: Array.from({ length: tris * 3 }, (_, i) => i) },
    });
    const merged = mergeOcctMeshes({ success: true, root: { name: '', meshes: [0, 1], children: [] }, meshes: [body(0, 4, 2), body(1, 2, 1)] });
    expect(merged.meshCount).toBe(2);
    expect(merged.positions.length).toBe(54);
    expect(Array.from(merged.indices.slice(12))).toEqual([12, 13, 14, 15, 16, 17]);
    expect(merged.faceGroups).toEqual([{ first: 0, last: 1 }, { first: 2, last: 3 }, { first: 4, last: 5 }]);
    expect(() => mergeOcctMeshes({ success: false, root: { name: '', meshes: [], children: [] }, meshes: [] })).toThrow(ImportError);
  });
});
