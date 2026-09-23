/**
 * TEST-ONLY helper (not exported from the barrel): build a closed triangle mesh of a FOLDED
 * sheet-metal part from a FlatPattern, through core-geometry's foldGeometry (constant-arc-length
 * model). Flanges become prisms (mid-surface ± t/2), bend zones become tessellated arcs (inner +
 * outer surface + end caps) whose tangent-line vertices coincide with the flange prisms, so the
 * recogniser sees the topology a CAD tessellation produces. Output is an unwelded float32 triangle
 * soup without face groups (an "STL"); `withGroups` adds one face group per planar / curved face
 * (a "STEP"). Holes are extruded too.
 */
import type { FlatPattern, Polygon2, Polygon3, TriangleMesh, Vec2, Vec3 } from '../../types';
import { vec2, vec3, signedArea } from '../../geom';
import { buildPartModel, foldGeometry, finishedState, zonePoint } from '../../part';

export interface SyntheticOptions {
  /** Facets per 90° of bend angle (default 16 ⇒ 5.625° steps). */
  facetsPer90?: number;
  /** Emit face groups (one per face) like a STEP import. Default false. */
  withGroups?: boolean;
  /** Name of the mesh. */
  name?: string;
  /** Flip every triangle (inward normals) — for orientation tests. */
  inward?: boolean;
}

/** Ear-clipping triangulation of a simple polygon (CCW), holes bridged in. Returns index triples. */
function triangulate(outer: Polygon2, holes: Polygon2[]): { points: Vec2[]; tris: number[] } {
  let ring = outer.slice();
  if (signedArea(ring) < 0) ring.reverse();
  // bridge holes (right-most vertex to the nearest visible outer vertex), largest x first
  const hs = holes.map(h => (signedArea(h) > 0 ? h.slice().reverse() : h.slice()));
  hs.sort((a, b) => Math.max(...b.map(p => p.x)) - Math.max(...a.map(p => p.x)));
  for (const h of hs) {
    let mi = 0;
    for (let i = 1; i < h.length; i++) if (h[i]!.x > h[mi]!.x) mi = i;
    const M = h[mi]!;
    // closest outer vertex to the right of M that is visible enough (no ring edge crosses the bridge)
    let best = -1, bestD = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      if (p.x < M.x - 1e-9) continue;
      const d = vec2.dist(p, M);
      if (d >= bestD) continue;
      let blocked = false;
      for (let j = 0; j < ring.length && !blocked; j++) {
        const a = ring[j]!, b = ring[(j + 1) % ring.length]!;
        if (a === p || b === p) continue;
        if (segmentsCross(M, p, a, b)) blocked = true;
      }
      if (!blocked) { best = i; bestD = d; }
    }
    if (best < 0) continue;
    const spliced: Vec2[] = [];
    for (let i = 0; i <= best; i++) spliced.push(ring[i]!);
    for (let k = 0; k < h.length; k++) spliced.push(h[(mi + k) % h.length]!);
    spliced.push(M);
    for (let i = best; i < ring.length; i++) spliced.push(ring[i]!);
    ring = spliced;
  }
  const points = ring.map(p => ({ x: p.x, y: p.y }));
  const idx = points.map((_, i) => i);
  const tris: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length]!, ib = idx[i]!, ic = idx[(i + 1) % idx.length]!;
      const a = points[ia]!, b = points[ib]!, c = points[ic]!;
      const cr = vec2.cross(vec2.sub(b, a), vec2.sub(c, a));
      if (cr <= 1e-12) continue;
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = points[j]!;
        if (vec2.equals(p, a, 1e-9) || vec2.equals(p, b, 1e-9) || vec2.equals(p, c, 1e-9)) continue;
        if (pointInTri(p, a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push(idx[0]!, idx[1]!, idx[2]!);
  return { points, tris };
}

function pointInTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = vec2.cross(vec2.sub(b, a), vec2.sub(p, a));
  const d2 = vec2.cross(vec2.sub(c, b), vec2.sub(p, b));
  const d3 = vec2.cross(vec2.sub(a, c), vec2.sub(p, c));
  return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
}

function segmentsCross(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): boolean {
  const d = vec2.cross(vec2.sub(p1, p0), vec2.sub(q1, q0));
  if (Math.abs(d) < 1e-12) return false;
  const t = vec2.cross(vec2.sub(q0, p0), vec2.sub(q1, q0)) / d;
  const u = vec2.cross(vec2.sub(q0, p0), vec2.sub(p1, p0)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** Build the folded mesh of a flat pattern. Throws when buildPartModel reports an error. */
export function foldedMesh(flat: FlatPattern, opts: SyntheticOptions = {}): TriangleMesh {
  const part = buildPartModel(flat);
  if (part.warnings.some(w => w.severity === 'error')) throw new Error(`buildPartModel: ${part.warnings.map(w => w.key).join(', ')}`);
  const folded = foldGeometry(part, finishedState(part));
  const t = flat.thickness;
  const per90 = opts.facetsPer90 ?? 16;

  const V: number[] = [];
  const I: number[] = [];
  const groups: Array<{ first: number; last: number }> = [];
  let groupStart = 0;
  const endGroup = (): void => {
    const last = I.length / 3 - 1;
    if (last >= groupStart) groups.push({ first: groupStart, last });
    groupStart = I.length / 3;
  };
  const addV = (p: Vec3): number => { V.push(p.x, p.y, p.z); return V.length / 3 - 1; };
  const tri = (a: Vec3, b: Vec3, c: Vec3): void => { I.push(addV(a), addV(b), addV(c)); };
  /** Quad a,b,c,d with the winding fixed so that the normal agrees with `outward`. */
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, outward: Vec3): void => {
    const n = vec3.cross(vec3.sub(b, a), vec3.sub(c, a));
    if (vec3.dot(n, outward) >= 0) { tri(a, b, c); tri(a, c, d); } else { tri(a, c, b); tri(a, d, c); }
  };

  // zone tangent segments (parent start edge and child end edge) — flange edges lying on them are interior
  const zoneEdges: Array<[Vec3, Vec3]> = [];
  for (const b of folded.bends) {
    zoneEdges.push(b.startEdge);
    const rm = b.midRadius;
    if (Number.isFinite(rm)) zoneEdges.push([zonePoint(b, b.currentAngle, 0, rm), zonePoint(b, b.currentAngle, 1, rm)]);
  }
  /** Portions [t0, t1] of the edge a→b (parameter along it) covered by collinear zone segments. */
  const zoneCover = (a: Vec3, b: Vec3): Array<[number, number]> => {
    const ab = vec3.sub(b, a), l2 = vec3.lengthSq(ab);
    const out: Array<[number, number]> = [];
    for (const [s0, s1] of zoneEdges) {
      // collinear: both zone ends within 1e-4 of the infinite line through a, b
      const lineDist = (p: Vec3): number => vec3.length(vec3.cross(vec3.sub(p, a), ab)) / Math.sqrt(l2);
      if (lineDist(s0) > 1e-4 || lineDist(s1) > 1e-4) continue;
      const t0 = vec3.dot(vec3.sub(s0, a), ab) / l2, t1 = vec3.dot(vec3.sub(s1, a), ab) / l2;
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
      if (hi - lo > 1e-9) out.push([lo, hi]);
    }
    return out.sort((p, q) => p[0] - q[0]);
  };

  // flange prisms
  for (const f of folded.flanges) {
    const n = f.normal;
    const off = vec3.scale(n, t / 2);
    for (const r of f.regions) {
      // plane basis for the 2D triangulation: project onto the flange plane
      const o = r.midSurface[0]!;
      const e1 = vec3.normalize(vec3.sub(r.midSurface[1]!, o));
      const e2 = vec3.cross(n, e1);
      const to2 = (p: Vec3): Vec2 => { const d = vec3.sub(p, o); return { x: vec3.dot(d, e1), y: vec3.dot(d, e2) }; };
      const to3 = (q: Vec2): Vec3 => vec3.add(o, vec3.add(vec3.scale(e1, q.x), vec3.scale(e2, q.y)));
      // insert the bend-line end points into the loops so the top / bottom triangulations share the
      // zone surfaces' vertices (no T-junctions)
      const refine = (loop: Polygon3): Polygon3 => {
        const out: Polygon3 = [];
        for (let i = 0, m = loop.length; i < m; i++) {
          const a = loop[i]!, b = loop[(i + 1) % m]!;
          out.push(a);
          if (vec3.dist(a, b) < 1e-9) continue;
          const cuts = new Set<number>();
          for (const [lo, hi] of zoneCover(a, b)) { if (lo > 1e-6) cuts.add(lo); if (hi < 1 - 1e-6) cuts.add(hi); }
          for (const c of [...cuts].sort((x, y) => x - y)) out.push(vec3.lerp(a, b, c));
        }
        return out;
      };
      const mid = refine(r.midSurface), holes3 = r.holes.map(refine);
      const { points, tris } = triangulate(mid.map(to2), holes3.map(h => h.map(to2)));
      const P3 = points.map(to3);
      for (let k = 0; k < tris.length; k += 3) {
        const a = P3[tris[k]!]!, b = P3[tris[k + 1]!]!, c = P3[tris[k + 2]!]!;
        tri(vec3.add(a, off), vec3.add(b, off), vec3.add(c, off));            // top (+n)
      }
      endGroup();
      for (let k = 0; k < tris.length; k += 3) {
        const a = P3[tris[k]!]!, b = P3[tris[k + 1]!]!, c = P3[tris[k + 2]!]!;
        tri(vec3.sub(a, off), vec3.sub(c, off), vec3.sub(b, off));            // bottom (−n)
      }
      endGroup();
      const walls = (loop: Polygon3): void => {
        for (let i = 0, m = loop.length; i < m; i++) {
          const a = loop[i]!, b = loop[(i + 1) % m]!;
          if (vec3.dist(a, b) < 1e-9) continue;
          const outward = vec3.cross(vec3.sub(b, a), n);
          // walls only where no bend zone starts / ends on this edge
          let from = 0;
          const spans: Array<[number, number]> = [];
          for (const [lo, hi] of zoneCover(a, b)) { if (lo - from > 1e-6) spans.push([from, lo]); from = Math.max(from, hi); }
          if (1 - from > 1e-6) spans.push([from, 1]);
          for (const [t0, t1] of spans) {
            const p = vec3.lerp(a, b, t0), q = vec3.lerp(a, b, t1);
            quad(vec3.sub(p, off), vec3.sub(q, off), vec3.add(q, off), vec3.add(p, off), outward);
            endGroup();
          }
        }
      };
      walls(mid);
      for (const h of holes3) walls(h);
    }
  }

  // bend zones
  for (const b of folded.bends) {
    if (!Number.isFinite(b.midRadius) || b.currentAngle < 0.01) continue;
    const ri = b.innerRadius, ro = ri + t;
    const n = Math.max(1, Math.round((b.currentAngle / 90) * per90));
    const at = (i: number, lambda: number, r: number): Vec3 => zonePoint(b, (b.currentAngle * i) / n, lambda, r);
    const centreAt = (lambda: number): Vec3 => vec3.add(vec3.lerp(b.startEdge[0], b.startEdge[1], lambda), vec3.scale(b.toCentre, b.midRadius));
    const axial = vec3.sub(b.startEdge[1], b.startEdge[0]);
    for (let i = 0; i < n; i++) {
      // inner surface (concave): outward = toward the axis
      const i0 = at(i, 0, ri), i1 = at(i + 1, 0, ri), i2 = at(i + 1, 1, ri), i3 = at(i, 1, ri);
      quad(i0, i1, i2, i3, vec3.sub(centreAt(0.5), vec3.midpoint(i0, i2)));
      if (!opts.withGroups) endGroup();
    }
    if (opts.withGroups) endGroup();
    for (let i = 0; i < n; i++) {
      const o0 = at(i, 0, ro), o1 = at(i + 1, 0, ro), o2 = at(i + 1, 1, ro), o3 = at(i, 1, ro);
      quad(o0, o1, o2, o3, vec3.sub(vec3.midpoint(o0, o2), centreAt(0.5)));
      if (!opts.withGroups) endGroup();
    }
    if (opts.withGroups) endGroup();
    for (const lambda of [0, 1]) {
      const outward = lambda === 0 ? vec3.neg(axial) : axial;
      for (let i = 0; i < n; i++) quad(at(i, lambda, ri), at(i + 1, lambda, ri), at(i + 1, lambda, ro), at(i, lambda, ro), outward);
      endGroup();
    }
  }

  const positions = Float32Array.from(V);
  const indices = Uint32Array.from(I);
  if (opts.inward) {
    for (let k = 0; k < indices.length; k += 3) { const b = indices[k + 1]!; indices[k + 1] = indices[k + 2]!; indices[k + 2] = b; }
  }
  const mesh: TriangleMesh = { positions, indices, units: 'mm', name: opts.name ?? flat.name };
  if (opts.withGroups) mesh.faceGroups = groups;
  return mesh;
}

/** Rectangle CCW from (0,0). */
export function rect(w: number, h: number, x0 = 0, y0 = 0): Polygon2 {
  return [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }];
}

/** Circle hole (CW) with n segments. */
export function circleCW(cx: number, cy: number, r: number, n = 72): Polygon2 {
  const out: Polygon2 = [];
  for (let i = 0; i < n; i++) { const a = (-2 * Math.PI * i) / n; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
  return out;
}

export interface ProfileBend { angle: number; ri: number; direction: 'up' | 'down' }

/**
 * A "profile" flat like samples/generate.py: straight flange lengths (flat portions) chained along
 * +x with bend lines across the width (along +y).
 */
export function profileFlat(name: string, straights: number[], bends: ProfileBend[], t: number, width: number, k = 0.44, holes: Polygon2[] = []): FlatPattern {
  let u = 0;
  const lines: FlatPattern['bends'] = [];
  for (let i = 0; i < straights.length; i++) {
    u += straights[i]!;
    if (i < bends.length) {
      const b = bends[i]!;
      const ba = ((b.angle * Math.PI) / 180) * (b.ri + k * t);
      const uc = u + ba / 2;
      lines.push({
        id: `B${i + 1}`, p0: { x: uc, y: 0 }, p1: { x: uc, y: width }, direction: b.direction, angle: b.angle, innerRadius: b.ri, kFactor: k,
        sources: { geometry: 'dxf', angle: 'dxf', radius: 'dxf', direction: 'dxf' },
      });
      u += ba;
    }
  }
  return { id: name, name, thickness: t, materialId: 'std:mild-steel', outline: rect(u, width), holes, bends: lines, sourceUnits: 'mm' };
}

export function bendLine(id: string, p0: Vec2, p1: Vec2, direction: 'up' | 'down', angle: number, ri: number, k = 0.44): FlatPattern['bends'][number] {
  return { id, p0, p1, direction, angle, innerRadius: ri, kFactor: k, sources: { geometry: 'dxf', angle: 'dxf', radius: 'dxf', direction: 'dxf' } };
}

export function ba(angle: number, ri: number, t: number, k = 0.44): number { return ((angle * Math.PI) / 180) * (ri + k * t); }
