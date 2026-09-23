/**
 * sim-3d — the folded part: one BufferGeometry per flange (FLAT coordinates, built once per
 * PartModel) positioned by partTransform · flange.transform, plus one mesh per bend zone whose
 * preallocated attributes are refilled in place when the bend's own fraction changes by more
 * than ZONE_REFILL_DELTA. See docs/specs/sim-3d.md §3–4.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { FoldState, Mat4, PartModel } from '../core/types';
import { mat4 } from '../core/geom';
import { foldGeometry } from '../core/part';
import {
  buildFlangeGeometry, fillBendZoneArrays, zoneHandedness, zoneIndices, zoneToLocal, zoneParentFlangeIndex, zoneVertexCount, ZONE_SEGMENTS,
} from './partGeometry';
import { SIM_COLORS, ZONE_REFILL_DELTA } from './scene';

export interface PartMeshProps {
  part: PartModel;
  thickness: number;
  foldState: FoldState;
  /** PART → scene (machine) transform, used verbatim. */
  partTransform: Mat4;
  /** Flange tinted as the gauged one (toward the backgauge). */
  gaugedFlangeId?: string | null;
  /** The frame reports a collision: the whole part turns red with an emissive pulse. */
  collision?: boolean;
}

interface ZoneRecord {
  bendId: string;
  parentIndex: number;
  /** Sheet thickness the arrays were built for. */
  thickness: number;
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  normals: Float32Array;
  /** Index buffers for both handednesses (built once; the geometry swaps between them). */
  indexFor: { 1: THREE.BufferAttribute; '-1': THREE.BufferAttribute };
  lastFraction: number | null;
  handedness: 0 | 1 | -1;
}

function makeFlangeGeometry(part: PartModel, index: number, thickness: number): THREE.BufferGeometry {
  const d = buildFlangeGeometry(part, index, thickness);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
  g.setIndex(new THREE.BufferAttribute(d.indices, 1));
  g.computeBoundingSphere();
  return g;
}

function makeZoneRecord(part: PartModel, bendId: string, thickness: number): ZoneRecord | null {
  const parentIndex = zoneParentFlangeIndex(part, bendId);
  if (parentIndex < 0) return null;
  const n = zoneVertexCount(ZONE_SEGMENTS);
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const geometry = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(positions, 3);
  const nor = new THREE.BufferAttribute(normals, 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  nor.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', pos);
  geometry.setAttribute('normal', nor);
  const indexFor = { 1: new THREE.BufferAttribute(zoneIndices(1, ZONE_SEGMENTS), 1), '-1': new THREE.BufferAttribute(zoneIndices(-1, ZONE_SEGMENTS), 1) };
  geometry.setIndex(indexFor[1]);
  return { bendId, parentIndex, thickness, geometry, positions, normals, indexFor, lastFraction: null, handedness: 1 };
}

export function PartMesh({ part, thickness, foldState, partTransform, gaugedFlangeId, collision = false }: PartMeshProps) {
  const invalidate = useThree(s => s.invalidate);

  const flangeGeometries = useMemo(() => part.flanges.map((_, i) => makeFlangeGeometry(part, i, thickness)), [part, thickness]);
  useEffect(() => () => { for (const g of flangeGeometries) g.dispose(); }, [flangeGeometries]);

  const zones = useMemo(() => {
    const out: ZoneRecord[] = [];
    for (const b of part.flat.bends) {
      const rec = makeZoneRecord(part, b.id, thickness);
      if (rec) out.push(rec);
    }
    return out;
  }, [part, thickness]);
  useEffect(() => () => { for (const z of zones) z.geometry.dispose(); }, [zones]);

  const materials = useMemo(() => ({
    sheet: new THREE.MeshStandardMaterial({ color: SIM_COLORS.sheet, metalness: 0.35, roughness: 0.55, side: THREE.DoubleSide }),
    gauged: new THREE.MeshStandardMaterial({ color: SIM_COLORS.gauged, metalness: 0.35, roughness: 0.55, side: THREE.DoubleSide }),
    collision: new THREE.MeshStandardMaterial({ color: SIM_COLORS.collision, emissive: SIM_COLORS.collision, emissiveIntensity: 0.4, metalness: 0.2, roughness: 0.5, side: THREE.DoubleSide }),
  }), []);
  useEffect(() => () => { materials.sheet.dispose(); materials.gauged.dispose(); materials.collision.dispose(); }, [materials]);

  // emissive pulse of the collision material (mutated through a ref inside the render loop)
  const pulseRef = useRef<THREE.MeshStandardMaterial | null>(null);
  useLayoutEffect(() => { pulseRef.current = materials.collision; }, [materials]);
  useFrame(state => {
    const m = pulseRef.current;
    if (m && collision) m.emissiveIntensity = 0.35 + 0.35 * Math.sin(2 * Math.PI * 1.5 * state.clock.elapsedTime);
  });

  const folded = useMemo(() => foldGeometry(part, foldState), [part, foldState]);

  const flangeMeshes = useRef<Array<THREE.Mesh | null>>([]);
  const zoneMeshes = useRef<Array<THREE.Mesh | null>>([]);

  useLayoutEffect(() => {
    // flanges: matrix = partTransform · flange.transform
    folded.flanges.forEach((f, i) => {
      const mesh = flangeMeshes.current[i];
      if (!mesh) return;
      mesh.matrix.fromArray(mat4.multiply(partTransform, f.transform));
      mesh.matrixWorldNeedsUpdate = true;
    });
    // zones: local geometry in the parent's frame, matrix = partTransform · T_parent
    const byId = new Map(folded.bends.map(b => [b.bendId, b]));
    zones.forEach((z, i) => {
      const mesh = zoneMeshes.current[i];
      const zone = byId.get(z.bendId);
      const parent = folded.flanges[z.parentIndex];
      if (!mesh || !zone || !parent) { if (mesh) mesh.visible = false; return; }
      mesh.visible = true;
      const f = foldState[z.bendId] ?? 0;
      if (z.lastFraction === null || Math.abs(f - z.lastFraction) > ZONE_REFILL_DELTA) {
        const local = zoneToLocal(zone, mat4.invert(parent.transform));
        fillBendZoneArrays(local, z.thickness, ZONE_SEGMENTS, z.positions, z.normals);
        const h = zoneHandedness(local);
        if (h !== z.handedness) {
          z.geometry.setIndex(z.indexFor[h]);
          z.handedness = h;
        }
        const pos = z.geometry.getAttribute('position') as THREE.BufferAttribute;
        const nor = z.geometry.getAttribute('normal') as THREE.BufferAttribute;
        pos.needsUpdate = true;
        nor.needsUpdate = true;
        z.geometry.computeBoundingSphere();
        z.lastFraction = f;
      }
      mesh.matrix.fromArray(mat4.multiply(partTransform, parent.transform));
      mesh.matrixWorldNeedsUpdate = true;
    });
    invalidate();
  }, [folded, foldState, partTransform, zones, invalidate]);

  const flangeMaterial = (flangeId: string): THREE.Material =>
    collision ? materials.collision : flangeId === gaugedFlangeId ? materials.gauged : materials.sheet;
  const zoneMaterial = collision ? materials.collision : materials.sheet;

  return (
    <group name="part">
      {part.flanges.map((f, i) => (
        <mesh
          key={f.id}
          name={`flange:${f.id}`}
          ref={m => { flangeMeshes.current[i] = m; }}
          geometry={flangeGeometries[i]}
          material={flangeMaterial(f.id)}
          matrixAutoUpdate={false}
          frustumCulled={false}
        />
      ))}
      {zones.map((z, i) => (
        <mesh
          key={z.bendId}
          name={`zone:${z.bendId}`}
          ref={m => { zoneMeshes.current[i] = m; }}
          geometry={z.geometry}
          material={zoneMaterial}
          matrixAutoUpdate={false}
          frustumCulled={false}
        />
      ))}
    </group>
  );
}
