/**
 * Machine and tool-setup validation → Message[] (i18n keys, see docs/specs/tooling-machine.md §2).
 */
import type { Machine, Message, ToolLibrary, ToolSetup } from '../types';
import {
  MOTIONX_DIE_PHYSICAL_ID,
  motionXDieGeometryDiscrepancy,
  motionXPunchGeometryDiscrepancy,
} from '../tools/factory';
import { availableSegmentLengths, hasBoundedSegmentInventory, isToolInStock } from '../tools/stock';

export interface ValidateMachineOptions {
  /** Nominal tool stack used for the daylight/stroke inequalities (standard: 120 + 60). */
  punchHeight?: number;
  dieHeight?: number;
  /** Nominal deepest ram depth the machine must reach (mm below the die plane). */
  maxRamDepth?: number;
}

function finitePositive(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) && v > 0; }
function finiteNumber(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }

/** Structural + range checks and the daylight/stroke inequalities of types.ts. */
export function validateMachine(m: Machine, opts: ValidateMachineOptions = {}): Message[] {
  const out: Message[] = [];
  const invalid = (field: string): void => { out.push({ key: 'warnings.machine.invalid', severity: 'error', params: { field } }); };
  const positives: Array<[string, unknown]> = [
    ['bedLength', m.bedLength], ['capacity', m.capacity], ['stroke', m.stroke], ['daylight', m.daylight],
    ['throatDepth', m.throatDepth], ['distanceBetweenFrames', m.distanceBetweenFrames],
    ['ram.thickness', m.ram?.thickness], ['ram.height', m.ram?.height], ['ram.clampThickness', m.ram?.clampThickness], ['ram.clampHeight', m.ram?.clampHeight],
    ['ram.speeds.approach', m.ram?.speeds?.approach], ['ram.speeds.bend', m.ram?.speeds?.bend], ['ram.speeds.retract', m.ram?.speeds?.retract],
    ['table.width', m.table?.width], ['table.holderWidth', m.table?.holderWidth], ['table.holderHeight', m.table?.holderHeight], ['table.height', m.table?.height],
    ['backgauge.beamDepth', m.backgauge?.beamDepth], ['backgauge.beamHeight', m.backgauge?.beamHeight], ['backgauge.speed', m.backgauge?.speed],
  ];
  for (const [field, v] of positives) if (!finitePositive(v)) invalid(field);
  const numbers: Array<[string, unknown]> = [
    ['ram.clampFrontOffset', m.ram?.clampFrontOffset], ['backgauge.xMin', m.backgauge?.xMin], ['backgauge.xMax', m.backgauge?.xMax],
    ['backgauge.rMin', m.backgauge?.rMin], ['backgauge.rMax', m.backgauge?.rMax], ['backgauge.zMin', m.backgauge?.zMin], ['backgauge.zMax', m.backgauge?.zMax],
    ['backgauge.retractAtPinch', m.backgauge?.retractAtPinch], ['yCorrection', m.yCorrection],
  ];
  for (const [field, v] of numbers) if (!finiteNumber(v)) invalid(field);
  if (typeof m.id !== 'string' || m.id.length === 0) invalid('id');
  if (typeof m.name !== 'string') invalid('name');
  if (!m.backgauge || typeof m.backgauge.fingerId !== 'string' || m.backgauge.fingerId.length === 0) invalid('backgauge.fingerId');
  if (!m.backgauge || !Number.isInteger(m.backgauge.fingerCount) || m.backgauge.fingerCount < 1) invalid('backgauge.fingerCount');
  if (out.length > 0) return out; // ranges below need sane numbers

  const range = (field: string): void => { out.push({ key: 'warnings.machine.range', severity: 'error', params: { field } }); };
  if (m.ram.clampFrontOffset < 0 || m.ram.clampFrontOffset > m.ram.clampThickness) range('ram.clampFrontOffset');
  if (m.backgauge.xMin >= m.backgauge.xMax) range('backgauge.x');
  if (m.backgauge.rMin >= m.backgauge.rMax) range('backgauge.r');
  if (m.backgauge.zMin >= m.backgauge.zMax) range('backgauge.z');
  if (m.backgauge.retractAtPinch < 0) range('backgauge.retractAtPinch');
  if (m.distanceBetweenFrames > m.bedLength) out.push({ key: 'warnings.machine.framesWiderThanBed', severity: 'warning', params: { distanceBetweenFrames: m.distanceBetweenFrames, bedLength: m.bedLength } });
  if (m.backgauge.zMax > m.bedLength || m.backgauge.zMin < 0) out.push({ key: 'warnings.machine.gaugeBeyondBed', severity: 'warning', params: { zMin: m.backgauge.zMin, zMax: m.backgauge.zMax, bedLength: m.bedLength } });

  // daylight / stroke inequalities (types.ts Machine.daylight)
  const punchHeight = opts.punchHeight ?? 120, dieHeight = opts.dieHeight ?? 60, maxRamDepth = opts.maxRamDepth ?? 15;
  const stack = m.table.holderHeight + dieHeight + punchHeight;
  if (stack > m.daylight) {
    out.push({ key: 'warnings.machine.stackTooTall', severity: 'error', params: { stack, daylight: m.daylight } });
  } else {
    const required = (m.daylight - stack) + maxRamDepth + 5;
    if (m.stroke < required - 1e-9) out.push({ key: 'warnings.machine.strokeTooShort', severity: 'error', params: { stroke: m.stroke, required } });
  }
  return out;
}

export type LibraryTools = Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>;

/** Stations inside the bed, no overlap, segments sum ≈ length, tools exist, stacks fit. */
export function validateSetup(setup: ToolSetup, machine: Machine, library: LibraryTools): Message[] {
  const out: Message[] = [];
  if (setup.machineId !== machine.id) {
    out.push({ key: 'warnings.setup.machineMismatch', severity: 'warning', params: { setupMachineId: setup.machineId, machineId: machine.id } });
  }
  if (!library.fingers.some(f => f.id === machine.backgauge.fingerId)) {
    out.push({ key: 'warnings.setup.unknownFinger', severity: 'error', params: { fingerId: machine.backgauge.fingerId } });
  }
  if (setup.stations.length === 0) {
    out.push({ key: 'warnings.setup.noStations', severity: 'warning' });
    return out;
  }
  const seen = new Set<string>();
  const dieHeights = new Set<number>();
  const physicalDieSlots = new Map<string, Set<string>>();
  const remainingPunchInventory = new Map<string, number[]>();
  for (const st of setup.stations) {
    if (seen.has(st.id)) out.push({ key: 'warnings.setup.duplicateStation', severity: 'error', params: { stationId: st.id } });
    seen.add(st.id);
    const punch = library.punches.find(p => p.id === st.punchId);
    const die = library.dies.find(d => d.id === st.dieId);
    if (!punch) out.push({ key: 'warnings.setup.unknownTool', severity: 'error', params: { stationId: st.id, toolId: st.punchId } });
    if (!die) out.push({ key: 'warnings.setup.unknownTool', severity: 'error', params: { stationId: st.id, toolId: st.dieId } });
    if (punch && !isToolInStock(punch)) out.push({ key: 'warnings.setup.toolNotInStock', severity: 'warning', params: { stationId: st.id, tool: punch.name } });
    if (die && !isToolInStock(die)) out.push({ key: 'warnings.setup.toolNotInStock', severity: 'warning', params: { stationId: st.id, tool: die.name } });
    const punchGeometryDiscrepancy = punch ? motionXPunchGeometryDiscrepancy(punch) : null;
    if (punchGeometryDiscrepancy) {
      out.push({
        key: 'warnings.setup.punchCadGeometryMismatch',
        severity: 'warning',
        params: {
          stationId: st.id,
          selectedAngle: punchGeometryDiscrepancy.calculation.tipAngle,
          selectedRadius: punchGeometryDiscrepancy.calculation.tipRadius,
          cadAngle: punchGeometryDiscrepancy.cad.tipAngle,
          cadRadius: punchGeometryDiscrepancy.cad.tipRadius,
        },
      });
    }
    const geometryDiscrepancy = die ? motionXDieGeometryDiscrepancy(die) : null;
    if (geometryDiscrepancy) {
      out.push({
        key: 'warnings.setup.controllerCadGeometryMismatch',
        severity: 'warning',
        params: {
          stationId: st.id,
          slotNumber: geometryDiscrepancy.slotNumber,
          controllerV: geometryDiscrepancy.controller.vWidth,
          controllerAngle: geometryDiscrepancy.controller.vAngle,
          controllerRadius: geometryDiscrepancy.controller.shoulderRadius,
          cadV: geometryDiscrepancy.cad.vWidth,
          cadAngle: geometryDiscrepancy.cad.vAngle,
          cadRadius: geometryDiscrepancy.cad.shoulderRadius,
        },
      });
      out.push({
        key: 'warnings.setup.dieLengthUnverified',
        severity: 'warning',
        params: { stationId: st.id, slotNumber: geometryDiscrepancy.slotNumber },
      });
    }
    if (die?.physicalToolId && die.slotNumber) {
      const slots = physicalDieSlots.get(die.physicalToolId) ?? new Set<string>();
      slots.add(die.slotNumber);
      physicalDieSlots.set(die.physicalToolId, slots);
    }
    const length = st.zEnd - st.zStart;
    if (!(length > 0)) {
      out.push({ key: 'warnings.setup.stationReversed', severity: 'error', params: { stationId: st.id } });
    } else if (st.zStart < -1e-9 || st.zEnd > machine.bedLength + 1e-9) {
      out.push({ key: 'warnings.setup.stationOutsideBed', severity: 'error', params: { stationId: st.id, zStart: st.zStart, zEnd: st.zEnd, bedLength: machine.bedLength } });
    }
    if (punch && hasBoundedSegmentInventory(punch) && st.segments.length === 0 && length > 0) {
      out.push({ key: 'warnings.setup.segmentInventoryRequired', severity: 'error', params: { stationId: st.id } });
    }
    if (st.segments.length > 0 && length > 0) {
      const sum = st.segments.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - length) > 0.5) out.push({ key: 'warnings.setup.segmentsMismatch', severity: 'error', params: { stationId: st.id, sum, length } });
      if (punch && hasBoundedSegmentInventory(punch)) {
        let remaining = remainingPunchInventory.get(punch.id);
        if (!remaining) {
          remaining = availableSegmentLengths(punch);
          remainingPunchInventory.set(punch.id, remaining);
        }
        for (const seg of st.segments) {
          const index = remaining.findIndex(length => Math.abs(length - seg) < 1e-9);
          if (index >= 0) remaining.splice(index, 1);
          else out.push({ key: 'warnings.setup.segmentQuantityExceeded', severity: 'error', params: { stationId: st.id, length: seg } });
        }
      } else if (punch && punch.segmentLengths.length > 0) {
        for (const seg of st.segments) {
          if (!punch.segmentLengths.some(l => Math.abs(l - seg) < 1e-9)) {
            out.push({ key: 'warnings.setup.segmentNotAvailable', severity: 'warning', params: { stationId: st.id, length: seg } });
          }
        }
      }
    }
    if (punch && die) {
      const stack = machine.table.holderHeight + die.height + punch.height;
      if (stack > machine.daylight) out.push({ key: 'warnings.setup.stackTooTall', severity: 'error', params: { stationId: st.id, stack, daylight: machine.daylight } });
      dieHeights.add(die.height);
    }
  }
  for (const [physicalToolId, slots] of physicalDieSlots) {
    if (physicalToolId === MOTIONX_DIE_PHYSICAL_ID && slots.size > 1) {
      out.push({
        key: 'warnings.setup.physicalDieSlotConflict',
        severity: 'error',
        params: { slots: [...slots].sort().join('/') },
      });
    }
  }
  // pairwise overlap (every pair, so a station enclosing several others is reported against each)
  const sorted = setup.stations.slice().sort((a, b) => a.zStart - b.zStart);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    const aEnd = Math.max(a.zStart, a.zEnd);
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.zStart < aEnd - 1e-9) out.push({ key: 'warnings.setup.stationsOverlap', severity: 'error', params: { a: a.id, b: b.id } });
    }
  }
  if (dieHeights.size > 1) out.push({ key: 'warnings.setup.mixedDieHeights', severity: 'warning', params: { heights: [...dieHeights].sort((x, y) => x - y).join('/') } });
  return out;
}
