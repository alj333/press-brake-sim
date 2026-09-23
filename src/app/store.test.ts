// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTruth, readSampleBytes, readSampleText, samplePath } from '../core/testing/fixtures';
import { LibraryStore } from '../core/library';
import { currentStepIndex, useSimStore } from '../sim/store';
import { createProjectStore, selectMachine, selectMachineMessages, selectMaterial, selectSetupMessages } from './store';
import { parseProject, programToCsv, programToJson, serializeProject } from './project';
import { fmt, fmtForce, kNToTonnes, parseNumberList } from './format';

function makeStore() {
  return createProjectStore({ libraryStore: new LibraryStore({ storage: null, fetch: null }), useWorker: false, language: 'en' });
}

describe('project store — part editing', () => {
  it('loadFlat builds the L-bracket part and clears the program', () => {
    const store = makeStore();
    const truth = loadTruth('L-bracket');
    store.getState().loadFlat(truth.flat);
    const s = store.getState();
    expect(s.project.part).not.toBeNull();
    expect(s.project.part!.flanges.length).toBe(2);
    expect(s.project.part!.links.length).toBe(1);
    expect(s.thickness).toBe(2);
    expect(s.project.materialId).toBe('std:mild-steel');
    expect(s.project.name).toBe('L-bracket');
    expect(s.project.program).toBeNull();
    expect(useSimStore.getState().keyframes).toEqual([]);
  });

  it('setBend recomputes the part model and marks the attribute as user-set', () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    const before = store.getState().project.part!;
    const ba0 = before.bendAllowance['B1']!;
    store.getState().setBend('B1', { angle: 120, innerRadius: 3 });
    const after = store.getState().project.part!;
    expect(after).not.toBe(before);
    const b = after.flat.bends.find(x => x.id === 'B1')!;
    expect(b.angle).toBe(120);
    expect(b.innerRadius).toBe(3);
    expect(b.sources.angle).toBe('user');
    expect(b.sources.radius).toBe('user');
    expect(b.sources.direction).toBe(before.flat.bends[0]!.sources.direction);
    expect(after.bendAllowance['B1']).not.toBeCloseTo(ba0, 6);
    // direction toggle and correction
    store.getState().setBend('B1', { direction: 'down', angleCorrection: 1.5 });
    const b2 = store.getState().project.part!.flat.bends[0]!;
    expect(b2.direction).toBe('down');
    expect(b2.sources.direction).toBe('user');
    expect(b2.angleCorrection).toBe(1.5);
    // angle is clamped to (0, 180]; a 180° bend becomes a closed hem
    store.getState().setBend('B1', { angle: 500 });
    expect(store.getState().project.part!.flat.bends[0]!.angle).toBe(180);
    expect(store.getState().project.part!.flat.bends[0]!.hem).toBe('closed');
    // unknown bend id is ignored
    const p = store.getState().project.part;
    store.getState().setBend('B99', { angle: 45 });
    expect(store.getState().project.part).toBe(p);
  });

  it('setThickness / setMaterial rebuild the flat', () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().setThickness(1.5);
    expect(store.getState().thickness).toBe(1.5);
    expect(store.getState().project.part!.flat.thickness).toBe(1.5);
    store.getState().setMaterial('std:stainless-304');
    expect(store.getState().project.materialId).toBe('std:stainless-304');
    expect(store.getState().project.part!.flat.materialId).toBe('std:stainless-304');
    expect(selectMaterial(store.getState())!.id).toBe('std:stainless-304');
    store.getState().setMaterial('nope');
    expect(store.getState().project.materialId).toBe('std:stainless-304');
    store.getState().setThickness(-1);
    expect(store.getState().thickness).toBe(1.5);
  });

  it('addBend / removeBend rebuild the flange tree', () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    const id = store.getState().addBend({ x: 20, y: 0 }, { x: 20, y: 80 });
    expect(id).toBe('B2');
    const part = store.getState().project.part!;
    expect(part.flat.bends.length).toBe(2);
    expect(part.flanges.length).toBe(3);
    const b = part.flat.bends.find(x => x.id === 'B2')!;
    expect(b.sources).toEqual({ geometry: 'user', angle: 'user', radius: 'user', direction: 'user' });
    expect(b.innerRadius).toBeCloseTo(2.56, 2);   // 1.28·t for mild steel
    expect(store.getState().selectedBendId).toBe('B2');
    expect(store.getState().addBend({ x: 1, y: 1 }, { x: 1, y: 1.1 })).toBeNull();
    store.getState().removeBend('B2');
    expect(store.getState().project.part!.flat.bends.length).toBe(1);
    expect(store.getState().project.part!.flanges.length).toBe(2);
    expect(store.getState().selectedBendId).toBeNull();
  });
});

describe('project store — tools and machine', () => {
  it('starts with the default setup and validates changes', () => {
    const store = makeStore();
    const s = store.getState();
    expect(s.project.setup.stations.length).toBe(1);
    expect(s.project.setup.stations[0]!.dieId).toBe('std:die-v16-88');
    expect(selectSetupMessages(s)).toEqual([]);
    expect(selectMachineMessages(s)).toEqual([]);
    store.getState().updateStation('S1', { zEnd: 1000 });
    const st = store.getState().project.setup.stations[0]!;
    expect(st.zEnd).toBe(1000);
    expect(st.segments.reduce((a, b) => a + b, 0)).toBe(1000);
    store.getState().addStation();
    const s2 = store.getState().project.setup.stations;
    expect(s2.length).toBe(2);
    expect(s2[1]!.id).toBe('S2');
    expect(s2[1]!.zStart).toBeGreaterThanOrEqual(1000);
    expect(selectSetupMessages(store.getState())).toEqual([]);
    store.getState().updateStation('S2', { zStart: 500 });
    expect(selectSetupMessages(store.getState()).some(m => m.key === 'warnings.setup.stationsOverlap')).toBe(true);
    store.getState().removeStation('S2');
    expect(store.getState().project.setup.stations.length).toBe(1);
    store.getState().resetSetup();
    expect(store.getState().project.setup.stations[0]!.zEnd).toBe(3100);
  });

  it('updateMachine edits the library copy; saveMachineAs creates a custom machine', () => {
    const store = makeStore();
    store.getState().updateMachine({ bedLength: 2500, backgauge: { retractAtPinch: 15 }, ram: { speeds: { bend: 8 } } });
    const m = selectMachine(store.getState());
    expect(m.bedLength).toBe(2500);
    expect(m.backgauge.retractAtPinch).toBe(15);
    expect(m.ram.speeds.bend).toBe(8);
    expect(m.ram.speeds.approach).toBe(100);
    expect(m.id).toBe('std:machine-generic-100t');
    store.getState().updateMachine({ stroke: 10 });
    expect(selectMachineMessages(store.getState()).some(x => x.key === 'warnings.machine.strokeTooShort')).toBe(true);
    store.getState().updateMachine({ stroke: 200 });
    const id = store.getState().saveMachineAs('Shop brake');
    expect(id.startsWith('custom:')).toBe(true);
    expect(store.getState().project.machineId).toBe(id);
    expect(store.getState().project.setup.machineId).toBe(id);
    expect(store.getState().library.machines.length).toBe(2);
    store.getState().setMachine('std:machine-generic-100t');
    expect(store.getState().project.machineId).toBe('std:machine-generic-100t');
    expect(store.getState().removeLibraryItem(id)).toBe(true);
    expect(store.getState().removeLibraryItem('std:die-v16-88')).toBe(false);   // mounted
  });
});

describe('project store — planning', () => {
  beforeEach(() => { useSimStore.getState().setKeyframes([]); });

  it('plan() yields a feasible one-step program for the L-bracket and pushes keyframes', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    await store.getState().plan();
    const s = store.getState();
    expect(s.planning).toBe(false);
    expect(s.planError).toBeNull();
    const program = s.project.program!;
    expect(program).not.toBeNull();
    expect(program.steps.length).toBe(1);
    expect(program.feasible).toBe(true);
    expect(program.steps[0]!.bendId).toBe('B1');
    expect(program.steps[0]!.force).toBeCloseTo(11.93, 1);
    expect(useSimStore.getState().keyframes.length).toBeGreaterThan(100);
    expect(s.selectedStepIndex).toBe(0);
    expect(s.notices.some(n => n.message.key === 'app.notice.planned')).toBe(true);
    // editing a bend invalidates the program and the timeline
    store.getState().setBend('B1', { angle: 100 });
    expect(store.getState().project.program).toBeNull();
    expect(useSimStore.getState().keyframes).toEqual([]);
  });

  it('setup changes mark the program stale; setFixedOrder is honoured on the U-channel', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('U-channel').flat);
    await store.getState().plan();
    const auto = store.getState().project.program!.steps.map(st => st.bendId);
    expect(auto.length).toBe(2);
    store.getState().updateStation('S1', { punchFlipped: true });
    expect(store.getState().programStale).toBe(true);
    const reversed = [...auto].reverse();
    store.getState().setFixedOrder(reversed);
    expect(store.getState().project.plannerOptions.fixedOrder).toEqual(reversed);
    await store.getState().plan();
    expect(store.getState().programStale).toBe(false);
    expect(store.getState().project.program!.steps.map(st => st.bendId)).toEqual(reversed);
    store.getState().setFixedOrder(null);
    expect(store.getState().project.plannerOptions.fixedOrder).toBeUndefined();
    expect(store.getState().fixedOrder).toBeNull();
  });

  it('plan() refuses without a part / stations and can be cancelled before it starts', async () => {
    const store = makeStore();
    await store.getState().plan();
    expect(store.getState().project.program).toBeNull();
    expect(store.getState().notices.some(n => n.message.key === 'errors.plan.noPart')).toBe(true);
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().setSetup({ machineId: store.getState().project.machineId, stations: [] });
    await store.getState().plan();
    expect(store.getState().notices.some(n => n.message.key === 'errors.plan.noStations')).toBe(true);
    store.getState().resetSetup();
    const p = store.getState().plan();
    expect(store.getState().planning).toBe(true);
    store.getState().cancelPlan();
    expect(store.getState().planning).toBe(false);
    await p;
    expect(store.getState().project.program).toBeNull();
  });

  it('seekToCollision / selectStep move the sim cursor', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('U-channel').flat);
    await store.getState().plan();
    const program = store.getState().project.program!;
    store.getState().selectStep(1);
    expect(currentStepIndex(useSimStore.getState())).toBe(1);
    const step = program.steps[1]!;
    store.getState().seekToCollision(step, {
      with: 'die', atFraction: 0.5, depth: 1, severity: 'error', location: { x: 0, y: 0, z: 0 }, message: { key: 'collisions.die' },
    });
    const t = useSimStore.getState().timeS;
    const k = useSimStore.getState().keyframes.filter(f => f.stepIndex === 1 && f.phase === 'bend');
    expect(t).toBeGreaterThanOrEqual(k[0]!.timeS);
    expect(t).toBeLessThanOrEqual(k[k.length - 1]!.timeS);
    expect(store.getState().selectedStepIndex).toBe(1);
  });
});

describe('project store — files', () => {
  it('saveProject → loadProject round trip keeps the part, setup, program and language', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('Z-bracket').flat);
    store.getState().setProjectName('Z test');
    store.getState().saveMachineAs('Custom brake');
    await store.getState().plan();
    const steps = store.getState().project.program!.steps.length;
    store.getState().setLanguage('th');
    const json = store.getState().saveProject();
    const parsed = JSON.parse(json);
    expect(parsed.app).toBe('press-brake-sim');
    expect(parsed.libraryOverlay.machines.some((m: { id: string }) => m.id.startsWith('custom:'))).toBe(true);
    expect(parsed.libraryOverlay.punches.length).toBe(1);

    const other = makeStore();
    other.getState().loadProject(json);
    const s = other.getState();
    expect(s.project.name).toBe('Z test');
    expect(s.project.part!.flanges.length).toBe(3);
    expect(s.project.program!.steps.length).toBe(steps);
    expect(s.project.machineId.startsWith('custom:')).toBe(true);
    expect(s.library.machines.some(m => m.id === s.project.machineId)).toBe(true);
    expect(s.project.language).toBe('th');
    expect(useSimStore.getState().keyframes.length).toBeGreaterThan(0);
    store.getState().setLanguage('en');

    expect(() => parseProject('nope', { machineId: 'a', materialId: 'b' })).toThrow();
    expect(() => parseProject('{"app":"other"}', { machineId: 'a', materialId: 'b' })).toThrow();
    expect(() => other.getState().loadProject('{"version": 99, "part": null}')).toThrow();
  });

  it('exports the program as JSON and bilingual CSV', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    await store.getState().plan();
    const s = store.getState();
    const ctx = { program: s.project.program!, part: s.project.part, machine: selectMachine(s), material: selectMaterial(s), library: s.simLibrary };
    const json = JSON.parse(programToJson(ctx));
    expect(json.steps.length).toBe(1);
    expect(json.maxForceTonnes).toBeCloseTo(kNToTonnes(json.maxForce), 6);
    const csv = programToCsv(ctx, 'th');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('Step / ขั้นตอน');
    const lines = csv.trim().split('\r\n');
    expect(lines[lines.length - 1]!.split(',').length).toBeGreaterThan(20);
    expect(serializeProject(s.project, s.library)).toContain('"libraryOverlay"');
  });

  it('importFiles: STL is recognised, a DXF is matched to it', async () => {
    const store = makeStore();
    const stlBytes = readSampleBytes('L-bracket', 'stl');
    const stl = new File([stlBytes.buffer.slice(stlBytes.byteOffset, stlBytes.byteOffset + stlBytes.byteLength) as ArrayBuffer], 'L-bracket.stl');
    await store.getState().importFiles([stl]);
    let s = store.getState();
    expect(s.recognized).not.toBeNull();
    expect(s.recognized!.bendCount).toBe(1);
    expect(s.project.part!.flanges.length).toBe(2);
    expect(s.project.part!.flat.bends[0]!.sources.angle).toBe('mesh');
    expect(s.thickness).toBeCloseTo(2, 1);
    expect(s.importing).toBe(false);
    const dxf = new File([readSampleText('L-bracket', 'dxf')], 'L-bracket-flat.dxf');
    await store.getState().importFiles([dxf]);
    s = store.getState();
    expect(s.dxfFlat).not.toBeNull();
    expect(s.matchInfo).toEqual({ pairs: 1, count: 1, mirrored: false });
    const b = s.project.part!.flat.bends[0]!;
    expect(b.sources.geometry).toBe('dxf');
    expect(b.sources.angle).toBe('mesh');
    expect(b.sources.radius).toBe('mesh');
    expect(s.project.part!.flat.holes.length).toBe(1);
    // an unsupported file produces an error message, not an exception
    await store.getState().importFiles([new File(['x'], 'notes.txt')]);
    expect(store.getState().importWarnings.some(w => w.key === 'errors.import.unsupportedExtension')).toBe(true);
  });

  it('loadSample fetches the DXF and STEP of a sample', async () => {
    const store = makeStore();
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const m = /\/samples\/([^/]+)\/(.+)$/.exec(url);
      if (!m) return new Response(null, { status: 404 });
      const file = m[2]!.endsWith('.step') ? samplePath(m[1] as 'L-bracket', 'step') : samplePath(m[1] as 'L-bracket', 'dxf');
      return new Response(readFileSync(file), { status: 200 });
    }) as typeof fetch;
    try {
      await store.getState().loadSample('L-bracket');
    } finally {
      globalThis.fetch = original;
    }
    const s = store.getState();
    expect(s.project.part!.flanges.length).toBe(2);
    expect(s.recognized!.flat.bends[0]!.sources.angle).toBe('step');
    expect(s.project.part!.flat.bends[0]!.sources.angle).toBe('step');
    expect(s.project.part!.flat.bends[0]!.sources.geometry).toBe('dxf');
    expect(s.project.name).toBe('L-bracket');
    expect(s.importWarnings.filter(w => w.severity === 'error')).toEqual([]);
    void join;
  }, 60000);
});

describe('format helpers', () => {
  it('formats numbers and forces', () => {
    expect(fmt(1.5)).toBe('1.5');
    expect(fmt(2)).toBe('2');
    expect(fmt(-0.001)).toBe('0');
    expect(fmt(NaN)).toBe('–');
    expect(fmtForce(9.80665)).toBe('9.8 kN (1 t)');
    expect(parseNumberList('835, 835; 415 x 10')).toEqual([835, 835, 415, 10]);
  });
});
