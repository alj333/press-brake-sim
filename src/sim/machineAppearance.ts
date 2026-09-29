/**
 * Pure, render-only layout for the machine skin. None of these primitives participate in
 * collision or clearance checks; the authoritative envelopes remain machineObstacles().
 * Decorative pieces are kept outside the active tooling gap by Z (side frames), Y (fascias)
 * or X (backgauge rails).
 */
import type { Machine, ObstacleKind } from '../core/types';
import type { MachineLevels } from '../core/machine';
import { FRAME_COLUMN, FRAME_PLATE } from './scene';

export type MachineAppearanceRole =
  | 'frame'
  | 'frame-cover'
  | 'foot'
  | 'bed-fascia'
  | 'ram-fascia'
  | 'accent'
  | 'rail'
  | 'hydraulic';

export interface MachineAppearanceBox {
  id: string;
  role: Exclude<MachineAppearanceRole, 'hydraulic'>;
  collisionKind: ObstacleKind;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export interface MachineAppearanceCylinder {
  id: string;
  role: 'hydraulic';
  collisionKind: ObstacleKind;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

export interface MachineAppearanceLayout {
  boxes: MachineAppearanceBox[];
  cylinders: MachineAppearanceCylinder[];
}

function appearanceBox(
  id: string,
  role: MachineAppearanceBox['role'],
  collisionKind: ObstacleKind,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): MachineAppearanceBox {
  return { id, role, collisionKind, x0, x1, y0, y1, z0, z1 };
}

/**
 * Dimension-driven generic press-brake appearance. The boxes representing the original visual
 * C-frames intentionally retain their prior FRAME_PLATE / FRAME_COLUMN dimensions and locations.
 * Covers, fascias and rails sit outside the collision-critical working opening.
 */
export function deriveMachineAppearance(machine: Machine, levels: MachineLevels, ramY: number): MachineAppearanceLayout {
  const bed = machine.bedLength;
  const frameLeft = (bed - machine.distanceBetweenFrames) / 2;
  const frameRight = bed - frameLeft;
  const floorY = levels.tableTopY - machine.table.height - 120;
  const ramTopTdc = levels.tdcClampY + machine.ram.clampHeight + machine.ram.height;
  const tableBottomY = levels.tableTopY - machine.table.height;

  const coverDepth = Math.max(18, Math.min(42, machine.throatDepth * 0.08));
  const footHeight = Math.max(42, Math.min(72, machine.table.height * 0.12));
  const fasciaThickness = Math.max(8, Math.min(22, machine.table.width * 0.14));
  const ramFasciaThickness = Math.max(6, Math.min(14, machine.ram.thickness * 0.16));
  const railThickness = Math.max(14, Math.min(28, machine.backgauge.beamHeight * 0.32));
  const hydraulicHeight = Math.max(120, Math.min(240, machine.stroke * 0.85));
  const hydraulicRadius = Math.max(14, Math.min(28, machine.ram.clampThickness * 0.16));

  const boxes: MachineAppearanceBox[] = [];
  const cylinders: MachineAppearanceCylinder[] = [];

  const sides = [
    { side: 'left', z0: frameLeft - FRAME_PLATE, z1: frameLeft, outward: -1 },
    { side: 'right', z0: frameRight, z1: frameRight + FRAME_PLATE, outward: 1 },
  ] as const;

  for (const { side, z0, z1, outward } of sides) {
    // Recognisable C-frame: rear column, base arm and crown arm. These are visual stand-ins for
    // the collision model's frame half-spaces, matching the previous renderer exactly.
    boxes.push(
      appearanceBox(`frame:${side}:column`, 'frame', 'frame', machine.throatDepth, machine.throatDepth + FRAME_COLUMN, floorY, ramTopTdc + 120, z0, z1),
      appearanceBox(`frame:${side}:bottom`, 'frame', 'frame', -machine.table.width / 2 - 60, machine.throatDepth + FRAME_COLUMN, floorY, tableBottomY + 80, z0, z1),
      appearanceBox(`frame:${side}:top`, 'frame', 'frame', -machine.ram.thickness / 2 - 60, machine.throatDepth + FRAME_COLUMN, ramTopTdc, ramTopTdc + 120, z0, z1),
    );

    // Rear painted cover and a wider floor foot remain behind the throat / outside the clear Z
    // opening. They add machine mass without implying extra tooling clearance.
    boxes.push(
      appearanceBox(`cover:${side}:rear`, 'frame-cover', 'frame', machine.throatDepth + FRAME_COLUMN, machine.throatDepth + FRAME_COLUMN + coverDepth, floorY + footHeight, ramTopTdc + 120, z0, z1),
      appearanceBox(
        `foot:${side}`,
        'foot',
        'frame',
        -machine.table.width / 2 - 100,
        machine.throatDepth + FRAME_COLUMN + coverDepth,
        floorY,
        floorY + footHeight,
        outward < 0 ? z0 - coverDepth : z0,
        outward < 0 ? z1 : z1 + coverDepth,
      ),
    );

    // Hydraulic cylinders are deliberately on the side-frame plates, not inside the clear span.
    cylinders.push({
      id: `hydraulic:${side}`,
      role: 'hydraulic',
      collisionKind: 'frame',
      x: machine.throatDepth + FRAME_COLUMN * 0.46,
      y: ramTopTdc + 55,
      z: (z0 + z1) / 2,
      radius: hydraulicRadius,
      height: hydraulicHeight,
    });
  }

  // Front bed apron: in front of and below the authoritative table obstacle.
  const bedFasciaY0 = tableBottomY + Math.max(30, machine.table.height * 0.08);
  const bedFasciaY1 = levels.tableTopY - Math.max(70, machine.table.height * 0.17);
  boxes.push(
    appearanceBox(
      'bed:front-fascia',
      'bed-fascia',
      'table',
      -machine.table.width / 2 - fasciaThickness,
      -machine.table.width / 2 - 1,
      bedFasciaY0,
      Math.max(bedFasciaY0 + 1, bedFasciaY1),
      0,
      bed,
    ),
    appearanceBox(
      'bed:accent',
      'accent',
      'table',
      -machine.table.width / 2 - fasciaThickness - 1,
      -machine.table.width / 2 - fasciaThickness + 2,
      Math.max(bedFasciaY0 + 1, bedFasciaY1) - 36,
      Math.max(bedFasciaY0 + 1, bedFasciaY1) - 18,
      0,
      bed,
    ),
  );

  // Moving front ram fascia: flush in front of the ram collision box and above the clamp gap.
  const ramBodyBottom = ramY + machine.ram.clampHeight;
  boxes.push(
    appearanceBox(
      'ram:front-fascia',
      'ram-fascia',
      'ram',
      -machine.ram.thickness / 2 - ramFasciaThickness,
      -machine.ram.thickness / 2 - 1,
      ramBodyBottom + machine.ram.height * 0.12,
      ramBodyBottom + machine.ram.height * 0.9,
      0,
      bed,
    ),
    appearanceBox(
      'ram:accent',
      'accent',
      'ram',
      -machine.ram.thickness / 2 - ramFasciaThickness - 1,
      -machine.ram.thickness / 2 - ramFasciaThickness + 2,
      ramBodyBottom + machine.ram.height * 0.16,
      ramBodyBottom + machine.ram.height * 0.22,
      0,
      bed,
    ),
  );

  // Fixed rails sit beyond maximum X travel. The moving beam/fingers remain the exact obstacle
  // meshes from machineObstacles(); these rails are only the support structure behind them.
  const railX0 = machine.backgauge.xMax + machine.backgauge.beamDepth + 35;
  const railYLow = machine.backgauge.rMin - railThickness * 1.5;
  const railYHigh = machine.backgauge.rMax + railThickness * 1.5;
  boxes.push(
    appearanceBox('backgauge:rail-low', 'rail', 'backgauge-beam', railX0, railX0 + railThickness, railYLow, railYLow + railThickness, frameLeft, frameRight),
    appearanceBox('backgauge:rail-high', 'rail', 'backgauge-beam', railX0, railX0 + railThickness, railYHigh, railYHigh + railThickness, frameLeft, frameRight),
  );

  return { boxes, cylinders };
}
