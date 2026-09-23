/**
 * sim-3d — the machine: table, holder, ram beam, asymmetric clamps, side frames, backgauge beam
 * and fingers. Clamp / ram / holder / table / beam boxes come straight from machineObstacles so
 * the picture matches the collision model; frames are drawn as C-frames. See docs/specs/sim-3d.md §4.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Edges } from '@react-three/drei';
import type { FingerSetting, Machine, ObstacleKind, ToolSetup } from '../core/types';
import { machineObstacles, machineLevels } from '../core/machine';
import { flatFinger } from '../core/tools';
import { SIM_COLORS, toolStack, FRAME_PLATE, FRAME_COLUMN } from './scene';
import type { SimLibrary } from './scene';
import { polygonRect, profileGeometry } from './threeUtils';

export interface MachineModelProps {
  machine: Machine;
  setup: ToolSetup;
  library: SimLibrary;
  /** Ram clamp bottom Y. */
  ramY: number;
  fingers: FingerSetting[];
  collisionKinds: ReadonlySet<ObstacleKind>;
  /** Draw the ram beam and clamps translucent (plan view: they hide the bend line otherwise). */
  xray?: boolean | undefined;
}

const EDGE_COLOR = '#1c2230';
/** Material overrides for the translucent (x-ray) ram and clamps. */
const XRAY: Partial<THREE.MeshStandardMaterialParameters> = { transparent: true, opacity: 0.28, depthWrite: false };

interface BoxProps {
  name: string;
  x0: number; x1: number; y0: number; y1: number; z0: number; z1: number;
  material: THREE.Material;
}

function Box({ name, x0, x1, y0, y1, z0, z1, material }: BoxProps) {
  const w = Math.max(1e-3, x1 - x0), h = Math.max(1e-3, y1 - y0), d = Math.max(1e-3, z1 - z0);
  return (
    <mesh name={name} position={[(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]} material={material}>
      <boxGeometry args={[w, h, d]} />
      <Edges color={EDGE_COLOR} threshold={30} transparent opacity={0.35} />
    </mesh>
  );
}

function useMaterials() {
  const mats = useMemo(() => {
    const mk = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
      new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.7, ...extra });
    return {
      table: mk(SIM_COLORS.table), holder: mk(SIM_COLORS.holder), ram: mk(SIM_COLORS.ram), clamp: mk(SIM_COLORS.clamp),
      ramXray: mk(SIM_COLORS.ram, XRAY), clampXray: mk(SIM_COLORS.clamp, XRAY),
      frame: mk(SIM_COLORS.frame), beam: mk(SIM_COLORS.beam), finger: mk(SIM_COLORS.finger, { metalness: 0.4, roughness: 0.5 }),
      collision: mk(SIM_COLORS.collision, { emissive: SIM_COLORS.collision, emissiveIntensity: 0.4 }),
    };
  }, []);
  useEffect(() => () => { for (const m of Object.values(mats)) m.dispose(); }, [mats]);
  return mats;
}

export function MachineModel({ machine, setup, library, ramY, fingers, collisionKinds, xray = false }: MachineModelProps) {
  const mats = useMaterials();
  const obstacles = useMemo(() => machineObstacles(machine, setup, library, ramY, fingers), [machine, setup, library, ramY, fingers]);
  const { dieHeight, punchHeight } = toolStack(setup, library);
  const levels = machineLevels(machine, dieHeight, punchHeight);
  const bed = machine.bedLength;
  const finger = useMemo(() => library.fingers.find(f => f.id === machine.backgauge.fingerId) ?? flatFinger(), [library, machine.backgauge.fingerId]);
  const fingerGeometry = useMemo(() => profileGeometry(finger.profile.points, finger.width), [finger]);
  useEffect(() => () => fingerGeometry.dispose(), [fingerGeometry]);

  const pick = (kind: ObstacleKind, normal: THREE.Material): THREE.Material => (collisionKinds.has(kind) ? mats.collision : normal);

  // side frames: C-frames of FRAME_PLATE thickness at the frame positions
  const frameLeft = (bed - machine.distanceBetweenFrames) / 2;
  const frameRight = bed - frameLeft;
  const floorY = levels.tableTopY - machine.table.height - 120;
  const ramTopTdc = levels.tdcClampY + machine.ram.clampHeight + machine.ram.height;
  const frameMat = pick('frame', mats.frame);
  const frameParts = (z0: number, z1: number, side: string) => (
    <group name={`frame:${side}`} key={side}>
      <Box name={`frame:${side}:column`} x0={machine.throatDepth} x1={machine.throatDepth + FRAME_COLUMN} y0={floorY} y1={ramTopTdc + 120} z0={z0} z1={z1} material={frameMat} />
      <Box name={`frame:${side}:bottom`} x0={-machine.table.width / 2 - 60} x1={machine.throatDepth + FRAME_COLUMN} y0={floorY} y1={levels.tableTopY - machine.table.height + 80} z0={z0} z1={z1} material={frameMat} />
      <Box name={`frame:${side}:top`} x0={-machine.ram.thickness / 2 - 60} x1={machine.throatDepth + FRAME_COLUMN} y0={ramTopTdc} y1={ramTopTdc + 120} z0={z0} z1={z1} material={frameMat} />
    </group>
  );

  return (
    <group name="machine">
      {obstacles.map(o => {
        if (o.kind === 'punch' || o.kind === 'die' || o.kind === 'frame') return null;   // tools: ToolModel; frames: below
        if (o.kind === 'finger') {
          const i = Number(o.id.split(':')[1]);
          const f = fingers[i];
          if (!f) return null;
          return (
            <mesh key={o.id} name={o.id} geometry={fingerGeometry} material={pick('finger', mats.finger)} position={[f.x, f.r, f.z - finger.width / 2]}>
              <Edges color={EDGE_COLOR} threshold={30} transparent opacity={0.5} />
            </mesh>
          );
        }
        const r = polygonRect(o.polygon);
        let z0: number, z1: number;
        if (o.zRange === 'full') {
          if (o.kind === 'backgauge-beam') { z0 = machine.backgauge.zMin; z1 = machine.backgauge.zMax; } else { z0 = 0; z1 = bed; }
        } else {
          [z0, z1] = o.zRange;
        }
        const material =
          o.kind === 'clamp' ? pick('clamp', xray ? mats.clampXray : mats.clamp) :
          o.kind === 'ram' ? pick('ram', xray ? mats.ramXray : mats.ram) :
          o.kind === 'holder' ? pick('holder', mats.holder) :
          o.kind === 'table' ? pick('table', mats.table) :
          pick('backgauge-beam', mats.beam);
        return <Box key={o.id} name={o.id} x0={r.x0} x1={r.x1} y0={r.y0} y1={r.y1} z0={z0} z1={z1} material={material} />;
      })}
      {frameParts(frameLeft - FRAME_PLATE, frameLeft, 'left')}
      {frameParts(frameRight, frameRight + FRAME_PLATE, 'right')}
    </group>
  );
}
