/**
 * Render-only machine skin. Clearance/collision truth stays in MachineModel's
 * machineObstacles()-derived meshes; every node here is explicitly marked visualOnly.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Edges } from '@react-three/drei';
import type { Machine, ObstacleKind } from '../core/types';
import type { MachineLevels } from '../core/machine';
import { deriveMachineAppearance } from './machineAppearance';
import type { MachineAppearanceBox, MachineAppearanceRole } from './machineAppearance';

export interface MachineAppearanceProps {
  machine: Machine;
  levels: MachineLevels;
  ramY: number;
  collisionKinds: ReadonlySet<ObstacleKind>;
  /** Shared authoritative collision material owned by MachineModel. */
  collisionMaterial: THREE.Material;
  /** Fade only the moving upper fascia while the active bend is the visual subject. */
  xray?: boolean | undefined;
}

const EDGE_COLOR = '#101923';

type AppearanceMaterials = Record<MachineAppearanceRole, THREE.MeshPhysicalMaterial> & {
  ramXray: THREE.MeshPhysicalMaterial;
};

function useAppearanceMaterials(): AppearanceMaterials {
  const materials = useMemo(() => {
    const paint = (color: string, roughness: number, clearcoat = 0.22) => new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0.18,
      roughness,
      clearcoat,
      clearcoatRoughness: 0.55,
    });
    const metal = (color: string, roughness: number) => new THREE.MeshPhysicalMaterial({ color, metalness: 0.78, roughness });
    return {
      frame: paint('#29445e', 0.48, 0.26),
      'frame-cover': paint('#20364c', 0.52, 0.2),
      foot: paint('#17283a', 0.58, 0.12),
      'bed-fascia': paint('#345775', 0.44, 0.3),
      'ram-fascia': paint('#3b5f81', 0.42, 0.32),
      ramXray: new THREE.MeshPhysicalMaterial({
        color: '#3b5f81',
        metalness: 0.2,
        roughness: 0.46,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      }),
      accent: paint('#d0a12a', 0.42, 0.35),
      rail: metal('#405063', 0.34),
      hydraulic: metal('#9aa7b2', 0.24),
    };
  }, []);
  useEffect(() => () => { for (const material of Object.values(materials)) material.dispose(); }, [materials]);
  return materials;
}

interface AppearanceBoxMeshProps {
  box: MachineAppearanceBox;
  material: THREE.Material;
}

function AppearanceBoxMesh({ box, material }: AppearanceBoxMeshProps) {
  const width = Math.max(1e-3, box.x1 - box.x0);
  const height = Math.max(1e-3, box.y1 - box.y0);
  const depth = Math.max(1e-3, box.z1 - box.z0);
  const transparent = material.transparent && material.opacity < 1;
  return (
    <mesh
      name={`appearance:${box.id}`}
      position={[(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2]}
      material={material}
      castShadow={!transparent}
      receiveShadow
      userData={{ visualOnly: true, collisionKind: box.collisionKind }}
    >
      <boxGeometry args={[width, height, depth]} />
      {box.role !== 'accent' && <Edges color={EDGE_COLOR} threshold={30} transparent opacity={0.34} />}
    </mesh>
  );
}

export function MachineAppearance({ machine, levels, ramY, collisionKinds, collisionMaterial, xray = false }: MachineAppearanceProps) {
  const materials = useAppearanceMaterials();
  const layout = useMemo(
    () => deriveMachineAppearance(machine, levels, ramY),
    [machine, levels, ramY],
  );
  const pick = (role: MachineAppearanceRole, kind: ObstacleKind): THREE.Material => {
    if (collisionKinds.has(kind)) return collisionMaterial;
    if (xray && role === 'ram-fascia') return materials.ramXray;
    return materials[role];
  };

  return (
    <group name="appearance:machine-shell" userData={{ visualOnly: true }}>
      {layout.boxes.map(box => (
        <AppearanceBoxMesh key={box.id} box={box} material={pick(box.role, box.collisionKind)} />
      ))}
      {layout.cylinders.map(cylinder => (
        <mesh
          key={cylinder.id}
          name={`appearance:${cylinder.id}`}
          position={[cylinder.x, cylinder.y, cylinder.z]}
          material={pick(cylinder.role, cylinder.collisionKind)}
          castShadow
          receiveShadow
          userData={{ visualOnly: true, collisionKind: cylinder.collisionKind }}
        >
          <cylinderGeometry args={[cylinder.radius, cylinder.radius, cylinder.height, 24]} />
          <Edges color={EDGE_COLOR} threshold={35} transparent opacity={0.28} />
        </mesh>
      ))}
    </group>
  );
}
