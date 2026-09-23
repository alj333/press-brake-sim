/**
 * ui — planner Web Worker: runs the synchronous `planProgram` off the main thread so the 3D
 * viewport stays responsive and progress / cancel work (cancel = terminate). The store falls
 * back to in-thread planning (with the AbortSignal) where module workers are unavailable.
 */
import type { BendProgram } from '../core/types';
import { planProgram } from '../core/planner';
import type { PlannerInput, PlannerProgress } from '../core/planner';

export type PlanWorkerRequest = { type: 'plan'; input: PlannerInput };
export type PlanWorkerResponse =
  | { type: 'progress'; progress: PlannerProgress }
  | { type: 'done'; program: BendProgram }
  | { type: 'error'; name: string; message: string };

const ctx = self as unknown as { postMessage(msg: PlanWorkerResponse): void; onmessage: ((e: MessageEvent<PlanWorkerRequest>) => void) | null };

ctx.onmessage = (e: MessageEvent<PlanWorkerRequest>) => {
  const req = e.data;
  if (!req || req.type !== 'plan') return;
  try {
    let last = 0;
    const program = planProgram(req.input, undefined, progress => {
      const now = Date.now();
      if (now - last >= 60 || progress.phase === 'assemble') { last = now; ctx.postMessage({ type: 'progress', progress }); }
    });
    ctx.postMessage({ type: 'done', program });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ type: 'error', name, message });
  }
};
