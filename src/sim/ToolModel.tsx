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

const EDGE_COLOR = '#1c2230';

function useToolMaterial(colour: string, xray = false): THREE.MeshStandardMaterial {
  const m = useMemo(
    () => new THREE.MeshStandardMaterial({ color: colour, metalness: 0.5, roughness: 0.45, ...(xray ? { transparent: true, opacity: 0.28, depthWrite: false } : {}) }),
    [colour, xray],
  );
  useEffect(() => () => m.dispose(), [m]);
  return m;
}

function useCollisionMaterial(): THREE.MeshStandardMaterial {
  const m = useMemo(() => new THREE.MeshStandardMaterial({ color: SIM_COLORS.collision, emissive: SIM_COLORS.collision, emissiveIntensity: 0.4, metalness: 0.3, roughness: 0.5 }), []);
  useEffect(() => () => m.dispose(), [m]);
  return m;
}

export function ToolModel({ station, punch, die, ramY, step, collisionKinds, xray = false }: ToolModelProps) {
  const zStart = Math.min(station.zStart, station.zEnd), zEnd = Math.max(station.zStart, station.zEnd);
  const toolMaterial = useToolMaterial(SIM_COLORS.punch);
  const punchXrayMaterial = useToolMaterial(SIM_COLORS.punch, true);
  const collisionMaterial = useCollisionMaterial();

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

  const punchMaterial = collisionKinds.has('punch') ? collisionMaterial : xray ? punchXrayMaterial : toolMaterial;
  const dieMaterial = collisionKinds.has('die') ? collisionMaterial : toolMaterial;

  return (
    <group name={`station:${station.id}`}>
      {die && dieGeometry && (
        <mesh name={`die:${station.id}`} geometry={dieGeometry} material={dieMaterial} position={[0, 0, zStart]}>
          <Edges color={EDGE_COLOR} threshold={25} />
        </mesh>
      )}
      {punch && (
        <group name={`punch:${station.id}`} position={[0, ramY - punch.height, 0]}>
          {pieces.map((p, i) => {
            const len = Math.max(0.5, p.z1 - p.z0 - SEGMENT_GAP);
            const g = punchGeometries.get(len.toFixed(3));
            if (!g) return null;
            return (
              <mesh key={`${i}:${p.z0}`} geometry={g} material={punchMaterial} position={[0, 0, p.z0 + SEGMENT_GAP / 2]}>
                <Edges color={EDGE_COLOR} threshold={25} />
              </mesh>
            );
          })}
        </group>
      )}
    </group>
  );
}
