/**
 * sim-3d — part geometry builders (pure; three's ShapeUtils / Vector2 only, no DOM).
 * See docs/specs/sim-3d.md §3.
 *
 * - `buildFlangeGeometry`: one extruded mesh per flange in FLAT coordinates (u, v, w), holes via
 *   ShapeUtils.triangulateShape; positioned in the scene by partTransform · flange.transform.
 * - `buildBendZoneGeometry` / `fillBendZoneArrays`: the curved zone (inner + outer surfaces and
 *   the two end caps) with a CONSTANT vertex/index count so it can be regenerated in place into
 *   preallocated buffer attributes.
 * - `zoneToLocal`: the zone expressed in its parent flange's local frame, where it depends only on
 *   the bend's own fraction.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { Mat4, PartModel, Polygon2, Vec3 } from '../core/types';
import { mat4, vec3, ensureCCW, ensureCW } from '../core/geom';
import { isStraightZone, zonePoint, zoneStripPoint } from '../core/part';
import type { FoldedBend } from '../core/part';

export interface MeshData {
  /** xyz triplets. */
  positions: Float32Array;
  /** Unit normals, one per vertex. */
  normals: Float32Array;
  /** Triangle index triplets. */
  indices: Uint32Array;
}

/** Arc segments per bend zone (13 samples per surface). */
export const ZONE_SEGMENTS = 12;

/** Vertices of a zone mesh: 4 strips (inner, outer, cap λ = 0, cap λ = 1) × 2 rows × (segments + 1). */
export function zoneVertexCount(segments = ZONE_SEGMENTS): number {
  return 8 * (segments + 1);
}

/** Index count of a zone mesh: 4 strips × segments quads × 6. */
export function zoneIndexCount(segments = ZONE_SEGMENTS): number {
  return 24 * segments;
}

function triArea2(a: Vector2, b: Vector2, c: Vector2): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

/**
 * Extruded flange (regions ± t/2 in FLAT coordinates; holes triangulated with ShapeUtils). Flat
 * per-face normals: top +w, bottom −w, walls outward. Throws RangeError for a bad flange index.
 */
export function buildFlangeGeometry(part: PartModel, flangeIndex: number, thickness: number): MeshData {
  const flange = part.flanges[flangeIndex];
  if (!flange) throw new RangeError(`buildFlangeGeometry: no flange at index ${flangeIndex}`);
  const h = thickness / 2;
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];

  for (const region of flange.regions) {
    if (region.polygon.length < 3) continue;
    const outline: Polygon2 = ensureCCW(region.polygon);
    const holes: Polygon2[] = region.holes.filter(hl => hl.length >= 3).map(hl => ensureCW(hl));
    const contour = outline.map(p => new Vector2(p.x, p.y));
    const holeVecs = holes.map(hl => hl.map(p => new Vector2(p.x, p.y)));
    // triangulateShape may pop a duplicated closing point: read the rings back AFTER the call
    const tris = ShapeUtils.triangulateShape(contour, holeVecs);
    const rings: Vector2[][] = [contour, ...holeVecs];
    const flat: Vector2[] = rings.flat();

    const baseTop = pos.length / 3;
    for (const p of flat) { pos.push(p.x, p.y, h); nor.push(0, 0, 1); }
    const baseBottom = pos.length / 3;
    for (const p of flat) { pos.push(p.x, p.y, -h); nor.push(0, 0, -1); }
    for (const tri of tris) {
      const a = tri[0]!, b = tri[1]!, c = tri[2]!;
      const pa = flat[a], pb = flat[b], pc = flat[c];
      if (!pa || !pb || !pc) continue;
      if (triArea2(pa, pb, pc) >= 0) {
        idx.push(baseTop + a, baseTop + b, baseTop + c, baseBottom + a, baseBottom + c, baseBottom + b);
      } else {
        idx.push(baseTop + a, baseTop + c, baseTop + b, baseBottom + a, baseBottom + b, baseBottom + c);
      }
    }

    // side walls: one quad per edge, outward normal (e.y, −e.x) — CCW outline, CW holes
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = ring[i]!, q = ring[(i + 1) % n]!;
        const ex = q.x - p.x, ey = q.y - p.y;
        const len = Math.hypot(ex, ey);
        if (len < 1e-9) continue;
        const nx = ey / len, ny = -ex / len;
        const v0 = pos.length / 3;
        pos.push(p.x, p.y, -h, q.x, q.y, -h, q.x, q.y, h, p.x, p.y, h);
        for (let k = 0; k < 4; k++) nor.push(nx, ny, 0);
        idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      }
    }
  }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nor), indices: Uint32Array.from(idx) };
}

/** Unit direction from startEdge[0] to startEdge[1] (falls back to axisDir for a degenerate edge). */
function axialDir(b: FoldedBend): Vec3 {
  const d = vec3.sub(b.startEdge[1], b.startEdge[0]);
  const l = vec3.length(d);
  if (l < 1e-9) return vec3.normalize(b.axisDir);
  return vec3.scale(d, 1 / l);
}

/**
 * Handedness of the zone's (r̂, t̂, â) frame at φ = 0: sign((−toCentre × tangent) · axial).
 * Constant for a bend at every fraction (side · σ of the fold model), so the index buffer of a
 * zone mesh is built once.
 */
export function zoneHandedness(b: FoldedBend): 1 | -1 {
  const r0 = vec3.neg(b.toCentre);
  return vec3.dot(vec3.cross(r0, b.tangent), axialDir(b)) >= 0 ? 1 : -1;
}

/**
 * Index buffer of a zone mesh. Strip s (0 inner, 1 outer, 2 cap λ = 0, 3 cap λ = 1), row j
 * (0/1), sample i: vertex = s·2·(segments + 1) + j·(segments + 1) + i. For a right-handed frame
 * (h = 1): t̂ × â = r̂, so the quad (A = (0,i), B = (0,i+1), C = (1,i+1), D = (1,i)) winds toward
 * +r̂ on the inner/outer strips and toward −â on the caps; each strip is flipped where its
 * desired normal is the opposite (inner −r̂, outer +r̂, cap0 −â, cap1 +â).
 */
export function zoneIndices(handedness: 1 | -1, segments = ZONE_SEGMENTS): Uint32Array {
  const n1 = segments + 1;
  const out = new Uint32Array(zoneIndexCount(segments));
  const flip = [handedness === 1, handedness === -1, handedness === -1, handedness === 1];
  let k = 0;
  for (let s = 0; s < 4; s++) {
    const base = s * 2 * n1;
    for (let i = 0; i < segments; i++) {
      const A = base + i, B = base + i + 1, C = base + n1 + i + 1, D = base + n1 + i;
      if (flip[s]) {
        out[k++] = A; out[k++] = C; out[k++] = B;
        out[k++] = A; out[k++] = D; out[k++] = C;
      } else {
        out[k++] = A; out[k++] = B; out[k++] = C;
        out[k++] = A; out[k++] = C; out[k++] = D;
      }
    }
  }
  return out;
}

/**
 * Write the zone's surfaces into preallocated arrays (sizes ≥ 3·zoneVertexCount(segments)).
 * Inner surface at max(0, innerRadius) with normal −r̂, outer at innerRadius + t with +r̂, end
 * caps at λ = 0 (normal −â) and λ = 1 (+â). A straight zone is the flat strip ±t/2 sampled along
 * its width. Throws RangeError when the arrays are too small.
 */
export function fillBendZoneArrays(b: FoldedBend, thickness: number, segments: number, positions: Float32Array, normals: Float32Array): void {
  const n1 = segments + 1;
  const count = zoneVertexCount(segments);
  if (positions.length < 3 * count || normals.length < 3 * count) throw new RangeError('fillBendZoneArrays: arrays too small');
  const straight = isStraightZone(b);
  const a = axialDir(b);
  const rIn = straight ? 0 : Math.max(0, b.innerRadius);
  const rOut = straight ? 0 : Math.max(0, b.innerRadius) + thickness;
  const put = (v: number, p: Vec3, n: Vec3): void => {
    const o = 3 * v;
    positions[o] = p.x; positions[o + 1] = p.y; positions[o + 2] = p.z;
    normals[o] = n.x; normals[o + 1] = n.y; normals[o + 2] = n.z;
  };
  const negA = vec3.neg(a);
  const inner = 0, outer = 2 * n1, cap0 = 4 * n1, cap1 = 6 * n1;
  for (let i = 0; i <= segments; i++) {
    let pIn0: Vec3, pIn1: Vec3, pOut0: Vec3, pOut1: Vec3, rHat: Vec3;
    if (straight) {
      const along = (b.zoneWidth * i) / segments;
      pIn0 = zoneStripPoint(b, along, 0, thickness / 2);
      pIn1 = zoneStripPoint(b, along, 1, thickness / 2);
      pOut0 = zoneStripPoint(b, along, 0, -thickness / 2);
      pOut1 = zoneStripPoint(b, along, 1, -thickness / 2);
      rHat = vec3.neg(b.toCentre);
    } else {
      const phi = (b.currentAngle * i) / segments;
      pIn0 = zonePoint(b, phi, 0, rIn);
      pIn1 = zonePoint(b, phi, 1, rIn);
      pOut0 = zonePoint(b, phi, 0, rOut);
      pOut1 = zonePoint(b, phi, 1, rOut);
      const rad = (phi * Math.PI) / 180;
      rHat = vec3.normalize(vec3.add(vec3.scale(b.toCentre, -Math.cos(rad)), vec3.scale(b.tangent, Math.sin(rad))));
    }
    const nIn = vec3.neg(rHat);
    put(inner + i, pIn0, nIn);
    put(inner + n1 + i, pIn1, nIn);
    put(outer + i, pOut0, rHat);
    put(outer + n1 + i, pOut1, rHat);
    put(cap0 + i, pIn0, negA);
    put(cap0 + n1 + i, pOut0, negA);
    put(cap1 + i, pIn1, a);
    put(cap1 + n1 + i, pOut1, a);
  }
}

/**
 * Zone mesh (see fillBendZoneArrays). `out` reuses preallocated position/normal arrays; the
 * indices come from zoneIndices(zoneHandedness(bend)).
 */
export function buildBendZoneGeometry(
  bend: FoldedBend, thickness: number, segments = ZONE_SEGMENTS,
  out?: { positions: Float32Array; normals: Float32Array },
): MeshData {
  const count = zoneVertexCount(segments);
  const positions = out?.positions ?? new Float32Array(3 * count);
  const normals = out?.normals ?? new Float32Array(3 * count);
  fillBendZoneArrays(bend, thickness, segments, positions, normals);
  return { positions, normals, indices: zoneIndices(zoneHandedness(bend), segments) };
}

/** The zone mapped through `inverseParent` (the inverse of the parent flange's transform). */
export function zoneToLocal(b: FoldedBend, inverseParent: Mat4): FoldedBend {
  return {
    ...b,
    axisPoint: mat4.applyToPoint(inverseParent, b.axisPoint),
    axisDir: vec3.normalize(mat4.applyToDir(inverseParent, b.axisDir)),
    startEdge: [mat4.applyToPoint(inverseParent, b.startEdge[0]), mat4.applyToPoint(inverseParent, b.startEdge[1])],
    toCentre: vec3.normalize(mat4.applyToDir(inverseParent, b.toCentre)),
    tangent: vec3.normalize(mat4.applyToDir(inverseParent, b.tangent)),
  };
}

/**
 * Index (into part.flanges) of the flange that carries a bend zone in foldGeometry: the link's
 * parent flange, or for a loose (unlinked) bend the first flange whose bendIds contains it.
 * −1 when no flange touches the bend.
 */
export function zoneParentFlangeIndex(part: PartModel, bendId: string): number {
  const link = part.links.find(l => l.bendId === bendId);
  const id = link ? link.parentFlangeId : part.flanges.find(f => f.bendIds.includes(bendId))?.id;
  if (id === undefined) return -1;
  return part.flanges.findIndex(f => f.id === id);
}

/** Axis-aligned bounds of the mesh vertices, optionally mapped through a transform. */
export function meshDataBounds(data: Pick<MeshData, 'positions'>, transform?: Mat4): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const p = data.positions;
  for (let i = 0; i + 2 < p.length; i += 3) {
    let v: Vec3 = { x: p[i]!, y: p[i + 1]!, z: p[i + 2]! };
    if (transform) v = mat4.applyToPoint(transform, v);
    if (v.x < min.x) min.x = v.x; if (v.y < min.y) min.y = v.y; if (v.z < min.z) min.z = v.z;
    if (v.x > max.x) max.x = v.x; if (v.y > max.y) max.y = v.y; if (v.z > max.z) max.z = v.z;
  }
  if (!Number.isFinite(min.x)) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return { min, max };
}
