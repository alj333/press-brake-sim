/**
 * sim-3d — one station's tools: the die extruded over the station's Z range at the origin and
 * the punch pieces (segments, or the current step's piece centred in the station) following the
 * ram (tip at ramY − punch.height). Profiles are mirrored in X when the station is flipped.
 * See docs/specs/sim-3d.md §4.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Edges } from '@react-three/drei';
import type { BendStep, Die, ObstacleKind, Punch, ToolStation } from '../core/types';
import { mirrorProfileX } from '../core/tools';
import { punchPieces, SIM_COLORS, SEGMENT_GAP } from './scene';
import { profileGeometry } from './threeUtils';

export interface ToolModelProps {
  station: ToolStation;
  punch?: Punch | undefined;
  die?: Die | undefined;
  /** Ram clamp bottom Y (machine frame). */
  ramY: number;
  /** Current program step (its punch piece is drawn when it uses this station). */
  step?: BendStep | undefined;
  collisionKinds: ReadonlySet<ObstacleKind>;
  /** Draw the punch translucent (plan view). */
  xray?: boolean | undefined;
}

function useToolMaterials() {
  const materials = useMemo(() => {
    const steel = (color: string, roughness: number, extra: Partial<THREE.MeshPhysicalMaterialParameters> = {}) =>
      new THREE.MeshPhysicalMaterial({
        color,
        metalness: 0.78,
        roughness,
        clearcoat: 0.12,
        clearcoatRoughness: 0.42,
        ...extra,
      });
    const xray = (active: boolean) => new THREE.MeshStandardMaterial({
      color: SIM_COLORS.punch,
      metalness: 0.58,
      roughness: 0.36,
      transparent: true,
      opacity: active ? 0.36 : 0.25,
      depthWrite: false,
      ...(active ? { emissive: SIM_COLORS.gauged, emissiveIntensity: 0.08 } : {}),
    });
    return {
      punch: steel(SIM_COLORS.punch, 0.3),
      punchActive: steel(SIM_COLORS.punch, 0.27, { emissive: SIM_COLORS.gauged, emissiveIntensity: 0.08 }),
      die: steel(SIM_COLORS.die, 0.34),
      dieActive: steel(SIM_COLORS.die, 0.3, { emissive: SIM_COLORS.gauged, emissiveIntensity: 0.07 }),
      punchXray: xray(false),
      punchXrayActive: xray(true),
      collision: steel('#6f7c87', 0.42, {
        metalness: 0.24,
        emissive: SIM_COLORS.collision,
        emissiveIntensity: 0.22,
      }),
    };
  }, []);
  useEffect(() => () => { for (const material of Object.values(materials)) material.dispose(); }, [materials]);
  return materials;
}

export function ToolModel({ station, punch, die, ramY, step, collisionKinds, xray = false }: ToolModelProps) {
  const zStart = Math.min(station.zStart, station.zEnd), zEnd = Math.max(station.zStart, station.zEnd);
  const materials = useToolMaterials();

  const dieGeometry = useMemo(() => {
    if (!die) return null;
    const prof = station.dieFlipped ? mirrorProfileX(die.profile.points) : die.profile.points;
    return profileGeometry(prof, zEnd - zStart);
  }, [die, station.dieFlipped, zStart, zEnd]);
  useEffect(() => () => { dieGeometry?.dispose(); }, [dieGeometry]);

  const pieces = useMemo(() => punchPieces(station, step), [station, step]);
  // distinct piece lengths (a string key so the geometry memo only reacts to real changes)
  const lengthKey = [...new Set(pieces.map(p => Math.max(0.5, p.z1 - p.z0 - SEGMENT_GAP).toFixed(3)))].join('|');

  const punchGeometries = useMemo(() => {
    const map = new Map<string, THREE.BufferGeometry>();
    if (!punch || lengthKey === '') return map;
    const prof = station.punchFlipped ? mirrorProfileX(punch.profile.points) : punch.profile.points;
    for (const key of lengthKey.split('|')) map.set(key, profileGeometry(prof, Number(key)));
    return map;
  }, [punch, station.punchFlipped, lengthKey]);
  useEffect(() => () => { for (const g of punchGeometries.values()) g.dispose(); }, [punchGeometries]);

  const activeStation = step?.stationId === station.id;
  const punchCollision = collisionKinds.has('punch');
  const dieCollision = collisionKinds.has('die');
  const punchMaterial = punchCollision
    ? materials.collision
    : xray
      ? activeStation ? materials.punchXrayActive : materials.punchXray
      : activeStation ? materials.punchActive : materials.punch;
  const dieMaterial = dieCollision ? materials.collision : activeStation ? materials.dieActive : materials.die;
  const punchEdge = punchCollision ? SIM_COLORS.collisionEdge : SIM_COLORS.toolEdge;
  const dieEdge = dieCollision ? SIM_COLORS.collisionEdge : SIM_COLORS.toolEdge;

  return (
    <group name={`station:${station.id}`}>
      {die && dieGeometry && (
        <mesh name={`die:${station.id}`} geometry={dieGeometry} material={dieMaterial} position={[0, 0, zStart]} castShadow receiveShadow>
          <Edges color={dieEdge} threshold={30} transparent opacity={dieCollision ? 0.82 : 0.48} />
        </mesh>
      )}
      {punch && (
        <group name={`punch:${station.id}`} position={[0, ramY - punch.height, 0]}>
          {pieces.map((p, i) => {
            const len = Math.max(0.5, p.z1 - p.z0 - SEGMENT_GAP);
            const g = punchGeometries.get(len.toFixed(3));
            if (!g) return null;
            return (
              <mesh
                key={`${i}:${p.z0}`}
                geometry={g}
                material={punchMaterial}
                position={[0, 0, p.z0 + SEGMENT_GAP / 2]}
                castShadow={!xray || punchCollision}
                receiveShadow
              >
                <Edges color={punchEdge} threshold={30} transparent opacity={punchCollision ? 0.82 : 0.48} />
              </mesh>
            );
          })}
        </group>
      )}
    </group>
  );
}
