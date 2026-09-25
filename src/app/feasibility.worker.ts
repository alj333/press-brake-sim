/** Runs the bounded feasibility recommendation graph off the UI thread. */
import type { BendProgram } from '../core/types';
import { recommendSetups } from '../core/planner';
import type { FeasibilityProgress, FeasibilityReport, PlannerInput } from '../core/planner';

export type FeasibilityWorkerRequest = { type: 'analyse'; input: PlannerInput; baseline: BendProgram };
export type FeasibilityWorkerResponse =
  | { type: 'progress'; progress: FeasibilityProgress }
  | { type: 'done'; report: FeasibilityReport }
  | { type: 'error'; name: string; message: string };

const ctx = self as unknown as {
  postMessage(message: FeasibilityWorkerResponse): void;
  onmessage: ((event: MessageEvent<FeasibilityWorkerRequest>) => void) | null;
};

ctx.onmessage = event => {
  if (!event.data || event.data.type !== 'analyse') return;
  try {
    const report = recommendSetups(event.data.input, event.data.baseline, undefined, progress => {
      ctx.postMessage({ type: 'progress', progress });
    });
    ctx.postMessage({ type: 'done', report });
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
