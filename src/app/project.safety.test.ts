// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LibraryStore } from '../core/library';
import { loadTruth } from '../core/testing/fixtures';
import type { Message } from '../core/types';
import { translate } from '../i18n';
import { createProjectStore, selectMachine, selectMaterial } from './store';
import { parseProject, programToCsv, programToJson, serializeProject } from './project';

describe('program export safety', () => {
  it('round-trips an unknown tool rating as null and never exports it as zero percent', async () => {
    const store = createProjectStore({ libraryStore: new LibraryStore({ storage: null, fetch: null }), useWorker: false, language: 'en' });
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    await store.getState().plan();

    const state = store.getState();
    const planned = state.project.program!;
    expect(planned.steps).toHaveLength(1);
    expect(planned.steps[0]!.loadPercentOfTool).toBeNull();

    const mismatch: Message = {
      key: 'warnings.setup.controllerCadGeometryMismatch',
      severity: 'warning',
      params: { stationId: 'S1', slotNumber: '2', controllerV: 24, controllerAngle: 86, controllerRadius: 4, cadV: 20, cadAngle: 90, cadRadius: 1 },
    };
    const program = { ...planned, warnings: [mismatch] };
    const project = { ...state.project, program };
    const ctx = { program, part: project.part, machine: selectMachine(state), material: selectMaterial(state), library: state.simLibrary };

    const json = JSON.parse(programToJson(ctx));
    expect(json.steps[0].loadPercentOfTool).toBeNull();

    const csv = programToCsv(ctx, 'th');
    expect(csv).toContain(`— ${translate('th', 'warnings.tool.loadUnverified', { tools: `${program.steps[0]!.punchName} / ${program.steps[0]!.dieName}` })}`);
    expect(csv).toContain(translate('th', mismatch.key, mismatch.params));

    const saved = serializeProject(project, state.library);
    const parsed = parseProject(saved, { machineId: state.project.machineId, materialId: state.project.materialId });
    expect(parsed.program?.steps[0]?.loadPercentOfTool).toBeNull();
  });
});
