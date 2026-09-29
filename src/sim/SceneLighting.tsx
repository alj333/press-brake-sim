/**
 * Visual-only studio environment for the simulator. The receiver floor, lights and grid add
 * depth cues without participating in planning or collision geometry.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { Grid } from '@react-three/drei';

export interface SceneLightingProps {
  floorY: number;
  focusZ: number;
  bedLength: number;
  throatDepth: number;
}

export function SceneLighting({ floorY, focusZ, bedLength, throatDepth }: SceneLightingProps) {
  const keyTarget = useMemo(() => new THREE.Object3D(), []);
  keyTarget.position.set(0, 35, focusZ);

  const floorWidth = Math.max(3200, throatDepth + 2400);
  const floorDepth = bedLength + 1800;
  const shadowSpan = Math.max(900, Math.min(1800, bedLength * 0.55));

  return (
    <>
      <color attach="background" args={['#dce4eb']} />
      <hemisphereLight args={['#f8fbff', '#53606c', 1.35]} />
      <ambientLight intensity={0.28} />
      <primitive object={keyTarget} />
      <directionalLight
        castShadow
        target={keyTarget}
        position={[-900, 1450, focusZ - 850]}
        color="#fff8ee"
        intensity={2.75}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-shadowSpan}
        shadow-camera-right={shadowSpan}
        shadow-camera-top={shadowSpan}
        shadow-camera-bottom={-shadowSpan}
        shadow-camera-near={100}
        shadow-camera-far={4200}
        shadow-bias={-0.00015}
        shadow-normalBias={1.5}
      />
      <directionalLight position={[700, 650, focusZ + 900]} color="#dcecff" intensity={1.15} />
      <directionalLight position={[-450, 350, focusZ + 1200]} color="#ffffff" intensity={0.55} />
      <mesh
        name="appearance:studio-floor"
        position={[throatDepth * 0.18, floorY - 1.5, bedLength / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[floorWidth, floorDepth]} />
        <meshStandardMaterial color="#cbd4dd" metalness={0.04} roughness={0.96} />
      </mesh>
      <Grid
        position={[0, floorY + 0.5, bedLength / 2]}
        args={[floorDepth, floorWidth]}
        cellSize={100}
        sectionSize={500}
        cellThickness={0.55}
        sectionThickness={1.2}
        cellColor="#9ba8b4"
        sectionColor="#6f7e8c"
        fadeDistance={6500}
        fadeStrength={1.7}
        infiniteGrid
      />
    </>
  );
}
