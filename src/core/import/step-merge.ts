/**
 * Pure merge of an occt-import-js result into one triangle soup with B-rep face groups
 * (triangle index ranges, inclusive, offset by the prior meshes' triangle counts).
 * Shared by `step.ts` (Node path) and `step.worker.ts` (browser path).
 */
import type { OcctResult } from 'occt-import-js';
import { ImportError } from './errors';
import type { FaceGroup } from './weld';

export interface MergedStep {
  positions: Float32Array;
  indices: Uint32Array;
  faceGroups: FaceGroup[];
  meshCount: number;
}

export function mergeOcctMeshes(result: OcctResult | null | undefined): MergedStep {
  if (!result || !result.success) throw new ImportError('errors.import.stepFailed', { detail: 'occt could not read the file' }, 'occt could not read the file');
  const meshes = result.meshes ?? [];
  if (meshes.length === 0) throw new ImportError('errors.import.stepFailed', { detail: 'no bodies' }, 'no bodies');
  let vertexTotal = 0, indexTotal = 0;
  for (const m of meshes) {
    vertexTotal += Math.floor((m.attributes?.position?.array?.length ?? 0) / 3);
    indexTotal += m.index?.array?.length ?? 0;
  }
  if (vertexTotal === 0 || indexTotal < 3) throw new ImportError('errors.import.meshEmpty');
  const positions = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal - (indexTotal % 3));
  const faceGroups: FaceGroup[] = [];
  let vOff = 0, iOff = 0, triOff = 0;
  for (const m of meshes) {
    const pos = m.attributes.position.array;
    const idx = m.index.array;
    positions.set(pos, vOff * 3);
    const triCount = Math.floor(idx.length / 3);
    for (let i = 0; i < triCount * 3; i++) indices[iOff + i] = idx[i]! + vOff;
    for (const f of m.brep_faces ?? []) {
      if (f.last < f.first) continue;
      faceGroups.push({ first: f.first + triOff, last: Math.min(f.last, triCount - 1) + triOff });
    }
    vOff += Math.floor(pos.length / 3);
    iOff += triCount * 3;
    triOff += triCount;
  }
  return { positions, indices, faceGroups, meshCount: meshes.length };
}
