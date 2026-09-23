/**
 * Machine obstacles for the planner's collision model and the section view: 2D machine-XY
 * polygons (CCW) with their Z extent. See docs/specs/tooling-machine.md §2 and ARCHITECTURE
 * "Collision model".
 */
import type { FingerSetting, Machine, ObstacleKind, Polygon2, ToolSetup } from '../types';
import { flatFinger } from '../tools/fingers';
import { mirrorProfileX, rect, translateProfile } from '../tools/profile';
import type { LibraryTools } from './validate';

export interface MachineObstacle {
  id: string;
  kind: ObstacleKind;
  polygon: Polygon2;
  zRange: [number, number] | 'full';
}

/** Default die height used for the table level when no station is mounted. */
export const DEFAULT_DIE_HEIGHT = 60;
/** Side frames are modelled 5000 mm thick in Z and 2000 mm deep in X — finite stand-ins for the
 *  half-spaces X ≥ throatDepth beyond each frame, big enough for any sheet overhanging the bed. */
export const FRAME_THICKNESS = 5000;
export const FRAME_DEPTH = 2000;

/**
 * All machine obstacles for a ram position (`ramY` = clamp bottom face) and finger settings.
 * Unknown punch/die ids are skipped (validateSetup reports them); an unknown finger id falls back
 * to the standard flat finger.
 */
export function machineObstacles(machine: Machine, setup: ToolSetup, library: LibraryTools, ramY: number, fingers: FingerSetting[]): MachineObstacle[] {
  const out: MachineObstacle[] = [];
  const { ram, table, backgauge } = machine;
  const stations = setup.stations.slice().sort((a, b) => a.zStart - b.zStart);
  let dieHeight = 0;

  for (const st of stations) {
    const zRange: [number, number] = [Math.min(st.zStart, st.zEnd), Math.max(st.zStart, st.zEnd)];
    const punch = library.punches.find(p => p.id === st.punchId);
    const die = library.dies.find(d => d.id === st.dieId);
    let tang = 0;
    if (punch) {
      const prof = st.punchFlipped ? mirrorProfileX(punch.profile.points) : punch.profile.points;
      out.push({ id: `punch:${st.id}`, kind: 'punch', polygon: translateProfile(prof, 0, ramY - punch.height), zRange });
      tang = st.punchFlipped ? -punch.tangCentreX : punch.tangCentreX;
    }
    out.push({
      id: `clamp:${st.id}`, kind: 'clamp',
      polygon: rect(tang - ram.clampFrontOffset, ramY, tang + ram.clampThickness - ram.clampFrontOffset, ramY + ram.clampHeight),
      zRange,
    });
    if (die) {
      const prof = st.dieFlipped ? mirrorProfileX(die.profile.points) : die.profile.points;
      out.push({ id: `die:${st.id}`, kind: 'die', polygon: prof.map(p => ({ x: p.x, y: p.y })), zRange });
      dieHeight = Math.max(dieHeight, die.height);
    }
  }
  if (dieHeight === 0) dieHeight = DEFAULT_DIE_HEIGHT;

  // clamp along the bed where no station is mounted (centred on the bend line)
  const clampPoly = (): Polygon2 => rect(-ram.clampFrontOffset, ramY, ram.clampThickness - ram.clampFrontOffset, ramY + ram.clampHeight);
  if (stations.length === 0) {
    out.push({ id: 'clamp:gap-0', kind: 'clamp', polygon: clampPoly(), zRange: 'full' });
  } else {
    let cursor = 0, n = 0;
    for (const st of stations) {
      const z0 = Math.min(st.zStart, st.zEnd), z1 = Math.max(st.zStart, st.zEnd);
      if (z0 > cursor + 1e-6) out.push({ id: `clamp:gap-${n++}`, kind: 'clamp', polygon: clampPoly(), zRange: [cursor, z0] });
      cursor = Math.max(cursor, z1);
    }
    if (cursor < machine.bedLength - 1e-6) out.push({ id: `clamp:gap-${n++}`, kind: 'clamp', polygon: clampPoly(), zRange: [cursor, machine.bedLength] });
  }

  // ram beam above the clamp
  out.push({
    id: 'ram', kind: 'ram',
    polygon: rect(-ram.thickness / 2, ramY + ram.clampHeight, ram.thickness / 2, ramY + ram.clampHeight + ram.height),
    zRange: 'full',
  });

  // holder and table below the die
  const tableTopY = -(table.holderHeight + dieHeight);
  out.push({ id: 'holder', kind: 'holder', polygon: rect(-table.holderWidth / 2, tableTopY, table.holderWidth / 2, tableTopY + table.holderHeight), zRange: 'full' });
  out.push({ id: 'table', kind: 'table', polygon: rect(-table.width / 2, tableTopY - table.height, table.width / 2, tableTopY), zRange: 'full' });

  // fingers and the backgauge beam
  if (fingers.length > 0) {
    const finger = library.fingers.find(f => f.id === backgauge.fingerId) ?? flatFinger();
    let xMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    fingers.forEach((f, i) => {
      out.push({
        id: `finger:${i}`, kind: 'finger',
        polygon: translateProfile(finger.profile.points, f.x, f.r),
        zRange: [f.z - finger.width / 2, f.z + finger.width / 2],
      });
      xMax = Math.max(xMax, f.x); rMin = Math.min(rMin, f.r); rMax = Math.max(rMax, f.r);
    });
    const x0 = xMax + finger.bodyDepth;
    out.push({ id: 'backgauge-beam', kind: 'backgauge-beam', polygon: rect(x0, rMin, x0 + backgauge.beamDepth, rMax + backgauge.beamHeight), zRange: 'full' });
  }

  // side frames: X ≥ throatDepth outside [frameLeft, frameRight] (frames centred on the bed)
  const frameLeft = (machine.bedLength - machine.distanceBetweenFrames) / 2;
  const frameRight = machine.bedLength - frameLeft;
  const yLo = tableTopY - table.height - 1000;
  const yHi = tableTopY + machine.daylight + ram.clampHeight + ram.height + 1000;
  const framePoly = (): Polygon2 => rect(machine.throatDepth, yLo, machine.throatDepth + FRAME_DEPTH, yHi);
  out.push({ id: 'frame:left', kind: 'frame', polygon: framePoly(), zRange: [frameLeft - FRAME_THICKNESS, frameLeft] });
  out.push({ id: 'frame:right', kind: 'frame', polygon: framePoly(), zRange: [frameRight, frameRight + FRAME_THICKNESS] });
  return out;
}
