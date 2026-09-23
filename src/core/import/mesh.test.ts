import { describe, it, expect } from 'vitest';
import { SAMPLE_NAMES, loadTruth, readSampleBytes } from '../testing/fixtures';
import { importMesh } from './mesh';
import { weldMesh, positionsBounds } from './weld';
import { parseStl } from './stl';
import { parseObj } from './obj';
import { ImportError } from './errors';

/** Unit cube as 12 unshared triangles (36 vertices), in `size` units. */
export function cubeSoup(size = 1): { positions: number[]; indices: number[] } {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(p => p.map(c => c * size));
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const positions: number[] = [], indices: number[] = [];
  for (const f of faces) {
    for (const tri of [[f[0]!, f[1]!, f[2]!], [f[0]!, f[2]!, f[3]!]]) {
      for (const i of tri) { indices.push(positions.length / 3); positions.push(...v[i]!); }
    }
  }
  return { positions, indices };
}

export function asciiStl(positions: number[], name = 'cube'): string {
  let s = `solid ${name}\n`;
  for (let t = 0; t < positions.length / 9; t++) {
    s += '  facet normal 0 0 0\n    outer loop\n';
    for (let k = 0; k < 3; k++) s += `      vertex ${positions[t * 9 + k * 3]} ${positions[t * 9 + k * 3 + 1]} ${positions[t * 9 + k * 3 + 2]}\n`;
    s += '    endloop\n  endfacet\n';
  }
  return s + `endsolid ${name}\n`;
}

export function binaryStl(positions: number[]): Uint8Array {
  const n = positions.length / 9;
  const out = new Uint8Array(84 + 50 * n);
  const dv = new DataView(out.buffer);
  new TextEncoder().encodeInto('binary stl written by tests', out);
  dv.setUint32(80, n, true);
  let off = 84;
  for (let t = 0; t < n; t++) {
    off += 12;
    for (let k = 0; k < 9; k++) { dv.setFloat32(off, positions[t * 9 + k]!, true); off += 4; }
    off += 2;
  }
  return out;
}

/** Minimal GLB (one indexed triangle mesh, POSITION + uint16 indices, optional node scale/translation). */
export function makeGlb(positions: number[], indices: number[], node: { translation?: number[]; scale?: number[] } = {}): Uint8Array {
  const pos = new Float32Array(positions);
  const idx = new Uint16Array(indices);
  const idxBytes = (idx.byteLength + 3) & ~3;
  const binLen = pos.byteLength + idxBytes;
  const bin = new Uint8Array(binLen);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const b = positionsBounds(pos);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, ...node }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: b.min, max: b.max },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
    buffers: [{ byteLength: binLen }],
  };
  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4) jsonStr += ' ';
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const total = 12 + 8 + jsonBytes.length + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, binLen, true); dv.setUint32(o + 4, 0x004e4942, true); out.set(bin, o + 8);
  return out;
}

function extents(positions: Float32Array): [number, number, number] {
  const b = positionsBounds(positions);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

describe('weldMesh', () => {
  it('welds a 36-vertex cube soup to 8 vertices and keeps 12 triangles', () => {
    const cube = cubeSoup(10);
    const w = weldMesh(cube.positions, cube.indices);
    expect(w.rawVertexCount).toBe(36);
    expect(w.positions.length / 3).toBe(8);
    expect(w.indices.length / 3).toBe(12);
    expect(w.degenerate).toBe(0);
    // every edge is shared by exactly two triangles
    const edges = new Map<string, number>();
    for (let t = 0; t < 12; t++) {
      const tri = [w.indices[t * 3]!, w.indices[t * 3 + 1]!, w.indices[t * 3 + 2]!];
      for (let k = 0; k < 3; k++) {
        const a = tri[k]!, b = tri[(k + 1) % 3]!;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every(c => c === 2)).toBe(true);
    expect(edges.size).toBe(18);
  });

  it('merges vertices within 1e-3 mm across grid cells, keeps ones further apart', () => {
    const pos = [0, 0, 0, 0.0004, 0, 0, -0.0004, 0, 0, 0.002, 0, 0, 5, 5, 5];
    const w = weldMesh(pos, [0, 3, 4, 1, 3, 4, 2, 3, 4]);
    expect(w.positions.length / 3).toBe(3);        // {0, ±0.0004} → one; 0.002 separate; (5,5,5)
    expect(w.degenerate).toBe(0);
    expect(Array.from(w.indices)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
    // a vertex pair straddling a grid-cell boundary (0.0009 apart, cells differ) still welds
    const w2 = weldMesh([0.00049, 0, 0, 0.00139, 0, 0, 1, 0, 0, 0, 1, 0], [0, 2, 3, 1, 2, 3]);
    expect(w2.positions.length / 3).toBe(3);
  });

  it('drops degenerate triangles and remaps face groups', () => {
    // tri 0 valid, tri 1 degenerate (two coincident vertices), tri 2 valid
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, /* tri1 */ 2, 0, 0, 2.0001, 0, 0, 3, 1, 0, /* tri2 */ 5, 0, 0, 6, 0, 0, 5, 1, 0];
    const w = weldMesh(pos, [0, 1, 2, 3, 4, 5, 6, 7, 8], 1e-3, [{ first: 0, last: 0 }, { first: 1, last: 1 }, { first: 2, last: 2 }, { first: 0, last: 2 }]);
    expect(w.degenerate).toBe(1);
    expect(w.indices.length / 3).toBe(2);
    expect(w.faceGroups).toEqual([{ first: 0, last: 0 }, { first: 1, last: 1 }, { first: 0, last: 1 }]);
    expect(w.droppedGroups).toBe(1);
  });
});

describe('importMesh — STL', () => {
  for (const name of SAMPLE_NAMES) {
    it(`${name}.stl: bounds match expected.foldedBounds within 0.1 mm, vertices welded`, async () => {
      const truth = loadTruth(name);
      const bytes = readSampleBytes(name, 'stl');
      const raw = parseStl(bytes);
      const mesh = await importMesh(bytes, 'stl', { name });
      expect(mesh.units).toBe('mm');
      expect(mesh.name).toBe(name);
      expect(mesh.warnings).toEqual([]);
      expect(mesh.faceGroups).toBeUndefined();
      const [dx, dy, dz] = extents(mesh.positions);
      const fb = truth.expected.foldedBounds;
      expect(Math.abs(dx - fb.x)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(dy - fb.y)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(dz - fb.z)).toBeLessThanOrEqual(0.1);
      expect(mesh.indices.length).toBe(raw.indices.length);
      expect(mesh.positions.length).toBeLessThan(raw.positions.length);
      expect(mesh.positions.length / 3).toBeLessThan(raw.positions.length / 9);   // fewer vertices than triangles
      let max = 0;
      for (const i of mesh.indices) if (i > max) max = i;
      expect(max).toBeLessThan(mesh.positions.length / 3);
    });
  }

  it('reads a hand-written ASCII STL and the equivalent binary STL identically', async () => {
    const cube = cubeSoup(20);
    const ascii = await importMesh(new TextEncoder().encode(asciiStl(cube.positions)), 'stl');
    const binary = await importMesh(binaryStl(cube.positions), 'stl');
    for (const m of [ascii, binary]) {
      expect(m.positions.length / 3).toBe(8);
      expect(m.indices.length / 3).toBe(12);
      expect(extents(m.positions)).toEqual([20, 20, 20]);
      expect(m.warnings).toEqual([]);
    }
    expect(Array.from(ascii.indices)).toEqual(Array.from(binary.indices));
  });

  it('ASCII STL with scientific notation and a "solid" prefix on a binary file', async () => {
    const text = 'solid s\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1e1 0.0 0\nvertex 0 1.0E+1 -0.0\nendloop\nendfacet\nendsolid s\n';
    const m = await importMesh(new TextEncoder().encode(text), 'stl', { units: 'mm' });
    expect(m.indices.length).toBe(3);
    expect(extents(m.positions)).toEqual([10, 10, 0]);
    const bin = binaryStl(cubeSoup(30).positions);
    new TextEncoder().encodeInto('solid binary-but-named-solid', bin);
    const mb = await importMesh(bin, 'stl');
    expect(mb.positions.length / 3).toBe(8);
  });

  it('metres heuristic: a 0.2-unit part is scaled ×1000 with a warning; explicit units skip it', async () => {
    const small = await importMesh(binaryStl(cubeSoup(0.2).positions), 'stl');
    expect(extents(small.positions).map(v => Math.round(v))).toEqual([200, 200, 200]);
    expect(small.warnings.map(w => w.key)).toEqual(['warnings.mesh.unitsScaled']);
    expect(small.warnings[0]!.params).toEqual({ factor: 1000, assumed: 'm' });
    const inch = await importMesh(binaryStl(cubeSoup(2).positions), 'stl', { units: 'in' });
    expect(extents(inch.positions)[0]).toBeCloseTo(50.8, 4);
    expect(inch.warnings).toEqual([]);
    const mm = await importMesh(binaryStl(cubeSoup(2).positions), 'stl', { units: 'mm' });
    expect(extents(mm.positions)).toEqual([2, 2, 2]);
  });

  it('rejects garbage and empty meshes with ImportError', async () => {
    await expect(importMesh(new TextEncoder().encode('not an stl at all'), 'stl')).rejects.toBeInstanceOf(ImportError);
    await expect(importMesh(new Uint8Array(10), 'stl')).rejects.toBeInstanceOf(ImportError);
    const empty = binaryStl([]);
    await expect(importMesh(empty, 'stl')).rejects.toMatchObject({ key: 'errors.import.meshEmpty' });
    // three coincident vertices → degenerate → nothing left
    await expect(importMesh(binaryStl([1, 1, 1, 1, 1, 1, 1, 1, 1]), 'stl', { units: 'mm' })).rejects.toMatchObject({ key: 'errors.import.meshEmpty' });
    expect(() => parseStl(new Uint8Array(0))).toThrow(ImportError);
  });
});

describe('importMesh — OBJ', () => {
  it('reads a hand-written OBJ with quads, v/vt/vn tokens, comments and negative indices', async () => {
    const obj = [
      '# a 10 mm cube', 'mtllib x.mtl', 'o cube', 'v 0 0 0', 'v 10 0 0', 'v 10 10 0', 'v 0 10 0',
      'v 0 0 10', 'v 10 0 10', 'v 10 10 10', 'v 0 10 10', 'vn 0 0 1', 'vt 0 0', 's off', 'usemtl m',
      'f 1 4 3 2', 'f 5/1/1 6/1/1 7/1/1 8/1/1', 'f 1//1 2//1 6//1 5//1', 'f 2 3 7 6', 'f 3 4 8 7', 'f -5 -8 -4 -1',
    ].join('\n');
    const m = await importMesh(new TextEncoder().encode(obj), 'obj', { name: 'cube.obj' });
    expect(m.positions.length / 3).toBe(8);
    expect(m.indices.length / 3).toBe(12);
    expect(extents(m.positions)).toEqual([10, 10, 10]);
    expect(m.name).toBe('cube.obj');
    expect(m.warnings).toEqual([]);
  });

  it('rejects bad indices with a line number', () => {
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nf 1 2 9\n')).toThrow(ImportError);
    try { parseObj('v 0 0 0\nv 1 0 0\nf 1 2 9\n'); } catch (e) { expect((e as ImportError).params).toEqual({ line: 3 }); }
    expect(() => parseObj('v 0 0 x\n')).toThrow(ImportError);
  });
});

describe('importMesh — GLB', () => {
  it('reads a hand-made GLB (metres → mm) through three GLTFLoader, applying node transforms', async () => {
    const glb = makeGlb([0, 0, 0, 0.1, 0, 0, 0.1, 0.05, 0, 0, 0.05, 0], [0, 1, 2, 0, 2, 3], { translation: [0.5, 0, 0], scale: [1, 2, 1] });
    const m = await importMesh(glb, 'glb', { name: 'quad.glb' });
    expect(m.indices.length / 3).toBe(2);
    expect(m.positions.length / 3).toBe(4);
    const b = positionsBounds(m.positions);
    expect(b.min[0]).toBeCloseTo(500, 3);
    expect(b.max[0]).toBeCloseTo(600, 3);
    expect(b.max[1]).toBeCloseTo(100, 3);
    expect(m.warnings.map(w => w.key)).toEqual(['warnings.mesh.unitsScaled']);
  });

  it('rejects a broken GLB with a typed error', async () => {
    await expect(importMesh(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), 'glb')).rejects.toMatchObject({ key: 'errors.import.gltfUnsupported' });
  });

  it('ignores materials / textures / images (geometry only) and rejects external buffers', async () => {
    const pos = new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 0]);
    const b64 = Buffer.from(pos.buffer).toString('base64');
    const gltf = {
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0, sampler: 0 }], samplers: [{}],
      images: [{ uri: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
      extensionsUsed: ['KHR_texture_transform', 'KHR_materials_clearcoat'],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [100, 100, 0] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
      buffers: [{ byteLength: pos.byteLength, uri: `data:application/octet-stream;base64,${b64}` }],
    };
    const m = await importMesh(new TextEncoder().encode(JSON.stringify(gltf)), 'gltf');
    expect(m.indices.length).toBe(3);
    expect(extents(m.positions)).toEqual([100, 100, 0]);
    const external = { ...gltf, buffers: [{ byteLength: pos.byteLength, uri: 'part.bin' }] };
    await expect(importMesh(new TextEncoder().encode(JSON.stringify(external)), 'gltf')).rejects.toMatchObject({ key: 'errors.import.gltfUnsupported' });
    const { normalizeGltf, readGlbChunks } = await import('./gltf');
    const glb = new Uint8Array(normalizeGltf(new TextEncoder().encode(JSON.stringify(gltf)), 'gltf'));
    const chunks = readGlbChunks(glb);
    const json = JSON.parse(chunks.json) as Record<string, unknown>;
    expect(json['materials']).toBeUndefined();
    expect(json['images']).toBeUndefined();
    expect(json['extensionsUsed']).toEqual([]);
    expect(chunks.bin?.length).toBe(pos.byteLength);
  });

  it('reads an embedded .gltf (JSON with a data: URI buffer)', async () => {
    const pos = new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 0]);
    const b64 = Buffer.from(pos.buffer).toString('base64');
    const gltf = {
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [100, 100, 0] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
      buffers: [{ byteLength: pos.byteLength, uri: `data:application/octet-stream;base64,${b64}` }],
    };
    const m = await importMesh(new TextEncoder().encode(JSON.stringify(gltf)), 'gltf');
    expect(m.indices.length).toBe(3);
    expect(extents(m.positions)).toEqual([100, 100, 0]);
    expect(m.warnings).toEqual([]);
  });
});
