/**
 * Mesh importers: STL (binary + ASCII) and OBJ by hand (pure TS, run in Node), GLB / GLTF via
 * three's GLTFLoader behind a dynamic import. Output: welded `TriangleMesh` in mm.
 * See docs/specs/import-files.md §4.
 */
import type { TriangleMesh, Message } from '../types';
import type { Object3D, Mesh, InstancedMesh, BufferAttribute, InterleavedBufferAttribute } from 'three';
import { ImportError, asImportError, warn } from './errors';
import { parseStl } from './stl';
import type { RawMesh } from './stl';
import { parseObj } from './obj';
import { normalizeGltf } from './gltf';
import { weldMesh, positionsBounds, WELD_TOL } from './weld';

export type MeshExt = 'stl' | 'obj' | 'glb' | 'gltf';
export type MeshUnits = 'auto' | 'mm' | 'in' | 'm' | 'cm';

export interface MeshOptions {
  /** TriangleMesh.name (default = the extension). */
  name?: string;
  /** Source units: 'auto' (default) applies the metres heuristic, others scale explicitly. */
  units?: MeshUnits;
}

/** A TriangleMesh plus the importer's warnings (structurally still a TriangleMesh). */
export interface ImportedMesh extends TriangleMesh { warnings: Message[] }

/** Bounding-box extent (in file units) below which an 'auto' mesh is taken as metres. */
export const METRES_EXTENT_LIMIT = 5;

const UNIT_SCALE: Record<Exclude<MeshUnits, 'auto'>, number> = { mm: 1, in: 25.4, m: 1000, cm: 10 };

export async function importMesh(buffer: Uint8Array, ext: MeshExt, opts: MeshOptions = {}): Promise<ImportedMesh> {
  const warnings: Message[] = [];
  let raw: RawMesh;
  switch (ext) {
    case 'stl': raw = parseStl(buffer); break;
    case 'obj': raw = parseObj(new TextDecoder('utf-8', { fatal: false }).decode(buffer)); break;
    case 'glb':
    case 'gltf': raw = await loadGltf(buffer, ext, warnings); break;
    default: throw new ImportError('errors.import.unsupportedExtension', { ext: String(ext) });
  }
  return finishMesh(raw, opts.name ?? ext, opts.units ?? 'auto', warnings);
}

/** Scale to mm (heuristic or explicit), weld, and build the TriangleMesh. */
export function finishMesh(raw: RawMesh, name: string, units: MeshUnits, warnings: Message[], faceGroups?: Array<{ first: number; last: number }>): ImportedMesh {
  if (raw.indices.length < 3 || raw.positions.length < 9) throw new ImportError('errors.import.meshEmpty');
  let factor = 1;
  if (units === 'auto') {
    const b = positionsBounds(raw.positions);
    const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    if (Number.isFinite(extent) && extent > 0 && extent < METRES_EXTENT_LIMIT) {
      factor = 1000;
      warnings.push(warn('warnings.mesh.unitsScaled', { factor, assumed: 'm' }));
    }
  } else {
    factor = UNIT_SCALE[units];
  }
  let positions: ArrayLike<number> = raw.positions;
  if (factor !== 1) {
    const scaled = new Float32Array(raw.positions.length);
    for (let i = 0; i < scaled.length; i++) scaled[i] = raw.positions[i]! * factor;
    positions = scaled;
  }
  const welded = weldMesh(positions, raw.indices, WELD_TOL, faceGroups);
  if (welded.degenerate > 0) warnings.push(warn('warnings.mesh.degenerateTriangles', { count: welded.degenerate }));
  if (welded.indices.length < 3) throw new ImportError('errors.import.meshEmpty');
  const mesh: ImportedMesh = {
    positions: welded.positions,
    indices: welded.indices,
    units: 'mm',
    name,
    warnings,
  };
  if (welded.faceGroups) mesh.faceGroups = welded.faceGroups;
  return mesh;
}

// ─── GLB / GLTF via three ────────────────────────────────────────────────────

type PositionAttr = BufferAttribute | InterleavedBufferAttribute;

async function loadGltf(buffer: Uint8Array, ext: 'glb' | 'gltf', warnings: Message[]): Promise<RawMesh> {
  // Self-contained GLB (buffers merged, materials stripped): GLTFLoader.parse never fetches.
  const data = normalizeGltf(buffer, ext);
  let gltfScene: Object3D;
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const gltf = await new Promise<{ scene: Object3D }>((resolve, reject) => {
      loader.parse(data, '', g => resolve(g), err => reject(err instanceof Error ? err : new Error(String((err as { message?: string })?.message ?? err))));
    });
    gltfScene = gltf.scene;
  } catch (err) {
    throw asImportError(err, 'errors.import.gltfUnsupported');
  }
  gltfScene.updateMatrixWorld(true);
  const positions: number[] = [];
  const indices: number[] = [];
  let skipped = 0;
  gltfScene.traverse((obj: Object3D) => {
    const mesh = obj as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    const geometry = mesh.geometry;
    const pos = geometry?.attributes?.position as PositionAttr | undefined;
    if (!pos) { skipped++; return; }
    const matrices: number[][] = [];
    const inst = mesh as InstancedMesh;
    if ((inst as { isInstancedMesh?: boolean }).isInstancedMesh && inst.instanceMatrix) {
      const im = inst.instanceMatrix.array;
      for (let i = 0; i < inst.count; i++) {
        const local = Array.from(im.subarray(i * 16, i * 16 + 16));
        matrices.push(mulMat4(mesh.matrixWorld.elements, local));
      }
    } else {
      matrices.push(Array.from(mesh.matrixWorld.elements));
    }
    const index = geometry.index;
    const n = pos.count;
    for (const m of matrices) {
      const base = positions.length / 3;
      for (let i = 0; i < n; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        positions.push(
          m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
          m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
          m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
        );
      }
      if (index) {
        const arr = index.array;
        const cnt = index.count - (index.count % 3);
        for (let i = 0; i < cnt; i++) indices.push(base + arr[i]!);
      } else {
        const cnt = n - (n % 3);
        for (let i = 0; i < cnt; i++) indices.push(base + i);
      }
    }
  });
  if (skipped > 0) warnings.push(warn('warnings.mesh.primitivesSkipped', { count: skipped }));
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Column-major 4×4 product a·b (b applied first). */
function mulMat4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = s;
  }
  return out;
}
