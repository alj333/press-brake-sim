# core-geometry — `src/core/geom`, `src/core/bend`, `src/core/part`

Pure TypeScript (no DOM, no three.js). Units: mm, degrees at every API boundary, kN, MPa.
Types come from `src/core/types.ts` (the contract). Every sub-module has a barrel `index.ts`;
`src/core/geom/index.ts` re-exports `vec2` and `mat4` as namespaces (`export * as vec2`),
`vec3` likewise, and the polygon / arc / 3D helpers as plain named exports.

Tolerances: `EPS = 1e-6` for exact comparisons and on-line snapping, `0.01 mm` for boundary
chaining / union-find, `0.05 mm` default chord error, `Infinity` radii for straight zones.

---

## 1. `src/core/geom`

### 1.1 `vec2` (namespace)
`v2(x,y)`, `add, sub, scale, dot, cross(a,b)→number, length, lengthSq, normalize, perp(a)`
(rotate +90°: `(-y, x)`), `neg, dist, distSq, lerp, midpoint, equals(a,b,tol=EPS), rotate(a, deg),
angleDeg(a)`. All functions are pure and return new objects.

### 1.2 `vec3` (namespace)
`v3(x,y,z)`, `add, sub, scale, dot, cross, length, lengthSq, normalize, neg, dist, lerp, midpoint,
equals(a,b,tol=EPS)`, `xy(a)→Vec2`, `fromXY(p, z=0)`, `rotateAboutAxis(a, axis, deg)` (Rodrigues).

### 1.3 `mat4` (namespace) — column-major `number[16]`, three.js layout
Element `(row r, col c)` is `m[c*4 + r]`; translation in `m[12..14]`.
- `identity()`
- `multiply(a, b)` → `a·b` (apply `b` first, then `a`; same as three's `a.clone().multiply(b)`).
  `multiplyAll(...ms)` folds left to right.
- `invert(m)` general 4×4 inverse (throws on singular).
- `translation(v: Vec3)` / `translationXYZ(x, y, z)`.
- `fromAxisAngle(dir, deg)` rotation about an axis through the origin (Rodrigues; `dir` is
  normalised internally).
- `rotationAxisAngle(point, dir, deg)` = `T(point) · R(dir, deg) · T(−point)`.
- `applyToPoint(m, p)` (w = 1, affine — assumes m[3],m[7],m[11] = 0, m[15] = 1).
- `applyToDir(m, d)` (w = 0: no translation).
- `decompose(m)` → `{ position: Vec3, quaternion: Quat [x,y,z,w], scale: Vec3 }`
  (three.js `Matrix4.decompose` semantics: negative `scale.x` when det < 0).
- `compose(position, quaternion, scale = (1,1,1))` (three.js `Matrix4.compose`).
- `equals(a, b, tol)`, `clone(m)`, `scaling(sx, sy, sz)`, `determinant(m)`, `getPosition(m)`.

### 1.4 2D polygons (`polygon.ts`) — `Polygon2 = Vec2[]`, implicit closing edge
- `signedArea(p)` shoelace / 2 (CCW > 0); `area(p)` = |signedArea|; `isCCW(p)`;
  `ensureCCW(p)` returns `p` itself when CCW, otherwise a reversed copy; `ensureCW(p)`.
- `centroid(p)` area-weighted (vertex average when area < 1e-12).
- `bounds(p)` → `{ min, max }`.
- `pointInPolygon(pt, poly, tol = EPS)` → boolean, **on-edge (within tol) counts as inside**.
  `classifyPoint(pt, poly, tol)` → `'inside' | 'outside' | 'edge'` (ray casting + edge distance).
- `distanceToBoundary(pt, poly)` min distance to any edge.
- `segmentIntersect(a0, a1, b0, b1, tol = EPS)` → `{ point, ta, tb } | null` for closed segments
  (touching endpoints count; collinear overlapping segments return the overlap midpoint with
  `ta`/`tb` of that point).
- `segmentDistance(a0, a1, b0, b1)`.
- `polygonsIntersect(a, b)` → true when any edges cross/touch OR a vertex of one lies inside the
  other (containment either way). Closed-set semantics: touching ⇒ true.
- `penetrationDepth(a, b)` → 0 when disjoint or merely touching; otherwise a cheap **lower bound**
  on the minimum translation to separate: the max over (i) vertices of `a` strictly inside `b` of
  their distance to `b`'s boundary, (ii) midpoints of the sub-segments of `a`'s edges that lie
  inside `b` (edges are cut at every crossing with `b`'s boundary) of their distance to `b`'s
  boundary, (iii) the centroid of `a` when it is strictly inside both polygons (covers coincident
  polygons), and the same with the roles swapped. Covers "+"-shaped overlaps where no vertex is
  inside. Good enough for the 0.2 mm collision threshold. Fuzzed against random star / orthogonal
  polygons (scratch/fuzz-split.ts): area conservation, CCW output, no overlapping pieces.
- `polygonDistance(a, b)` → 0 when intersecting, else the min edge-to-edge distance.
- `splitPolygonByLine(poly, point, dir, tol = EPS)` → `{ left: Polygon2[], right: Polygon2[] }`.
  `left` = side where `cross(dir, p − point) > 0`. Robust for concave simple polygons:
  1. Input is `ensureCCW`'d. Signed distances are snapped to 0 when `|s| < tol`; intersection
     vertices are inserted on edges whose end signs are strictly opposite.
  2. On-line vertices are sorted along `dir`. Each interval between consecutive on-line points is
     classified: *collinear edge* (the two points are polygon-adjacent, direction ±dir),
     *inside* (midpoint strictly inside the polygon) or *outside*.
  3. For one side (σ = ±1): *chains* = maximal runs of σ-side vertices bounded by on-line
     vertices, in CCW order; *bridges* = inside intervals directed +dir for the left side (−dir
     for the right side) plus the collinear edges whose direction is +dir (left) / −dir (right).
  4. Trace: start at an unused chain, at its end take the bridge starting there (or, if none,
     the chain starting there), at a bridge end take the chain starting there (else the next
     bridge). Close when the start chain is reached. Every piece is a separate simple CCW polygon;
     pinch points (a polygon touching the line from one side) produce separate pieces.
  Whole polygon on one side ⇒ `[poly]` on that side, `[]` on the other. Degenerate pieces
  (< 3 vertices or area < 1e-9) are dropped. Consecutive duplicate vertices are removed.
- `clipPolygonByHalfPlane(poly, point, insideNormal)` → `Polygon2[]` (keeps
  `dot(p − point, insideNormal) ≥ 0`; built on `splitPolygonByLine`).
- `sharedBoundaryLength(a, b, lineTol = EPS)` → total length of collinear overlapping boundary
  (edge pairs whose endpoints lie within `lineTol` of each other's supporting line; overlap of
  their projections along the edge direction is summed).
- `convexHull(points)` Andrew monotone chain, CCW, collinear points removed.
- `thickenSegment(p0, p1, halfWidth, endExtension = 0)` → CCW rectangle.
- `dedupe(poly, tol)` (consecutive duplicates incl. the closing pair), `ensureCW`, `pointSegmentDistance`.
- `transformPolygon2(poly, affine: Affine2)`; `Affine2 = [a, b, c, d, e, f]` maps
  `(x, y) → (a·x + c·y + e, b·x + d·y + f)` (canvas order). Helpers `affineIdentity()`,
  `affineRotation(deg)`, `affineTranslation(tx, ty)`, `affineMirrorX()` (x → −x),
  `affineMultiply(m, n)` (apply `n` first), `affineApply(m, p)`.
- `simplifyCollinear(poly, tol)` removes vertices on the straight line between neighbours.
- `unionAdjacentPolygons(polys, tol = EPS)` → `Array<{ polygon, holes }> | null` (`merge.ts`): union of
  NON-overlapping polygons that touch along collinear boundary segments (the fragments of one
  polygon after line splits). Anti-parallel collinear edge portions of different polygons are
  removed, the remaining edge pieces are chained into loops (leftmost turn at a multi-way vertex,
  so pinch points give separate loops), CCW loops are outer boundaries and CW loops are holes
  enclosed by the union (attached to the smallest outer loop containing them). Collinear seam
  vertices are simplified away. Returns `null` when the chaining fails (overlapping input, seam
  gaps > tol) so callers can fall back. Fuzzed: 3000 random star / orthogonal polygons split by
  1–4 random lines reassemble vertex-for-vertex (scratch/fuzz-merge.ts).

### 1.5 Arcs (`arc.ts`)
- `arcToPoints(center, r, a0Deg, a1Deg, ccw, chordTol = 0.05)` → points from angle a0 to a1
  inclusive of both ends; sweep normalised to (0, 360] (a1 = a0 + 360 → full circle; a0 = a1 →
  single point). Segment count = `ceil(sweep / (2·acos(1 − chordTol/r)))`, at least 1 and at
  least 8 per full circle; step capped at 90°.
- `bulgeArcToPoints(p0, p1, bulge, chordTol = 0.05)` → DXF bulge (`tan(θ/4)`, > 0 = CCW), points
  from p0 to p1 inclusive; `bulge = 0` ⇒ `[p0, p1]`.

### 1.6 3D polygons (`polygon3.ts`)
- `transformPolygon(poly: Polygon3, m: Mat4)`.
- `polygonNormal(poly3)` Newell normal (unit; zero vector when degenerate).
- `planeBasis(normal)` → `{ e1, e2 }` right-handed with `e1 × e2 = normal`.
- `projectToXY(poly3)` drop z then `ensureCCW`.
- `clipToZ(poly3, z0, z1)` → `Polygon3[]`: clip a planar 3D polygon to the band `z0 ≤ z ≤ z1`.
  Horizontal polygons return `[poly]` or `[]`; otherwise the polygon is mapped to its plane's
  (e1,e2) coordinates, split by the lines z = z0 and z = z1 with `splitPolygonByLine`, and mapped
  back. Winding about the polygon normal is preserved (CCW).
- `bounds3(points)`.

---

## 2. `src/core/bend` — sheet-metal maths (single source of truth)

Notation: `t` thickness, `ri` inner radius, `k` k-factor, `θ` bend angle from flat, `θi = 180 − θ`
included angle, `V` die opening, `Rm` tensile strength, `L` bend length, `rs` shoulder radius.

| function | formula |
|---|---|
| `bendAllowance(angleDeg, ri, k, t)` | `rad(θ)·(ri + k·t)` |
| `outsideSetback(angleDeg, ri, t)` → `{ value, ref }` | θ ≤ 90: `tan(θ/2)·(ri + t)`, ref `'virtual-sharp'`; θ > 90: `ri + t`, ref `'tangent'` |
| `bendDeduction(angleDeg, ri, k, t)` | `2·OSSB − BA` |
| `neutralRadius(ri, k, t)` / `midRadius(ri, t)` | `ri + k·t` / `ri + t/2` |
| `airBendForce(Rm, L, t, V)` → `{ force, forcePerMeter }` | `F = 1.42·Rm·L·t²/(V·1000)` kN; `F/m = 1.42·Rm·t²/V` kN/m. Also `airBendForcePerMeter(Rm, t, V)` |
| `hemFlattenForce(Rm, t, L)` | `0.7·Rm·t·L/1000` kN |
| `ramDepth(V, t, ri, includedAngleDeg, rs = 0, vAngleDeg = 88)` | see below, clamped to `≥ −t` only |
| `punchTipY(V, t, ri, foldAngleDeg, rs = 0, vAngleDeg = 88)` | `−ramDepth(V, t, ri, 180 − foldAngle, rs, vAngle)` (= +t at 0°) |
| `actualInnerRadius(V, material, t, punchTipRadius)` | `max(0.16·V·Rm/420, punchTipRadius, minInnerRadiusFactor·t)` |
| `springback(material, riActual, t, angleDeg)` | `clamp(sb·(0.5 + 0.5·ri/t)·(θ/90), 0.3, 12)` |
| `overbend(material, riActual, t, angleDeg, angleCorrection = 0)` → `{ springback, overbendAngle, loadedIncludedAngle }` | `over = θ + sb + corr`, `loaded = 180 − over` |
| `recommendedV(t)` | `8t` (t ≤ 3), `10t` (3 < t ≤ 6), `12t` (> 6) |
| `minLeg(V, loadedIncludedDeg, rs)` | `(V/2)/sin(θi/2) + rs + 2` |
| `legCheck(outsideLength, minLeg, warnFactor = 1.15)` | `'error'` < minLeg, `'warning'` < warnFactor·minLeg, else `'ok'` |
| `toolAngleFeasible(punchTipAngle, dieVAngle, overbendAngle)` | `punch + 1 ≤ 180 − over && die + 1 ≤ 180 − over` |

**Ram depth.** Legs symmetric about Y at φ = θi/2 from vertical, outer radius `R = ri + t` centred
at `(0, ri − D)`, tip at the inner-arc apex. Sharp shoulder: the leg's outer line passes through
`(V/2, 0)`: `D = (V/2)·cot φ + ri − R/sin φ`. With a shoulder fillet the leg line is tangent to
the fillet circle (centre `(xc, −rs)`, `xc = V/2 + rs·(1 − sin β)/cos β`, `β = vAngle/2`) —
closed form of "distance from fillet centre to the leg line = rs":
`D = ri + xc·cot φ − R/sin φ − rs·(1/sin φ − 1)` (reduces to the sharp form as rs → 0; `−t` at
θi = 180 in both). Goldens (sharp): V12 t2 ri2 θi90 → 2.343; V16 t2 ri2.5 → 4.136; V50 t6 ri8
→ 13.20; V12 t1.5 ri1.5 θi45 → 8.15; `D(180) = −t`.

---

## 3. `src/core/part` — flanges, fold kinematics, poses, silhouettes

### 3.1 Bend frame (internal `frame.ts`)
For a `BendLine`: `e = normalize(p1 − p0)`, `n = perp(e)`, `s(p) = dot(p − p0, e) ∈ [0, len]`,
`d(p) = dot(p − p0, n)`. Zone = `{ |d| ≤ BA/2, 0 ≤ s ≤ len }`. A polygon is adjacent to side
`+1`/`−1` of a bend when one of its edges lies on the long-side line `d = ±BA/2` inside `[0, len]`
(overlap > 0.01 mm) — `polygonBendSides(poly, frame)` checks BOTH lines, independent of where the
polygon's centroid lies (a plate whose arms reach past a short tab bend has its centroid on the
tab's side). `regionsSideOfBend(polys, frame)` → the side with the longer contact (0 = none).
`d̂` (child direction) = `side · n`. Constants: `LINE_TOL = 1e-5` (on-line), `CHAIN_TOL = 0.01`
(adjacency / union-find), `END_TOL = 0.1` (see below).

### 3.2 `buildPartModel(flat, opts?)` → `PartModel`
`opts = { tol?: number, endTol?: number }` (shared-boundary threshold, default 0.01; end
tolerance, default 0.1 mm).
1. `BA[b] = max(0, bendAllowance(angle, ri, k, t))`; a bend with non-finite allowance or end
   points gets `NaN` / no zone and is reported with `warnings.part.bendNoMaterial` on both sides
   (the UI validates inputs; nothing is ever cut from the outline for it).
2. Bend ends strictly inside the material (outline minus holes, deeper than `endTol`) ⇒
   `warnings.part.bendEndInMaterial { bendId, end: 0|1, gap }` (the line needs a relief or must
   reach the outline; such a bend usually joins a flange to itself and is then NOT linked — the
   `bendCycle` warning is suppressed for it).
3. `pieces = [ensureCCW(outline)]`. For each bend, for every piece: split by the two slab lines
   (`s = 0`, `s = len`, direction `n`) then by the two long-side lines (`d = ±BA/2`, direction
   `e`) using `splitPolygonByLine`. Fragments whose centroid lies in the band `|d| < BA/2` with
   `s ∈ (−endTol, len + endTol)` are discarded — so a bend line that stops up to `endTol` short
   of the outline behaves exactly as if it reached it (no sliver flanges).
4. Adjacency per fragment: `polygonBendSides` for every bend.
5. Union-find: fragments sharing a boundary segment (> tol) are the same flange, EXCEPT segments
   lying on a long-side line inside its slab range (never joins across a strip). Shared segments
   only arise on the artificial split lines.
6. Regions: each union-find group is merged back with `unionAdjacentPolygons` (tol `LINE_TOL`) —
   the artificial seams disappear, so a flange is normally ONE polygon (every sample flange is;
   the tabbed plate's root is the 12-vertex plate outline minus the zone). Inner loops created by
   the merge (a bend line inside the material leaves its strip as an island) become region
   holes. Fallback when the merge fails: the raw fragments.
7. Holes: attached to the region containing all their vertices whose boundary they do not cross
   and that does not already enclose them in one of its own holes; otherwise dropped with
   `warnings.part.holeDropped` (holes crossing a bend zone). Holes are stored CW.
8. Flanges sorted by area (regions minus holes) descending, ids `F1, F2, …`; root = `F1`.
   `Flange.bendIds` = bends adjacent on either side.
9. Per bend: flanges on side −1 and +1. More than one on a side ⇒
   `warnings.part.multipleFlangesOnSide` and the largest is used; none ⇒
   `warnings.part.bendNoMaterial` and the bend is not linked.
10. BFS from the root over bend adjacency → `links`; a bend closing a cycle (or joining a flange
    to itself) ⇒ `warnings.part.bendCycle` (not linked); unreachable flanges ⇒
    `warnings.part.flangeDisconnected`.
11. `flatBounds = bounds(outline)`.
Expected sample results: flange counts L 2, U 3, Z 3, hat 5 (chain), acute 2, box 5 (centre +
4 children), tabbed plate 2 (root = plate incl. side strips, child = tab), all single-region.
`part.flat` is the input object (never mutated). Treat the PartModel as immutable data: nothing
is memoised, so a rebuilt model after edits is always consistent.

### 3.3 `foldGeometry(part, state)` → `FoldedGeometry` (constant-arc-length model)
Per link (bend `b`, parent P, child C), in FLAT coordinates then carried by `T_P`:
- `θf = max(0, state[b] ?? 0) · angle`; `BA = zoneWidth`; `d̂` toward the child;
  `S0, S1 = p0 − d̂·BA/2, p1 − d̂·BA/2` (zone start line), `w = (0,0,1)`, `σ = +1 up / −1 down`.
- `θf < 0.01°`: straight strip, child transform = identity, `axisPoint` = bend-line midpoint,
  `toCentre = +w`, `tangent = d̂`, radii `= Infinity`, `axisDir = σ·(d̂ × w)`.
- else `rn = BA/rad(θf)`, `ri_f = rn − k·t`, `rm = ri_f + t/2`; centre `C = S_mid + σ·rm·w`;
  `axisDir a = σ·(d̂ × w)` (right-hand rotation carries the child toward σ·w);
  child transform `M = R(C, a, +θf) · T(−BA·d̂)`; `T_C = T_P · M`.
- Mid-surface arc: `P(φ, λ) = C_λ + rm·(−toCentre·cos φ + tangent·sin φ)`, `φ ∈ [0, θf]`,
  `C_λ = S_λ + rm·toCentre`; inner surface radius `ri_f`, outer `ri_f + t`. The arc end at
  `φ = θf` coincides with the transformed child zone-end line (C0/C1 continuity).
- All `FoldedGeometry.bends` vectors/points are mapped through `T_P` (points via `applyToPoint`,
  directions via `applyToDir`). Tree links come first (BFS order). Bends that are NOT links but
  touch a flange (no material on one side, self-loop, cycle, the loser of a
  `multipleFlangesOnSide` pick is not repeated) are appended as straight strips
  (`currentAngle = 0` whatever the state, radii `Infinity`) carried by the largest flange that
  touches them, `tangent` pointing away from it — so the zone material is rendered and nothing
  vanishes from the mesh. Only bends touching no flange at all are omitted.
- `bounds = partBoundsFolded(folded, t)`: region vertices ± t/2·normal plus 13 samples of each
  zone's inner/outer surfaces at both axial ends (straight zones: strip corners ± t/2).
`flatState(part)` → every bend 0; `finishedState(part)` → every bend 1.
`partBoundsFolded(folded, t, transform?)` → bounds (optionally in another frame).
`derivePart(part)` → `{ flangeById, links, linkByBend, loose }` is recomputed on every call
(≈ µs); in-place edits of `part.flat.bends` are picked up, but `part.bendAllowance` / flanges are
only consistent after `buildPartModel` again.

### 3.4 `bendPose(placement, folded, bendId, fraction, punchTipY, t)` → `Mat4`
`folded` must be `foldGeometry(part, { …previous bends: 1, [bendId]: fraction })`; `θf` is read
from `folded.bends[bendId].currentAngle`. `fraction` is checked for consistency: a straight zone
with `fraction ≥ 0.01`, or a curved zone with `fraction ≤ 0`, throws (`does not match`) — it
would otherwise silently produce a wrong pose. Let `m` = the bend-line-centre material point on
the mid-surface (arc point at `φ = θf/2`, `λ = ½`; straight: `S_mid + tangent·BA/2`).
- `θf < 0.01°`: `R = identity`; else `R = rotationAxisAngle(C', a', −θf/2)` with
  `C' = placement(axisPoint)`, `a' = placement(axisDir)`.
- `apex = R·placement·m` (directly below C' at distance rm when the placement is exact);
  `pose = T(−apex.x, punchTipY − t/2 − apex.y, 0) · R · placement`.
At f = 0 the pose equals the placement (apex is at X = 0, Y = t/2 and punchTipY(0) = t).

### 3.5 `partSilhouette(folded, partToMachine, t, zBand?)` → `Array<{ polygon, zRange, source }>`
Machine-XY polygons (CCW) with their Z extent, `source = { kind: 'flange', flangeId, regionIndex }
| { kind: 'bend', bendId }`.
- Flange region (mid-surface Polygon3 mapped to MACHINE; holes ignored; clipped with `clipToZ` to
  `zBand` expanded by `ez = t/2·|n'.z|` when given): normal `n'`. If `|n'.z| < 1e-6` (plane
  contains Z — flat on the die or a standing wall along the bed): the projection is a segment along
  `u' = normalize(Z × n')`; emit `thickenSegment(min, max along u', t/2)`. Otherwise: convex hull
  of the projected top (`+t/2·n'`) and bottom (`−t/2·n'`) surfaces. `zRange` = [min z − ez,
  max z + ez] of the clipped region (a wall perpendicular to the bed has `zRange` width = t).
- Bend zone (θf ≥ 0.01°): 9 samples (8 steps) on the inner and outer surfaces at both axial
  ends. Axis ∥ Z ⇒ the exact annular sector (inner arc + reversed outer arc). Oblique axis ⇒ the
  convex hull of the samples; with a `zBand`, every sampled (φ, r) axial curve (a straight
  segment whose z is linear in λ) is clipped to the band first and the hull is taken over the
  clipped end points (tight and still conservative up to the φ sampling). `zRange` from the
  samples' Z extent, clamped to the band; no overlap ⇒ omitted. Straight zones are treated like
  a flange region (thick rectangle / hull).
Flat L-bracket on the die: three abutting rectangles (root region, straight zone strip, child
region) whose union is 96.52 × 2 at `y ∈ [t/2 − 1, t/2 + 1]`. Finished L-bracket: the standing
leg is a 2 mm wide vertical rectangle and the zone an exact quarter annulus (18 vertices).
Performance (2-CPU box): buildPartModel ≤ 0.7 ms, foldGeometry ≤ 0.1 ms, pose + silhouette
≤ 0.2 ms per call on the samples.

### 3.6 `flangeExtentFromBend(part, flangeId, bendId)` → `{ min, max }`
Signed flat distances `d̂·(p − p0)` of the flange's region vertices, with `d̂` pointing from the
bend line toward that flange (its adjacency side; centroid side when not adjacent). For the
L-bracket child: `{ min: BA/2, max: 38.26 }`. `min` is negative when the flange has material past
the bend line on the far side (tabbed-plate root: `{ min: −2, max: 118 }`). The planner's gauged
outside dimension is `max + OSSB − BA/2` per `dimensionRef`.

### 3.7 Extra exports of the part barrel
`derivePart(part)` (per-link data: `dHat`, zone start line, σ, k·t, plus `loose` strips), the
zone samplers `zonePoint(b, φ, λ, r)`, `zoneStripPoint`, `zoneSurfaceSamples(b, t, λ, steps)`,
`zoneCentrePoint(b)`, `isStraightZone(b)`, `STRAIGHT_ANGLE` (0.01°) — the sim can build the arc
mesh from `FoldedGeometry.bends` with these — and the frame helpers `bendFrame, coordS, coordD,
regionsSideOfBend, polygonBendSides`. Non-finite or negative fold fractions are treated as 0.

### 3.8 Warnings (i18n keys, `Message.params`)
`warnings.part.multipleFlangesOnSide {bendId, side, count}`, `warnings.part.bendNoMaterial
{bendId, side}`, `warnings.part.bendCycle {bendId}`, `warnings.part.bendEndInMaterial {bendId,
end (0 = p0, 1 = p1), gap (mm)}`, `warnings.part.flangeDisconnected {flangeId}`,
`warnings.part.holeDropped {index}`, `warnings.part.noOutline`.
