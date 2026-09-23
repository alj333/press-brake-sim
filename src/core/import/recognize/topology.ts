/**
 * Mesh topology for the recogniser: welded vertices, per-triangle normals / areas / centroids and
 * edge adjacency. See docs/specs/recognize-3d.md §1.1. Pure; float64 throughout.
 */
import type { TriangleMesh, Vec3 } from '../../types';
import { weldMesh, WELD_TOL } from '../weld';
import type { FaceGroup } from '../weld';

export interface Topology {
  /** Welded vertex positions (xyz triplets, float64). */
  positions: Float64Array;
  vertexCount: number;
  /** Triangle vertex indices (triplets), degenerate triangles removed. */
  indices: Uint32Array;
  triCount: number;
  /** Unit normals per triangle (xyz triplets). */
  normals: Float64Array;
  areas: Float64Array;
  centroids: Float64Array;
  /** adj[3t + k] = triangle across edge (v_k, v_{k+1}) of t, or −1. */
  adj: Int32Array;
  /** 1 for slivers (smallest height < SLIVER_HEIGHT) whose float32 normal is not trustworthy. */
  sliver: Uint8Array;
  /** Face groups remapped to the surviving triangles (STEP), or undefined. */
  faceGroups?: FaceGroup[];
  openEdges: number;
  nonManifoldEdges: number;
}

/** Triangles thinner than this (smallest height, mm) have float32 normals off by more than the planar
 *  tolerance; they are ignored for the planar / curved decision and join faces by coplanarity. */
export const SLIVER_HEIGHT = 0.005;

/** Build the topology of a TriangleMesh (welds at 1e-3 mm first). */
export function buildTopology(mesh: TriangleMesh): Topology {
  const welded = weldMesh(mesh.positions, mesh.indices, WELD_TOL, mesh.faceGroups);
  const P = welded.positions;
  const vertexCount = P.length / 3;
  const rawIdx = welded.indices;
  const rawTri = rawIdx.length / 3;

  // drop zero-area triangles, keeping face groups consistent
  const keep = new Uint8Array(rawTri);
  const nrm = new Float64Array(rawTri * 3), ar = new Float64Array(rawTri), cen = new Float64Array(rawTri * 3);
  let kept = 0;
  for (let t = 0; t < rawTri; t++) {
    const a = rawIdx[t * 3]! * 3, b = rawIdx[t * 3 + 1]! * 3, c = rawIdx[t * 3 + 2]! * 3;
    const ax = P[a]!, ay = P[a + 1]!, az = P[a + 2]!;
    const ux = P[b]! - ax, uy = P[b + 1]! - ay, uz = P[b + 2]! - az;
    const vx = P[c]! - ax, vy = P[c + 1]! - ay, vz = P[c + 2]! - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-12)) continue;
    keep[t] = 1; kept++;
    nrm[t * 3] = nx / l; nrm[t * 3 + 1] = ny / l; nrm[t * 3 + 2] = nz / l;
    ar[t] = l / 2;
    cen[t * 3] = (ax + P[b]! + P[c]!) / 3; cen[t * 3 + 1] = (ay + P[b + 1]! + P[c + 1]!) / 3; cen[t * 3 + 2] = (az + P[b + 2]! + P[c + 2]!) / 3;
  }

  // orientation: a closed mesh with outward normals has a positive signed volume; flip inward meshes
  let volume = 0;
  for (let t = 0; t < rawTri; t++) {
    if (!keep[t]) continue;
    const a = rawIdx[t * 3]! * 3, b = rawIdx[t * 3 + 1]! * 3, c = rawIdx[t * 3 + 2]! * 3;
    volume += P[a]! * (P[b + 1]! * P[c + 2]! - P[b + 2]! * P[c + 1]!)
      - P[a + 1]! * (P[b]! * P[c + 2]! - P[b + 2]! * P[c]!)
      + P[a + 2]! * (P[b]! * P[c + 1]! - P[b + 1]! * P[c]!);
  }
  const flip = volume < 0;

  const indices = new Uint32Array(kept * 3);
  const normals = new Float64Array(kept * 3), areas = new Float64Array(kept), centroids = new Float64Array(kept * 3);
  const sliver = new Uint8Array(kept);
  const newIndex = new Int32Array(rawTri + 1);
  let n = 0;
  for (let t = 0; t < rawTri; t++) {
    newIndex[t] = n;
    if (!keep[t]) continue;
    {
      const a = rawIdx[t * 3]! * 3, b = rawIdx[t * 3 + 1]! * 3, c = rawIdx[t * 3 + 2]! * 3;
      const lab = Math.hypot(P[a]! - P[b]!, P[a + 1]! - P[b + 1]!, P[a + 2]! - P[b + 2]!);
      const lbc = Math.hypot(P[b]! - P[c]!, P[b + 1]! - P[c + 1]!, P[b + 2]! - P[c + 2]!);
      const lca = Math.hypot(P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!);
      if ((2 * ar[t]!) / Math.max(lab, lbc, lca) < SLIVER_HEIGHT) sliver[n] = 1;
    }
    indices[n * 3] = rawIdx[t * 3]!;
    if (flip) { indices[n * 3 + 1] = rawIdx[t * 3 + 2]!; indices[n * 3 + 2] = rawIdx[t * 3 + 1]!; }
    else { indices[n * 3 + 1] = rawIdx[t * 3 + 1]!; indices[n * 3 + 2] = rawIdx[t * 3 + 2]!; }
    const s = flip ? -1 : 1;
    normals[n * 3] = s * nrm[t * 3]!; normals[n * 3 + 1] = s * nrm[t * 3 + 1]!; normals[n * 3 + 2] = s * nrm[t * 3 + 2]!;
    areas[n] = ar[t]!;
    centroids[n * 3] = cen[t * 3]!; centroids[n * 3 + 1] = cen[t * 3 + 1]!; centroids[n * 3 + 2] = cen[t * 3 + 2]!;
    n++;
  }
  newIndex[rawTri] = n;

  let faceGroups: FaceGroup[] | undefined;
  if (welded.faceGroups) {
    faceGroups = [];
    for (const g of welded.faceGroups) {
      const first = newIndex[g.first]!, last = newIndex[g.last + 1]! - 1;
      if (last >= first) faceGroups.push({ first, last });
    }
  }

  // edge adjacency
  const adj = new Int32Array(kept * 3).fill(-1);
  const edgeTri = new Map<number, number>();          // edge key → first triangle*3+k
  const edgeCount = new Map<number, number>();
  let openEdges = 0, nonManifoldEdges = 0;
  const N = vertexCount + 1;
  for (let t = 0; t < kept; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k]!, b = indices[t * 3 + ((k + 1) % 3)]!;
      const key = a < b ? a * N + b : b * N + a;
      const prev = edgeTri.get(key);
      const cnt = (edgeCount.get(key) ?? 0) + 1;
      edgeCount.set(key, cnt);
      if (prev === undefined) { edgeTri.set(key, t * 3 + k); continue; }
      if (cnt === 2) {
        const pt = Math.floor(prev / 3), pk = prev % 3;
        adj[t * 3 + k] = pt;
        adj[pt * 3 + pk] = t;
      }
    }
  }
  for (const cnt of edgeCount.values()) {
    if (cnt === 1) openEdges++;
    else if (cnt > 2) nonManifoldEdges++;
  }

  return {
    positions: Float64Array.from(P), vertexCount, indices, triCount: kept, normals, areas, centroids, adj, sliver,
    faceGroups, openEdges, nonManifoldEdges,
  };
}

export function vertex(topo: Topology, i: number): Vec3 {
  const P = topo.positions;
  return { x: P[i * 3]!, y: P[i * 3 + 1]!, z: P[i * 3 + 2]! };
}

export function triNormal(topo: Topology, t: number): Vec3 {
  const N = topo.normals;
  return { x: N[t * 3]!, y: N[t * 3 + 1]!, z: N[t * 3 + 2]! };
}

export function triCentroid(topo: Topology, t: number): Vec3 {
  const C = topo.centroids;
  return { x: C[t * 3]!, y: C[t * 3 + 1]!, z: C[t * 3 + 2]! };
}

/** Angle (deg) between two unit vectors, robust to rounding. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}
