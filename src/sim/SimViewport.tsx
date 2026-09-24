/**
 * sim-3d — the R3F viewport: lights, grid, orbit controls, camera presets, machine, tools and
 * part composed from the store's interpolated frame (or the idle preview), collision
 * highlighting, playback clock, DOM overlays (caption, collision badge, section inset).
 * See docs/specs/sim-3d.md §4.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import type { BendProgram, Machine, PartModel, ToolSetup, Vec3 } from '../core/types';
import { foldGeometry, finishedState } from '../core/part';
import { machineLevels } from '../core/machine';
import { useSimStore, currentFrame } from './store';
import type { CameraPreset } from './store';
import { EMPTY_SETUP, idleFrame, sceneFrameOf, stationCentreZ, stationOf, stepOf, collisionKinds, toolStack } from './scene';
import type { SceneFrame, SimLibrary } from './scene';
import { PartMesh } from './PartMesh';
import { MachineModel } from './MachineModel';
import { ToolModel } from './ToolModel';
import { SectionView } from './SectionView';
import { withFallback } from './labels';
import type { TranslateFn } from './labels';
import './sim.css';

export interface SimSceneProps {
  part: PartModel | null;
  program: BendProgram | null;
  machine: Machine;
  library: SimLibrary;
  /** Mounted tools; default: program.setup (no stations without a program). */
  setup?: ToolSetup | undefined;
}

export interface SimViewportProps extends SimSceneProps {
  t?: TranslateFn | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /** Show the 2D section as an inset when the store's showSection is on (default true). */
  sectionInset?: boolean | undefined;
}

/**
 * Direction from the framing target to the camera per preset (machine frame). The tools, clamp
 * and ram are extruded along the whole bed, so every preset keeps the camera in front of the
 * clamp (−X) or above the ram: a camera inside those extrusions sees only their inner faces.
 */
const PRESET_DIRS: Record<CameraPreset, Vec3> = {
  iso: { x: -0.9, y: 0.42, z: -0.5 },
  front: { x: -1, y: 0.25, z: 0 },
  side: { x: -0.35, y: 0.22, z: 1 },
  top: { x: -0.05, y: 1, z: 0 },
};
/** Camera distance = radius / tan(fov/2) × this. */
const FRAME_FACTOR = 1.25;
/** The top preset looks down from at least this far above the ram beam at TDC (mm). */
const TOP_CLEARANCE = 150;
/** Largest time step fed to the store per rendered frame (a hidden tab must not jump ahead). */
const MAX_TICK_S = 0.25;
const CAMERA_OPTIONS = { fov: 40, near: 1, far: 40000, position: [-900, 700, -700] as [number, number, number] };

function Clock() {
  const wasPlaying = useRef(false);
  useFrame((_, dt) => {
    const s = useSimStore.getState();
    // the first delta after a pause spans the whole pause (the clock keeps running in demand mode): skip it
    if (s.playing && wasPlaying.current) s.tick(Math.min(dt, MAX_TICK_S));
    wasPlaying.current = s.playing;
  });
  return null;
}

interface RigProps {
  /** Framing target (memoised by the caller: a new object re-frames the camera). */
  target: Vec3;
  radius: number;
  /** Top of the ram beam at TDC: the top preset stays above it. */
  ramTopY: number;
  /** Changes when the program/part change so the camera re-frames. */
  sceneKey: string;
}

function CameraRig({ target, radius, ramTopY, sceneKey }: RigProps) {
  const preset = useSimStore(s => s.cameraPreset);
  const nonce = useSimStore(s => s.cameraNonce);
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as unknown as { target: THREE.Vector3; update(): void } | null;
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    const dir = PRESET_DIRS[preset];
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 40;
    let d = (radius / Math.tan((fov / 2) * (Math.PI / 180))) * FRAME_FACTOR;
    if (preset === 'top') d = Math.max(d, ((ramTopY + TOP_CLEARANCE - target.y) * l) / dir.y);
    camera.up.set(0, 1, 0);
    camera.position.set(target.x + (dir.x / l) * d, target.y + (dir.y / l) * d, target.z + (dir.z / l) * d);
    camera.lookAt(target.x, target.y, target.z);
    camera.updateProjectionMatrix();
    if (controls) { controls.target.set(target.x, target.y, target.z); controls.update(); }
    invalidate();
  }, [preset, nonce, sceneKey, target, radius, ramTopY, camera, controls, invalidate]);
  return null;
}

interface SceneContentProps extends SimSceneProps {
  setup: ToolSetup;
  frame: SceneFrame;
  sceneKey: string;
}

function SceneContent({ part, program, machine, library, setup, frame, sceneKey }: SceneContentProps) {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => { invalidate(); }, [frame, invalidate]);
  // The ram beam and clamp are far larger than any part and sit right above the bend: they are
  // always drawn translucent so the part stays visible; the punch itself goes translucent only in
  // the plan view, where it would hide the bend line.
  const topView = useSimStore(s => s.cameraPreset === 'top');
  const xray = true;
  const toolXray = topView;

  const step = stepOf(program, frame);
  const station = stationOf(setup, step);
  const kinds = useMemo(() => collisionKinds(frame.collisions), [frame.collisions]);
  const { dieHeight, punchHeight } = toolStack(setup, library);
  const levels = machineLevels(machine, dieHeight, punchHeight);
  const floorY = levels.tableTopY - machine.table.height - 120;

  // framing: the active station's centre just above the die plane. With a part loaded the radius
  // follows the finished part (plus the die body and punch tip that surround it) so the bend is
  // the subject of the picture; the clamp and ram enter the frame only for larger parts. Without a
  // part the tool stack (table top → clamp bottom at TDC) is framed instead.
  const stackHalf = 0.5 * (levels.tdcClampY + machine.ram.clampHeight - levels.tableTopY);
  const radius = useMemo(() => {
    if (!part) return Math.max(400, stackHalf * 1.3);
    const b = foldGeometry(part, finishedState(part)).bounds;
    const diag = Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    return Math.max(140, diag * 0.55 + 40);
  }, [part, stackHalf]);
  const zc = stationCentreZ(station ?? setup.stations[0], machine);
  const target = useMemo<Vec3>(() => ({ x: 10, y: part ? 45 : 80, z: zc }), [zc, part]);
  const ramTopY = levels.tdcClampY + machine.ram.clampHeight + machine.ram.height;

  return (
    <>
      <color attach="background" args={['#e9ecf0']} />
      <hemisphereLight args={['#ffffff', '#5a6068', 1.6]} />
      <directionalLight position={[-800, 1200, -500]} intensity={3.2} />
      <directionalLight position={[600, 500, 900]} intensity={1.2} />
      <ambientLight intensity={0.9} />
      <Grid
        position={[0, floorY, machine.bedLength / 2]}
        args={[machine.bedLength + 3000, 4000]}
        cellSize={100}
        sectionSize={500}
        cellColor="#c3c9d1"
        sectionColor="#9aa3ad"
        fadeDistance={8000}
        fadeStrength={1.5}
        infiniteGrid
      />
      <OrbitControls makeDefault enableDamping={false} maxDistance={20000} />
      <CameraRig target={target} radius={radius} ramTopY={ramTopY} sceneKey={sceneKey} />
      <Clock />
      <MachineModel machine={machine} setup={setup} library={library} ramY={frame.ramY} fingers={frame.backgauge} collisionKinds={kinds} xray={xray} />
      {setup.stations.map(st => (
        <ToolModel
          key={st.id}
          station={st}
          punch={library.punches.find(p => p.id === st.punchId)}
          die={library.dies.find(d => d.id === st.dieId)}
          ramY={frame.ramY}
          step={step}
          collisionKinds={kinds}
          xray={toolXray}
        />
      ))}
      {part && (
        <PartMesh
          part={part}
          thickness={part.flat.thickness}
          foldState={frame.foldState}
          partTransform={frame.partTransform}
          gaugedFlangeId={step?.placement.gaugedFlangeId ?? null}
          collision={frame.collisions.length > 0}
        />
      )}
    </>
  );
}

export function SimViewport({ part, program, machine, library, setup, t, className, style, sectionInset = true }: SimViewportProps) {
  const tt = useMemo(() => withFallback(t), [t]);
  const storeFrame = useSimStore(currentFrame);
  const playing = useSimStore(s => s.playing);
  const showSection = useSimStore(s => s.showSection);
  const pausedAtCollision = useSimStore(s => s.pausedAtCollision);
  const hasKeyframes = useSimStore(s => s.keyframes.length > 0);
  const effSetup = setup ?? program?.setup ?? EMPTY_SETUP;
  const idle = useMemo(() => idleFrame(part, machine, effSetup, library), [part, machine, effSetup, library]);
  const frame: SceneFrame = useMemo(() => (storeFrame ? sceneFrameOf(storeFrame) : idle), [storeFrame, idle]);
  const sceneKey = `${program?.partId ?? ''}:${program?.steps.length ?? 0}:${part?.flat.id ?? ''}`;
  const hasCollision = frame.collisions.length > 0;
  const step = stepOf(program, frame);

  const caption = !hasKeyframes
    ? (program ? '' : tt('sim.noProgram'))
    : step
      ? `${tt('sim.step', { index: step.index + 1, bendId: step.bendId })}${frame.phase ? ' · ' + tt(`sim.phase.${frame.phase}`) : ''}`
      : '';

  const collisionText = (key: string, params: Record<string, string | number> | undefined, kind: string, depth: number): string => {
    const s = tt(key, params);
    return s === key ? `${kind} (${depth.toFixed(1)} mm)` : s;
  };

  return (
    <div className={className ? `pbsim-viewport ${className}` : 'pbsim-viewport'} style={style}>
      <Canvas
        frameloop={playing || hasCollision ? 'always' : 'demand'}
        dpr={[1, 2]}
        camera={CAMERA_OPTIONS}
        gl={{ antialias: true }}
      >
        <SceneContent part={part} program={program} machine={machine} library={library} setup={effSetup} frame={frame} sceneKey={sceneKey} />
      </Canvas>
      {(caption || (!hasKeyframes && part)) && (
        <div className="pbsim-caption" data-testid="sim-caption">{caption || tt('sim.idle')}</div>
      )}
      {hasCollision && (
        <div className="pbsim-collisions" role="status" data-testid="sim-collisions">
          <div className="pbsim-collisions-title">{tt('sim.collisions')}{pausedAtCollision !== null ? ` — ${tt('sim.pausedOnCollision')}` : ''}</div>
          <ul>
            {frame.collisions.map((c, i) => (
              <li key={`${c.with}:${i}`} className={c.severity === 'error' ? 'pbsim-col-error' : 'pbsim-col-warning'}>
                {collisionText(c.message.key, c.message.params, c.with, c.depth)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {sectionInset && showSection && (
        <div className="pbsim-section-inset">
          <SectionView part={part} program={program} machine={machine} library={library} setup={effSetup} frame={frame} t={tt} />
        </div>
      )}
    </div>
  );
}
