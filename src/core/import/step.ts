/**
 * STEP importer (occt-import-js): in the browser the WASM runs in a module Web Worker
 * (`step.worker.ts`), in Node (tests) it is called directly through `loadOcct()`.
 * Output: welded `TriangleMesh` in mm with `faceGroups` = B-rep faces as triangle index ranges.
 * See docs/specs/import-files.md §5.
 */
import type { Message } from '../types';
import { loadOcct, OCCT_PARAMS } from './occt-loader';
import { mergeOcctMeshes } from './step-merge';
import { weldMesh, WELD_TOL } from './weld';
import type { FaceGroup } from './weld';
import { ImportError, warn } from './errors';
import type { ImportedMesh } from './mesh';
import type { StepWorkerRequest, StepWorkerResponse } from './step.worker';

interface WeldedStep {
  positions: Float32Array;
  indices: Uint32Array;
  faceGroups: FaceGroup[];
  meshCount: number;
  degenerate: number;
  droppedGroups: number;
  rawVertexCount: number;
}

/** Read + merge + weld in this thread (Node, or a fallback). */
export async function readStepHere(buffer: Uint8Array): Promise<WeldedStep> {
  const occt = await loadOcct();
  let result;
  try {
    result = occt.ReadStepFile(buffer, OCCT_PARAMS);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ImportError('errors.import.stepFailed', { detail }, detail);
  }
  const merged = mergeOcctMeshes(result);
  const welded = weldMesh(merged.positions, merged.indices, WELD_TOL, merged.faceGroups);
  return {
    positions: welded.positions, indices: welded.indices, faceGroups: welded.faceGroups ?? [],
    meshCount: merged.meshCount, degenerate: welded.degenerate, droppedGroups: welded.droppedGroups,
    rawVertexCount: welded.rawVertexCount,
  };
}

function readStepInWorker(buffer: Uint8Array): Promise<WeldedStep> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<StepWorkerResponse>) => {
      worker.terminate();
      const d = e.data;
      if (d.ok) {
        resolve({
          positions: d.positions, indices: d.indices, faceGroups: d.faceGroups, meshCount: d.meshCount,
          degenerate: d.degenerate, droppedGroups: d.droppedGroups, rawVertexCount: d.rawVertexCount,
        });
      } else {
        reject(new ImportError(d.key, d.params, d.error));
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      worker.terminate();
      const detail = e.message || 'worker error';
      reject(new ImportError('errors.import.workerFailed', { detail }, detail));
    };
    const copy = buffer.slice();                   // own the buffer we transfer
    const req: StepWorkerRequest = { buffer: copy };
    worker.postMessage(req, [copy.buffer]);
  });
}

const hasWorker = typeof window !== 'undefined' && typeof Worker !== 'undefined';

async function readStep(buffer: Uint8Array): Promise<WeldedStep> {
  if (!hasWorker) return readStepHere(buffer);
  try {
    return await readStepInWorker(buffer);
  } catch (err) {
    // The worker itself could not start or load (module workers unsupported, CSP, bundle issue):
    // fall back to reading on this thread. Typed STEP errors are the file's fault — re-thrown.
    if (err instanceof ImportError && err.key === 'errors.import.workerFailed') return readStepHere(buffer);
    throw err;
  }
}

export async function importStep(buffer: Uint8Array, name = 'step'): Promise<ImportedMesh> {
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) throw new ImportError('errors.import.stepFailed', { detail: 'empty buffer' }, 'empty buffer');
  const data = await readStep(buffer);
  if (data.indices.length < 3) throw new ImportError('errors.import.meshEmpty');
  const warnings: Message[] = [];
  if (data.meshCount > 1) warnings.push(warn('warnings.step.multipleBodies', { count: data.meshCount }, 'info'));
  if (data.degenerate > 0) warnings.push(warn('warnings.mesh.degenerateTriangles', { count: data.degenerate }));
  const mesh: ImportedMesh = {
    positions: data.positions,
    indices: data.indices,
    units: 'mm',
    name,
    warnings,
  };
  // An empty group list would make a faceGroups-driven recognizer see no faces at all.
  if (data.faceGroups.length > 0) mesh.faceGroups = data.faceGroups;
  return mesh;
}
