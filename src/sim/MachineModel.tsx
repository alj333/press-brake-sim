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
import { SIM_COLORS, toolStack } from './scene';
import type { SimLibrary } from './scene';
import { polygonRect, profileGeometry } from './threeUtils';
import { MachineAppearance } from './MachineAppearance';

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
  const transparent = material.transparent && material.opacity < 1;
  return (
    <mesh
      name={name}
      position={[(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]}
      material={material}
      castShadow={!transparent}
      receiveShadow
    >
      <boxGeometry args={[w, h, d]} />
      <Edges color={EDGE_COLOR} threshold={30} transparent opacity={0.35} />
    </mesh>
  );
}

function useMaterials() {
  const mats = useMemo(() => {
    const mk = (color: string, metalness: number, roughness: number, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}) =>
      new THREE.MeshPhysicalMaterial({ color, metalness, roughness, ...extra });
    return {
      table: mk('#314154', 0.24, 0.5, { clearcoat: 0.16, clearcoatRoughness: 0.62 }),
      holder: mk('#aeb9c3', 0.74, 0.3),
      ram: mk('#314d6b', 0.2, 0.44, { clearcoat: 0.26, clearcoatRoughness: 0.55 }),
      clamp: mk('#778797', 0.68, 0.3),
      ramXray: mk('#314d6b', 0.2, 0.44, { ...XRAY, clearcoat: 0.2, clearcoatRoughness: 0.55 }),
      clampXray: mk('#778797', 0.62, 0.32, XRAY),
      beam: mk('#314258', 0.52, 0.36),
      finger: mk('#2d72b8', 0.58, 0.3),
      collision: mk('#667480', 0.25, 0.42, { emissive: SIM_COLORS.collision, emissiveIntensity: 0.38 }),
    };
  }, []);
  useEffect(() => () => { for (const m of Object.values(mats)) m.dispose(); }, [mats]);
  return mats;
}

export function MachineModel({ machine, setup, library, ramY, fingers, collisionKinds, xray = false }: MachineModelProps) {
  const mats = useMaterials();
  const obstacles = useMemo(() => machineObstacles(machine, setup, library, ramY, fingers), [machine, setup, library, ramY, fingers]);
  const { dieHeight, punchHeight } = toolStack(setup, library);
  const levels = useMemo(() => machineLevels(machine, dieHeight, punchHeight), [machine, dieHeight, punchHeight]);
  const bed = machine.bedLength;
  const finger = useMemo(() => library.fingers.find(f => f.id === machine.backgauge.fingerId) ?? flatFinger(), [library, machine.backgauge.fingerId]);
  const fingerGeometry = useMemo(() => profileGeometry(finger.profile.points, finger.width), [finger]);
  useEffect(() => () => fingerGeometry.dispose(), [fingerGeometry]);

  const pick = (kind: ObstacleKind, normal: THREE.Material): THREE.Material => (collisionKinds.has(kind) ? mats.collision : normal);

  return (
    <group name="machine">
      {obstacles.map(o => {
        if (o.kind === 'punch' || o.kind === 'die' || o.kind === 'frame') return null;   // tools: ToolModel; frames: below
        if (o.kind === 'finger') {
          const i = Number(o.id.split(':')[1]);
          const f = fingers[i];
          if (!f) return null;
          return (
            <mesh
              key={o.id}
              name={o.id}
              geometry={fingerGeometry}
              material={pick('finger', mats.finger)}
              position={[f.x, f.r, f.z - finger.width / 2]}
              castShadow
              receiveShadow
            >
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
      <MachineAppearance
        machine={machine}
        levels={levels}
        ramY={ramY}
        collisionKinds={collisionKinds}
        collisionMaterial={mats.collision}
        xray={xray}
      />
    </group>
  );
}
