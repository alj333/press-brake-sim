// @vitest-environment jsdom
/**
 * Reviewer tests: edge cases of the project store and the project file that the main test file
 * does not cover — degenerate flats, clamping, stale fixed orders, inch / down-bend DXFs, acute
 * and flipped tooling, hems, overbend fractions, collision seeking, malformed project files,
 * library identity and stale-program bookkeeping.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_NAMES, loadTruth } from '../core/testing/fixtures';
import type { FlatPattern, Machine } from '../core/types';
import { LibraryStore, STORAGE_KEY } from '../core/library';
import { useSimStore } from '../sim/store';
import { createProjectStore, selectMachine, selectSetupMessages } from './store';
import { parseProject, programToCsv, serializeProject } from './project';

function makeStore() {
  return createProjectStore({ libraryStore: new LibraryStore({ storage: null, fetch: null }), useWorker: false, language: 'en' });
}

// ── minimal DXF writer (LINE / CIRCLE entities, $INSUNITS header) ───────────
const dxfLine = (x0: number, y0: number, x1: number, y1: number, layer: string) =>
  `0\nLINE\n8\n${layer}\n10\n${x0}\n20\n${y0}\n30\n0\n11\n${x1}\n21\n${y1}\n31\n0\n`;
const dxfCircle = (cx: number, cy: number, r: number, layer: string) => `0\nCIRCLE\n8\n${layer}\n10\n${cx}\n20\n${cy}\n30\n0\n40\n${r}\n`;
function dxfRect(w: number, h: number, layer: string): string {
  return dxfLine(0, 0, w, 0, layer) + dxfLine(w, 0, w, h, layer) + dxfLine(w, h, 0, h, layer) + dxfLine(0, h, 0, 0, layer);
}
function dxfFile(entities: string, insunits: number): string {
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}

function emptyFlat(): FlatPattern {
  return { id: 'x', name: 'x', thickness: 2, materialId: 'std:mild-steel', outline: [], holes: [], bends: [] };
}

describe('store — degenerate parts and clamping', () => {
  beforeEach(() => { useSimStore.getState().setKeyframes([]); });

  it('refuses a flat without an outline and keeps the current part', () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    const before = store.getState().project.part;
    store.getState().loadFlat(emptyFlat());
    expect(store.getState().project.part).toBe(before);
    expect(store.getState().notices.some(n => n.message.key === 'errors.app.partBuildFailed')).toBe(true);
    // a fresh store stays without a part
    const empty = makeStore();
    empty.getState().loadFlat(emptyFlat());
    expect(empty.getState().project.part).toBeNull();
  });

  it('refuses to plan a part without bend lines', async () => {
    const store = makeStore();
    const flat = loadTruth('L-bracket').flat;
    store.getState().loadFlat({ ...flat, bends: [] });
    expect(store.getState().project.part!.flanges.length).toBe(1);
    await store.getState().plan();
    expect(store.getState().project.program).toBeNull();
    expect(store.getState().planning).toBe(false);
    expect(store.getState().notices.some(n => n.message.key === 'errors.plan.noBends')).toBe(true);
  });

  it('setBend clamps every attribute, ignores NaN and toggles the hem flag with the angle', () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().setBend('B1', { angle: 0, innerRadius: -3, kFactor: 7, angleCorrection: 100 });
    let b = store.getState().project.part!.flat.bends[0]!;
    expect(b.angle).toBe(0.5);
    expect(b.innerRadius).toBe(0);
    expect(b.kFactor).toBe(1);
    expect(b.angleCorrection).toBe(45);
    expect(b.hem).toBeUndefined();
    const part = store.getState().project.part;
    store.getState().setBend('B1', { angle: NaN, innerRadius: NaN, kFactor: NaN, angleCorrection: NaN });
    b = store.getState().project.part!.flat.bends[0]!;
    expect(b.angle).toBe(0.5);
    expect(b.innerRadius).toBe(0);
    expect(b.kFactor).toBe(1);
    expect(b.angleCorrection).toBeUndefined();   // NaN clears the correction
    expect(store.getState().project.part).not.toBe(part);   // still a rebuild (correction removed)
    store.getState().setBend('B1', { angle: 180 });
    expect(store.getState().project.part!.flat.bends[0]!.hem).toBe('closed');
    store.getState().setBend('B1', { angle: 90, angleCorrection: 0 });
    b = store.getState().project.part!.flat.bends[0]!;
    expect(b.hem).toBeUndefined();
    expect(b.angleCorrection).toBeUndefined();
    // the bend allowance follows the edits
    expect(store.getState().project.part!.bendAllowance['B1']).toBeCloseTo((Math.PI / 2) * (0 + 1 * 2), 6);
  });

  it('a bend line that does not span the part leaves one flange and a part warning', () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().setBend('B1', { p0: { x: 20, y: 30 }, p1: { x: 40, y: 30 } });
    const part = store.getState().project.part!;
    expect(part.flat.bends[0]!.sources.geometry).toBe('user');
    expect(part.flanges.length).toBe(1);
    expect(part.warnings.some(w => w.key === 'warnings.part.bendEndInMaterial')).toBe(true);
    // adding a spanning bend elsewhere splits the part again
    expect(store.getState().addBend({ x: 70, y: 0 }, { x: 70, y: 80 }, 'down')).toBe('B2');
    const part2 = store.getState().project.part!;
    expect(part2.flanges.length).toBe(2);
    expect(part2.flat.bends[1]!.direction).toBe('down');
  });

  it('setThickness clamps to 0.1–50 mm, rounds to 3 decimals and ignores NaN', () => {
    const store = makeStore();
    store.getState().setThickness(0.01);
    expect(store.getState().thickness).toBe(0.1);
    store.getState().setThickness(999);
    expect(store.getState().thickness).toBe(50);
    store.getState().setThickness(NaN);
    expect(store.getState().thickness).toBe(50);
    store.getState().setThickness(1.23456);
    expect(store.getState().thickness).toBe(1.235);
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    expect(store.getState().thickness).toBe(2);   // the flat's thickness wins when a part is loaded
  });

  it('station edits: reversed ranges and a full bed are reported by validateSetup, not crashes', () => {
    const store = makeStore();
    store.getState().updateStation('S1', { zStart: 2000, zEnd: 1000 });
    expect(store.getState().project.setup.stations[0]!.segments).toEqual([]);
    expect(selectSetupMessages(store.getState()).some(m => m.key === 'warnings.setup.stationReversed')).toBe(true);
    store.getState().resetSetup();
    store.getState().addStation();
    const st = store.getState().project.setup.stations;
    expect(st.length).toBe(2);
    expect(st[1]!.zEnd).toBeLessThanOrEqual(3100);   // stays on the bed, overlapping the full-length station
    expect(st[1]!.zEnd - st[1]!.zStart).toBeGreaterThanOrEqual(10);
    expect(selectSetupMessages(store.getState()).some(m => m.key === 'warnings.setup.stationsOverlap')).toBe(true);
    expect(selectSetupMessages(store.getState()).some(m => m.key === 'warnings.setup.stationOutsideBed')).toBe(false);
    store.getState().removeStation(st[1]!.id);
    // a custom punch without segment lengths gives a single full-length piece
    store.getState().updateStation('S1', { punchId: 'std:punch-hemming' });
    expect(store.getState().project.setup.stations[0]!.punchId).toBe('std:punch-hemming');
    store.getState().autoSegments('S1');
    const sum = store.getState().project.setup.stations[0]!.segments.reduce((a, b) => a + b, 0);
    expect(sum === 0 || Math.abs(sum - 3100) <= 0.5).toBe(true);
  });
});

describe('store — planning edge cases', () => {
  beforeEach(() => { useSimStore.getState().setKeyframes([]); });

  it('every sample plans through the store with one step per bend and keyframes', async () => {
    for (const name of SAMPLE_NAMES) {
      const store = makeStore();
      const truth = loadTruth(name);
      store.getState().loadFlat(truth.flat);
      await store.getState().plan();
      const s = store.getState();
      expect(s.planError, name).toBeNull();
      expect(s.project.program, name).not.toBeNull();
      expect(s.project.program!.steps.length, name).toBe(truth.flat.bends.length);
      expect(useSimStore.getState().keyframes.length, name).toBeGreaterThan(24 * truth.flat.bends.length);
      // a 'down' bend is placed concave-up: the root's +w faces −Y (flipped) on that step
      for (const step of s.project.program!.steps) {
        const bend = truth.flat.bends.find(b => b.id === step.bendId)!;
        expect(Number.isFinite(step.ramDepth), `${name} ${step.bendId}`).toBe(true);
        expect(step.includedAngle, `${name} ${step.bendId}`).toBeCloseTo(180 - bend.angle, 6);
      }
    }
  }, 60000);

  it('a stale fixed order is trimmed to the remaining bends and cleared when empty', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('U-channel').flat);
    await store.getState().plan();
    const ids = store.getState().project.program!.steps.map(s => s.bendId);
    store.getState().setFixedOrder([...ids].reverse());
    store.getState().removeBend(ids[0]!);
    expect(store.getState().fixedOrder).toEqual([ids[1]]);
    expect(store.getState().project.plannerOptions.fixedOrder).toEqual([ids[1]]);
    store.getState().removeBend(ids[1]!);
    expect(store.getState().fixedOrder).toBeNull();
    expect(store.getState().project.plannerOptions.fixedOrder).toBeUndefined();
    store.getState().setFixedOrder([]);
    expect(store.getState().fixedOrder).toBeNull();
  });

  it('acute bend: infeasible on 88° tools, feasible on the acute station; the stale flag follows the setup', async () => {
    const store = makeStore();
    const truth = loadTruth('acute-bracket');
    store.getState().loadFlat(truth.flat);
    await store.getState().plan();
    let program = store.getState().project.program!;
    expect(program.feasible).toBe(false);
    expect(program.steps[0]!.bottoming).toBe(true);
    expect(store.getState().notices.some(n => n.message.key === 'app.notice.plannedInfeasible')).toBe(true);
    store.getState().updateStation('S1', { punchId: 'std:punch-acute-30-r0.8', dieId: 'std:die-v12-30' });
    expect(store.getState().programStale).toBe(true);
    expect(store.getState().project.program).toBe(program);   // setup changes keep the program
    await store.getState().plan();
    program = store.getState().project.program!;
    expect(store.getState().programStale).toBe(false);
    expect(program.feasible).toBe(true);
    const golden = truth.expected.perBend['B1']!;
    expect(program.steps[0]!.includedAngle).toBeCloseTo(golden.includedAngle!, 6);
    expect(Math.abs(program.steps[0]!.loadedIncludedAngle - golden.loadedIncludedAngle!)).toBeLessThanOrEqual(truth.expected.tolerances.angle);
  });

  it('flipped gooseneck tooling plans the L-bracket with the same force', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().updateStation('S1', { punchId: 'std:punch-gooseneck-88-r0.8', punchFlipped: true, dieFlipped: true });
    await store.getState().plan();
    const program = store.getState().project.program!;
    expect(program.feasible).toBe(true);
    expect(program.steps[0]!.force).toBeCloseTo(11.93, 1);
    expect(program.steps[0]!.punchId).toBe('std:punch-gooseneck-88-r0.8');
  });

  it('an angle correction raises the overbend and the timeline folds past 1', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().setBend('B1', { angleCorrection: 3 });
    await store.getState().plan();
    const step = store.getState().project.program!.steps[0]!;
    expect(step.overbendAngle).toBeCloseTo(90 + step.springback + 3, 6);
    const maxFold = Math.max(...useSimStore.getState().keyframes.map(k => k.foldState['B1'] ?? 0));
    expect(maxFold).toBeCloseTo(step.overbendAngle / 90, 6);
    // seeking to a collision fraction lands on the keyframe with that fold fraction
    const kf = useSimStore.getState().keyframes;
    const seek = (atFraction: number) => {
      store.getState().seekToCollision(step, { with: 'punch', atFraction, depth: 1, severity: 'warning', location: { x: 0, y: 0, z: 0 }, message: { key: 'collisions.punch' } });
      const t = useSimStore.getState().timeS;
      let i = kf.findIndex(k => k.timeS >= t);
      if (i < 0) i = kf.length - 1;
      return kf[i]!;
    };
    expect(seek(0.5).phase).toBe('bend');
    expect(seek(0.5).foldState['B1']).toBeGreaterThanOrEqual(0.5);
    expect(seek(0.5).foldState['B1']).toBeLessThan(0.6);
    expect(seek(1.02).foldState['B1']).toBeGreaterThanOrEqual(1.02);
    expect(seek(9).foldState['B1']).toBeCloseTo(maxFold, 6);   // beyond the overbend: end of the bend phase
    const atPlacement = seek(0);
    expect(atPlacement.phase === 'gauge' || atPlacement.phase === 'approach').toBe(true);
    expect(atPlacement.foldState['B1'] ?? 0).toBe(0);
  });

  it('a hem expands into a pre-bend and a flatten step; without a hemming station it is infeasible', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().setBend('B1', { angle: 180 });
    await store.getState().plan();
    const program = store.getState().project.program!;
    expect(program.steps.map(s => s.kind)).toEqual(['bend', 'hem-flatten']);
    expect(program.steps.every(s => s.bendId === 'B1')).toBe(true);
    expect(program.feasible).toBe(false);
    // the timeline still covers both steps
    const kf = useSimStore.getState().keyframes;
    expect(new Set(kf.map(k => k.stepIndex))).toEqual(new Set([0, 1]));
  });

  it('newProject during a plan drops the result; loadProject during a plan too', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('box-4-flange').flat);
    const p = store.getState().plan();
    store.getState().newProject();
    await p;
    expect(store.getState().project.part).toBeNull();
    expect(store.getState().project.program).toBeNull();
    expect(store.getState().planning).toBe(false);
    expect(useSimStore.getState().keyframes).toEqual([]);
  });

  it('planner option edits and machine edits mark the program stale, a machine rename does not', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    await store.getState().plan();
    expect(store.getState().programStale).toBe(false);
    store.getState().updateMachine({ name: 'Renamed' });
    expect(store.getState().programStale).toBe(false);
    expect(selectMachine(store.getState()).name).toBe('Renamed');
    store.getState().setPlannerOptions({ sweepStepDeg: 2 });
    expect(store.getState().programStale).toBe(true);
    await store.getState().plan();
    expect(store.getState().programStale).toBe(false);
    store.getState().updateMachine({ backgauge: { retractAtPinch: 10 } });
    expect(store.getState().programStale).toBe(true);
  });
});

describe('store — imports', () => {
  it('an inch DXF with a down bend and a hole is converted to mm with dxf sources', async () => {
    const store = makeStore();
    // 4 × 2 in plate, a down bend across the middle, a 0.25 in hole
    const text = dxfFile(dxfRect(4, 2, 'OUTLINE') + dxfLine(2, 0, 2, 2, 'BEND_DOWN') + dxfCircle(1, 1, 0.25, '0'), 1);
    await store.getState().importFiles([new File([text], 'plate-flat.dxf')]);
    const s = store.getState();
    expect(s.importWarnings.filter(w => w.severity === 'error')).toEqual([]);
    const part = s.project.part!;
    expect(part.flat.sourceUnits).toBe('in');
    expect(part.flatBounds.max.x).toBeCloseTo(101.6, 6);
    expect(part.flatBounds.max.y).toBeCloseTo(50.8, 6);
    expect(part.flat.holes.length).toBe(1);
    expect(part.flanges.length).toBe(2);
    const b = part.flat.bends[0]!;
    expect(b.direction).toBe('down');
    expect(b.sources).toEqual({ geometry: 'dxf', angle: 'default', radius: 'default', direction: 'dxf' });
    expect(Math.abs(b.p1.y - b.p0.y)).toBeCloseTo(50.8, 6);
    expect(part.flat.thickness).toBe(2);
    expect(s.project.name).toBe('plate');   // "-flat" stripped
    // a forced units override re-reads the same drawing as mm: a 4 × 2 mm plate whose bend zone
    // is wider than the sheet has no flanges left, so the part is refused and the old one kept
    store.getState().setDxfUnits('mm');
    await store.getState().importFiles([new File([text], 'plate-flat.dxf')]);
    expect(store.getState().dxfFlat!.sourceUnits).toBe('mm');
    expect(Math.max(...store.getState().dxfFlat!.outline.map(p => p.x))).toBeCloseTo(4, 6);
    expect(store.getState().project.part).toBe(part);
    expect(store.getState().notices.some(n => n.message.key === 'errors.app.partBuildFailed')).toBe(true);
  });

  it('a mesh that is not a sheet leaves the recogniser issues visible and never crashes', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    const s = 50;
    const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
    const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    let stl = 'solid cube\n';
    for (const f of faces) stl += ` facet normal 0 0 0\n  outer loop\n${f.map(i => `   vertex ${v[i]!.join(' ')}\n`).join('')}  endloop\n endfacet\n`;
    stl += 'endsolid cube\n';
    await store.getState().importInputs([{ name: 'cube.stl', bytes: new TextEncoder().encode(stl) }]);
    const st = store.getState();
    expect(st.importing).toBe(false);
    expect(st.recognized!.bendCount).toBe(0);
    expect(st.importWarnings.some(w => w.key === 'warnings.recognize.noBends')).toBe(true);
    // whatever the recogniser produced is either a valid flat plate or refused — never an empty part
    const part = st.project.part!;
    expect(part.flanges.length).toBeGreaterThan(0);
    expect(part.rootFlangeId).not.toBe('');
  });

  it('a mesh recognised with a different thickness re-stamps a later DXF', async () => {
    const store = makeStore();
    store.getState().setThickness(3);
    const text = dxfFile(dxfRect(100, 60, 'OUTLINE') + dxfLine(50, 0, 50, 60, 'BEND'), 4);
    await store.getState().importFiles([new File([text], 'plate.dxf')]);
    expect(store.getState().project.part!.flat.thickness).toBe(3);
    expect(store.getState().project.part!.flat.bends[0]!.innerRadius).toBeCloseTo(3.84, 2);   // 1.28·t default rule
  });
});

describe('project file — robustness', () => {
  it('keeps zero planner weights and drops a malformed saved program with a notice', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().setPlannerOptions({ weights: { flip: 0, rotate: 0, stationChange: 1, shortFlange: 1, collisionWarning: 1 } });
    await store.getState().plan();
    const json = store.getState().saveProject();
    const good = parseProject(json, { machineId: 'm', materialId: 'mat' });
    expect(good.plannerOptions.weights.flip).toBe(0);
    expect(good.program!.steps.length).toBe(1);
    // corrupt one step
    const raw = JSON.parse(json);
    delete raw.program.steps[0].backgauge;
    const messages: { key: string }[] = [];
    const parsed = parseProject(JSON.stringify(raw), { machineId: 'm', materialId: 'mat' }, messages);
    expect(parsed.program).toBeNull();
    expect(messages.map(m => m.key)).toEqual(['app.notice.programDropped']);
    // through the store: no crash, a warning toast, no keyframes
    const other = makeStore();
    other.getState().loadProject(JSON.stringify(raw));
    expect(other.getState().project.program).toBeNull();
    expect(other.getState().notices.some(n => n.message.key === 'app.notice.programDropped')).toBe(true);
    expect(useSimStore.getState().keyframes).toEqual([]);
    // a program whose bend ids do not exist is dropped too
    raw.program = good.program;
    raw.part.flat.bends[0].id = 'B7';
    expect(parseProject(JSON.stringify(raw), { machineId: 'm', materialId: 'mat' }).program).toBeNull();
  });

  it('the machine snapshot of a project file: adopted by a pristine library, otherwise the library wins and the program is stale', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().updateMachine({ yCorrection: 0.3 });
    await store.getState().plan();
    const json = store.getState().saveProject();
    const overlayMachine = JSON.parse(json).libraryOverlay.machines.find((m: Machine) => m.id === 'std:machine-generic-100t');
    expect(overlayMachine.yCorrection).toBe(0.3);
    // a PC whose standard machine was never edited takes the project's calibration
    const fresh = makeStore();
    fresh.getState().loadProject(json);
    expect(selectMachine(fresh.getState()).yCorrection).toBe(0.3);
    expect(fresh.getState().programStale).toBe(false);
    expect(fresh.getState().notices.some(n => n.message.key === 'app.notice.machineFromProject')).toBe(true);
    // a PC with its own machine edits keeps them; the saved program is flagged for re-planning
    const edited = makeStore();
    edited.getState().updateMachine({ yCorrection: -0.2 });
    edited.getState().loadProject(json);
    expect(selectMachine(edited.getState()).yCorrection).toBe(-0.2);
    expect(edited.getState().programStale).toBe(true);
    expect(edited.getState().notices.some(n => n.message.key === 'app.notice.machineDiffers')).toBe(true);
    // the same file in a store whose library matches loads clean
    const same = makeStore();
    same.getState().updateMachine({ yCorrection: 0.3 });
    same.getState().loadProject(json);
    expect(same.getState().programStale).toBe(false);
    expect(same.getState().project.program!.steps.length).toBe(1);
    expect(same.getState().notices.some(n => n.message.key === 'app.notice.machineDiffers' || n.message.key === 'app.notice.machineFromProject')).toBe(false);
  });

  it('custom tools in the overlay are added to a library that lacks them and the finger cannot be deleted while mounted', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    const finger = { ...store.getState().library.fingers[0]!, id: 'custom:finger-1', name: 'Shop finger', source: 'custom' as const };
    store.getState().upsertLibraryItem(finger);
    store.getState().updateMachine({ backgauge: { fingerId: finger.id } });
    const json = serializeProject(store.getState().project, store.getState().library);
    const other = makeStore();
    other.getState().loadProject(json);
    expect(other.getState().library.fingers.some(f => f.id === finger.id)).toBe(true);
    expect(selectMachine(other.getState()).backgauge.fingerId).toBe(finger.id);
    // used by the (only) machine → refused; switch the machine's finger → allowed
    expect(other.getState().removeLibraryItem(finger.id)).toBe(false);
    other.getState().updateMachine({ backgauge: { fingerId: 'std:finger-flat' } });
    expect(other.getState().removeLibraryItem(finger.id)).toBe(true);
  });

  it('CSV cells with commas, quotes and Thai are escaped and the row count matches the steps', async () => {
    const store = makeStore();
    store.getState().loadFlat(loadTruth('U-channel').flat);
    store.getState().updateMachine({ name: 'Brake "A", bay 2' });
    await store.getState().plan();
    const s = store.getState();
    const csv = programToCsv({ program: s.project.program!, part: s.project.part, machine: selectMachine(s), material: undefined, library: s.simLibrary }, 'en');
    expect(csv).toContain('"Brake ""A"", bay 2"');
    expect(csv).toContain(s.project.materialId);   // material name falls back to the id
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    const header = lines.findIndex(l => l.startsWith('Step / '));
    expect(header).toBeGreaterThan(0);
    expect(lines.length - header - 1).toBe(2);
    const cols = lines[header]!.split(',').length;
    for (const row of lines.slice(header + 1)) expect(row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length).toBe(cols);
  });
});

describe('store — library loading', () => {
  it('loadLibrary rebuilds the default setup of a fresh project for the shop machine', async () => {
    // a cached library whose standard machine has a 2500 mm bed
    const seed = new LibraryStore({ storage: null, fetch: null });
    const machine = seed.get().machines.find(m => m.id === 'std:machine-generic-100t')!;
    seed.upsert({ ...machine, bedLength: 2500 });
    const cache = new Map<string, string>([[STORAGE_KEY, seed.exportJson()]]);
    const storage = { getItem: (k: string) => cache.get(k) ?? null, setItem: (k: string, v: string) => { cache.set(k, v); } };
    const store = createProjectStore({ libraryStore: new LibraryStore({ storage, fetch: null }), useWorker: false, language: 'en' });
    expect(store.getState().project.setup.stations[0]!.zEnd).toBe(3100);   // built before the cache was read
    await store.getState().loadLibrary();
    expect(selectMachine(store.getState()).bedLength).toBe(2500);
    expect(store.getState().project.setup.stations[0]!.zEnd).toBe(2500);
    expect(selectSetupMessages(store.getState())).toEqual([]);
    // a project in progress is left alone
    store.getState().loadFlat(loadTruth('L-bracket').flat);
    store.getState().updateStation('S1', { zEnd: 1000 });
    await store.getState().loadLibrary();
    expect(store.getState().project.setup.stations[0]!.zEnd).toBe(1000);
  });
});

describe('store — library identity', () => {
  it('simLibrary keeps its identity across machine / material edits and changes on tool edits', () => {
    const store = makeStore();
    const sim0 = store.getState().simLibrary;
    store.getState().updateMachine({ bedLength: 2500 });
    expect(store.getState().simLibrary).toBe(sim0);
    store.getState().upsertLibraryItem({ ...store.getState().library.materials[0]!, id: 'custom:mat', name: 'Custom' });
    expect(store.getState().simLibrary).toBe(sim0);
    store.getState().upsertLibraryItem({ ...store.getState().library.punches[0]!, id: 'custom:p1', name: 'Custom punch', source: 'custom' });
    expect(store.getState().simLibrary).not.toBe(sim0);
    expect(store.getState().simLibrary.punches.some(p => p.id === 'custom:p1')).toBe(true);
    expect(store.getState().library.punches).toBe(store.getState().simLibrary.punches);
  });
});
