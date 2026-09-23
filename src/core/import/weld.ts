/**
 * Vertex welding (pure): merge vertices within `tol` so consumers get shared edges, drop
 * degenerate triangles and remap STEP face groups (triangle index ranges) to the surviving
 * triangle numbering. See docs/specs/import-files.md §4.
 */

export interface FaceGroup { first: number; last: number }

export interface WeldResult {
  positions: Float32Array;
  indices: Uint32Array;
  faceGroups?: FaceGroup[];
  /** Degenerate triangles removed (two or more equal indices after welding). */
  degenerate: number;
  /** Face groups that became empty and were dropped. */
  droppedGroups: number;
  rawVertexCount: number;
}

export const WELD_TOL = 1e-3;

/** Merge vertices within `tol` (grid hash on round(x/tol) with a 27-cell neighbourhood on misses). */
export function weldMesh(
  positions: ArrayLike<number>, indices: ArrayLike<number>, tol = WELD_TOL, faceGroups?: FaceGroup[],
): WeldResult {
  const rawVertexCount = Math.floor(positions.length / 3);
  const inv = 1 / tol;
  const tol2 = tol * tol;
  const cells = new Map<number, number[]>();     // hash → new vertex ids
  const remap = new Int32Array(rawVertexCount);
  const out: number[] = [];                       // welded xyz
  let count = 0;

  const hash = (qx: number, qy: number, qz: number): number =>
    ((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) | 0;

  const findIn = (h: number, x: number, y: number, z: number): number => {
    const list = cells.get(h);
    if (!list) return -1;
    for (const id of list) {
      const dx = out[id * 3]! - x, dy = out[id * 3 + 1]! - y, dz = out[id * 3 + 2]! - z;
      if (dx * dx + dy * dy + dz * dz <= tol2) return id;
    }
    return -1;
  };

  for (let i = 0; i < rawVertexCount; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { remap[i] = -1; continue; }
    const qx = Math.round(x * inv), qy = Math.round(y * inv), qz = Math.round(z * inv);
    const h0 = hash(qx, qy, qz);
    let id = findIn(h0, x, y, z);
    if (id < 0) {
      search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        id = findIn(hash(qx + dx, qy + dy, qz + dz), x, y, z);
        if (id >= 0) break search;
      }
    }
    if (id < 0) {
      id = count++;
      out.push(x, y, z);
      const list = cells.get(h0);
      if (list) list.push(id); else cells.set(h0, [id]);
    }
    remap[i] = id;
  }

  const triCount = Math.floor(indices.length / 3);
  const newIdx: number[] = [];
  const keptBefore = new Uint32Array(triCount + 1);   // kept triangles with index < t
  let kept = 0, degenerate = 0;
  for (let t = 0; t < triCount; t++) {
    keptBefore[t] = kept;
    const a = remap[indices[t * 3]!] ?? -1, b = remap[indices[t * 3 + 1]!] ?? -1, c = remap[indices[t * 3 + 2]!] ?? -1;
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) { degenerate++; continue; }
    newIdx.push(a, b, c);
    kept++;
  }
  keptBefore[triCount] = kept;

  let groups: FaceGroup[] | undefined;
  let droppedGroups = 0;
  if (faceGroups) {
    groups = [];
    for (const g of faceGroups) {
      const first = Math.max(0, Math.min(triCount, g.first));
      const lastEx = Math.max(0, Math.min(triCount, g.last + 1));
      const nf = keptBefore[first]!, nl = keptBefore[lastEx]! - 1;
      if (nl < nf) { droppedGroups++; continue; }
      groups.push({ first: nf, last: nl });
    }
  }

  return {
    positions: Float32Array.from(out),
    indices: Uint32Array.from(newIdx),
    faceGroups: groups,
    degenerate,
    droppedGroups,
    rawVertexCount,
  };
}

/** Axis-aligned bounds of an xyz array. */
export function positionsBounds(positions: ArrayLike<number>): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}
