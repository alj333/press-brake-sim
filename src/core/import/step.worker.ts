/**
 * Module Web Worker: reads a STEP file with occt-import-js off the main thread, merges the bodies
 * and welds the vertices, then posts the arrays back with transfer.
 * Started by `importStep` as `new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' })`.
 */
import { loadOcct, OCCT_PARAMS } from './occt-loader';
import { mergeOcctMeshes } from './step-merge';
import { weldMesh, WELD_TOL } from './weld';
import type { FaceGroup } from './weld';
import { ImportError } from './errors';

export interface StepWorkerRequest { buffer: Uint8Array }

export type StepWorkerResponse =
  | {
    ok: true;
    positions: Float32Array;
    indices: Uint32Array;
    faceGroups: FaceGroup[];
    meshCount: number;
    degenerate: number;
    droppedGroups: number;
    rawVertexCount: number;
  }
  | { ok: false; key: string; params?: Record<string, string | number>; error: string };

interface WorkerScope {
  onmessage: ((e: MessageEvent<StepWorkerRequest>) => void) | null;
  postMessage(msg: StepWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = async (e: MessageEvent<StepWorkerRequest>) => {
  try {
    const occt = await loadOcct();
    const result = occt.ReadStepFile(e.data.buffer, OCCT_PARAMS);
    const merged = mergeOcctMeshes(result);
    const welded = weldMesh(merged.positions, merged.indices, WELD_TOL, merged.faceGroups);
    const msg: StepWorkerResponse = {
      ok: true,
      positions: welded.positions,
      indices: welded.indices,
      faceGroups: welded.faceGroups ?? [],
      meshCount: merged.meshCount,
      degenerate: welded.degenerate,
      droppedGroups: welded.droppedGroups,
      rawVertexCount: welded.rawVertexCount,
    };
    scope.postMessage(msg, [welded.positions.buffer, welded.indices.buffer]);
  } catch (err) {
    const msg: StepWorkerResponse = err instanceof ImportError
      ? { ok: false, key: err.key, params: err.params, error: err.message }
      : { ok: false, key: 'errors.import.stepFailed', params: { detail: err instanceof Error ? err.message : String(err) }, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(msg);
  }
};
