# recognize-3d — `src/core/import/recognize/`

Sheet-metal feature recognition on a triangle mesh (STEP with B-rep face groups, or a plain
STL / OBJ / GLB mesh) and unfolding into a `FlatPattern`, plus alignment of the recognised bends
with a DXF flat pattern. Pure TypeScript (no DOM, no three.js), synchronous. Units: mm, degrees
at the API. Types from `src/core/types.ts`; geometry from `src/core/geom`; `bendAllowance` from
`src/core/bend`; `weldMesh` from import-files. `buildPartModel` (core-geometry) is used by the
tests only.

Barrel `src/core/import/recognize/index.ts` (exact public names):

| export | signature |
|---|---|
| `recognizeSheet(mesh, opts)` | `(mesh: TriangleMesh, opts: RecognizeOptions) => RecognizedSheet` |
| `matchToDxf(rec, flat)` | `(rec: RecognizedSheet, flat: FlatPattern) => MatchResult` |
| `RecognizeOptions` | `{ materialId: string; kFactor: number; thicknessHint?: number; name?: string }` |
| `applyFlatTransform(p, t)` | maps a point of `rec.flat` into the DXF flat with a `MatchResult.transform` (`FlatTransform`) |
| stages | `buildTopology`, `groupFaces`, `buildPlanarFace`, `fitCylinder`, `fitCircle2d`, `cylinderAxisDirection`, `detectThickness`, `pairCylinders`, `kabsch2d` (+ their types) — for tests and diagnostics |

Sub-modules: `topology.ts`, `faces.ts`, `cylinders.ts`, `thickness.ts`, `bends.ts`, `unfold.ts`,
`recognize.ts`, `match.ts`, `messages.ts`.

---

## 1. Pipeline of `recognizeSheet`

All 3D data stays in the **mesh frame** (`faces`, `bends3d`, `meshToPart`); only the flat is 2D.

### 1.1 Topology (`topology.ts`)
1. `weldMesh` at 1e-3 mm (idempotent on already-welded meshes), face groups remapped; zero-area
   triangles dropped.
2. Orientation: the signed volume of the mesh is computed; a negative volume (inward normals)
   flips every triangle so that normals point out of the material.
3. Per triangle: unit normal, area, centroid (float64). `adj[3t + k]` = the triangle across edge
   `(v_k, v_{k+1})` or −1. Edges with one triangle are *open*, with more than two *non-manifold*
   (`warnings.recognize.meshNotClosed { open, nonManifold }`, info, −0.1 confidence).
4. `sliver[t] = 1` when the triangle's smallest height is < `SLIVER_HEIGHT` (0.005 mm): its float32
   normal is not trustworthy (a 1 µm-high sliver of a planar face is ~0.5° off). Slivers never vote
   in the planar / curved decision and join faces by coplanarity only (§1.2).

### 1.2 Face grouping (`faces.ts`)
**STEP (`faceGroups` present):** each group is one face; *planar* when its area-weighted mean
normal is not degenerate and every non-sliver triangle normal is within `PLANAR_TOL_DEG` of it,
*curved* otherwise. Adjacent coplanar planar faces (normals within the tolerance, plane offsets
within 0.02 mm) are merged (B-rep faces split by seams); a group made of slivers only merges by
the offset test alone.

**Mesh (no groups):** region growing over shared edges — a triangle joins the growing planar
group when its normal is within `PLANAR_TOL_DEG` of the group's running area-weighted mean
normal (largest triangles seeded first; a sliver joins the group it is reached from without
voting). Every triangle ends up in a planar group; the facets of a tessellated cylinder are thin
planar groups. All-sliver groups take no part in the curvature graph and are coplanar-merged
at the end. Then the *curvature graph*: two adjacent planar
groups whose normals differ by δ ≤ 20° (`CURVED_MAX_DEG`) are curvature-adjacent. For such an
edge, with the common axis `a = normalize(n_i × n_j)` (the shared edge direction when δ ≈ 0),
the *width* of each group is the extent of its vertices along `n × a`. The edge is a *tangent
edge* when the widths differ by more than 4× (`FACET_WIDTH_RATIO`; the wider group is a flange,
the narrower a facet), otherwise a *facet–facet* edge. Facets = groups that are the narrow side
of a tangent edge or a side of a facet–facet edge; connected components of facets over
facet–facet edges are the *curved faces*; the other groups are planar faces. A curved face whose
cylinder fit (§1.4) fails or whose angular extent is < 1.5° is dissolved back into planar faces
(then coplanar-merged).

`PLANAR_TOL_DEG = 0.2`. The ARCHITECTURE gives 1° as the planar/curved boundary; CAD planar faces
have identical normals (float noise ≈ 0.001°) while STL facets sit at least ~0.5° apart with a
tangent dihedral of half a step, so the tighter value keeps the first facet out of the flange
for tessellations down to 0.5° steps (the sample STLs have 2.8° facets and 1.4° tangent
dihedrals; verified with synthetic L-brackets at 0.5°–18° facets). Finer than that, the first
facets join the flanges and the bend angle comes out short by a step or two (0.25° facets:
89.5°, still confidence 1).

### 1.3 Planar faces
Normal = normalised area-weighted sum of triangle normals; origin = area-weighted centroid;
`offset = n·origin`; plane basis `planeBasis(n)`. Boundary edges = triangle edges whose
neighbour is in another face (or missing), directed as the triangle winds (CCW about the
outward normal); chained through an outgoing-edge map into loops (at a pinch vertex any unused
outgoing edge is taken). Collinear vertices are removed by `simplifyLoop3` (1e-3 mm, 3D), which
anchors on the last KEPT vertex and checks every dropped vertex of the run against the growing
chord, so a finely tessellated arc (a 0.5°-step hole) is thinned to chords within 1e-3 mm — the
naive "distance to the original neighbours' chord" test erases such an arc completely. The loop with the largest |area| in the plane basis is the outline (CCW about `n`), the
others are holes (CW). `area` = outline − holes.

### 1.4 Cylindrical faces (`cylinders.ts`)
- Axis direction: `n0` = normal of the largest triangle; every triangle whose normal is at least
  max(0.5°, ¼ of the largest angle from `n0`) away contributes `area · (n0 × n_i)`, sign-flipped
  to agree with the running sum; `a = normalize(Σ)`.
- Axis point + radius: vertices projected onto the plane ⟂ `a` about their centroid, algebraic
  (Kåsa) circle fit `Σ(x² + y² + Dx + Ey + F)²`; `radius` = mean vertex distance from the axis;
  `centre` = the fitted centre lifted to the middle of the axial extent. `rmsError` / `maxError`
  = radial residuals; `cylinderFitOk` requires `maxError ≤ max(0.05, 0.01·r)`.
- `inner` when the triangle normals point toward the axis (`Σ area·n·(c − p)⊥ > 0`), `outer`
  otherwise. Angular extent = 360° − the largest gap between the sorted vertex angles about the
  axis; `full` (a hole / boss — never a bend) when the extent is ≥ 350°, or ≥ 300° with the
  largest gap at most 2.5× the second largest (a coarse 24-facet hole has a 15° "gap" everywhere;
  a bend's missing arc is many steps wide). `length`, `sMin/sMax` = the axial range of the
  vertices relative to `centre`.
- Curved faces that fit no cylinder are reported once with `warnings.recognize.nonSheetFace
  { count }` (info) and ignored.

### 1.5 Thickness (`thickness.ts`)
Candidate pairs = planar faces `(i, j)` with anti-parallel normals (within 1°), face `j` lying
*behind* face `i` (`(o_j − o_i)·n_i < 0`, the material is between them — the two walls of a slot
or two flanges facing each other never qualify) and ≥ 50 % of the smaller outline's vertices
projecting inside the larger outline (tol 1e-3). Distance `|(o_j − o_i)·n_i|`, weighted by the
smaller area, binned at 0.02 mm; the best bin (±1 bin) gives `t` as the weighted mean rounded
to 1e-4. `opts.thicknessHint` picks the best bin within 10 % of the hint when one exists. No pair
at all ⇒ `t = thicknessHint ?? 0`, `warnings.recognize.thicknessUnknown` (error, −0.5; warning,
−0.3 with a hint). The faces of the winning pairs are the *sheet faces* (`sheetFaces`,
`sheetPairs`).

### 1.6 Bends (`bends.ts`)
An inner and an outer partial cylinder pair up when their axes are parallel within 1°, the axis
lines are within 0.1 mm, `|r_outer − r_inner − t| ≤ max(0.1, 0.05·t)` and their axial extents
overlap by ≥ 50 % of the shorter one (two tabs bent along one line are coaxial but do not
overlap); the best `dr + axisDist + (1 − overlap)` wins, one-to-one. Each cylinder's *flanges*
= planar faces sharing boundary edges with it whose normal is ⟂ the axis (within 10°) and equal
to the cylinder normal at the shared edge within 3° (tangent); exactly two per cylinder, else the
pair is dropped and counted in `warnings.recognize.bendFlangesMissing { count }` (−0.2 each).
*Roundings* are not bends and are ignored silently: a convex cylinder with `r < t − tol` (an edge
fillet along a cut edge — a bend's outer radius is `ri + t`), and a cylinder whose axis is parallel
(10°) to an adjacent planar face's normal that either touches no tangent flange or is no longer
than 1.2·t along its axis (corner roundings of the outline). The remaining unpaired partial
cylinders ⇒ `warnings.recognize.unpairedCylinder { faceId, radius }` (−0.2 each). Bend angle =
angular extent of the inner cylinder; `innerRadius` = its radius; `length` along the axis;
`axisPoint` = the inner fit's centre; `axisDir` = its axis, oriented in `bends3d` so that a
right-hand rotation by `+angle` about it folds `faceB` out of `faceA`'s plane into place (the
`FoldedGeometry` convention).

### 1.7 Reference side, directions and tree (`unfold.ts`)
The faces of a bend's inner cylinder lie on one side of the sheet, those of its outer cylinder
on the other. Starting from a root face (side `ref`) the sides propagate over every bend (BFS);
faces never reached have no side. The tree is a BFS from the root over the bends whose
reference-side flange pair is known; a bend joining two faces already in the tree closes a cycle
(`warnings.recognize.bendCycle { bendId }`, −0.2, skipped). Direction = `'up'` when the parent's
reference face is a flange of the *inner* cylinder (the centre of curvature is on its +normal
side), `'down'` otherwise.

Root = the largest planar face. The two sides of the largest flange always tie in area, so every
face within 1 % of the largest area is tried: the side whose tree reaches the most bends wins,
then the side with the most `'up'` bends, then the greatest canonical flat signature
(`p0.x:p0.y:direction` per bend, §1.8) — so the choice depends only on the geometry, never on
the mesh's face order (a rigidly moved mesh gives the same flat). Reference-side flanges get ids
`F1, F2, …` in tree order (`F1` = root); `bends3d[i].faceA` = parent, `faceB` = child.

Sheet faces (§1.5) that neither got a side nor are the back of a face that did are material the
flat misses: `warnings.recognize.facesIgnored { count }` (−0.2). An empty bend tree ⇒
`warnings.recognize.noBends` (info; a flat plate — with or without holes / roundings — has
confidence 1).

### 1.8 Unfold (`unfold.ts`)
Root plane frame: `+w = n_root` (outward normal of the reference side), `e1` = direction of the
root outline's longest edge, `e2 = n × e1`. For a tree bend (parent P, child C) with the
reference-side cylinder (centre `c`, axis `a`, radius `r` = inner radius for `'up'`, `ri + t` for
`'down'`, sign `s = −1` inner / `+1` outer):
- tangent line on P: `q(s') = c + s'·a + s·r·n_P` for `s' ∈ [sMin, sMax]`, projected onto P's
  plane; `d̂` = unit direction in P ⟂ `a` from P's material toward the tangent line (from the
  P-triangle at a shared edge with the cylinder);
- child transform (mesh → mesh): `U_C = U_P · T(BA·d̂) · R(c, a, ±θ)` with the sign that maps
  `n_C` onto `n_P`; `BA = bendAllowance(round2(θ), round3(ri), k, t)` (the rounded values that
  the BendLine carries — angle at 0.01°, radius at 0.001 mm — so `buildPartModel` computes the
  same zone); `U_root = I`;
- 2D: `(u, v) = ((U p − o_root)·e1, (U p − o_root)·e2)`; bend line = `[Q0, Q1] + BA/2·D` (the
  mid-line of the zone rectangle `[Q0, Q1] × [0, BA·D]`).

**Regularisation.** The fitted structure is accurate (~1e-6); mesh vertices carry ~1e-5 noise
(float32; ±0.005 for an STL quantised to 0.01 mm) that would leave sliver flanges in
`buildPartModel` (its line splits use a 1e-6 tolerance). So, with `STRUCT_TOL = 0.01` (no two
distinct structure lines of a sheet-metal part are that close): (1) bend directions within 0.02°
of parallel / perpendicular are aligned exactly (each line rotated about its midpoint); (2) bend
ends are moved *along* their line onto other bends' structure lines (zone boundaries first, slab
lines second) that pass within `STRUCT_TOL`; (3) every flange vertex within `STRUCT_TOL` of a
structure line (slab lines through the ends ⟂ the bend, zone boundaries at ±BA/2) is projected
onto it — onto the intersection when two cross there (only when that corner is within 3× the
tolerance, never a far intersection of nearly parallel lines). Pieces = root outline, zone rectangles and child outlines (CCW);
`unionAdjacentPolygons(pieces, tol)` chains the unshared edges (the parent's and child's zone
edges disappear against the rectangle) into the outline; islands become holes; face holes are
transformed the same way (CW). The union runs at `SEAM_TOL = 1e-4` first (the seams are
vertex-exact after snapping) and falls back to `CHAIN_TOL = 0.01` only when it fails: geom's
union cleans collinear vertices at its tolerance with the naive neighbour test, which at 0.01 mm
erases any outline arc whose two-chord sagitta is below 0.01 mm — corner and all (a plate with
an R20 corner at 0.5° steps came back as a triangle). The pieces never overlap, so the union's
area must equal their sum: a region short by more than 0.1 % means the union erased outline
vertices and is reported as `warnings.recognize.outlineFailed` (−0.4) rather than passed off as
a clean flat. Outline and holes are then thinned by `simplifyCollinearSafe` (1e-3, same anchored
rule as `simplifyLoop3`). Chaining failure or several regions ⇒ `warnings.recognize.outlineFailed`
(−0.4) and the largest region (or the root outline) is used. Face pieces penetrating each other by > 0.05 mm ⇒
`warnings.recognize.flangeOverlap { faceA, faceB }` (−0.3).

**Canonical frame.** A rotation by a multiple of 90° makes the flat landscape (w ≥ h) and
resolves the 180° ambiguity: the outline centroid relative to the root piece's centroid, else
the `'up'` bend midpoints, else all bend midpoints must lie toward +y (then +x); fully symmetric
flats are unaffected. Then the flat is shifted so its bounds start at (0, 0), bends are numbered
`B1, B2, …` by their midpoint (x, then y, 0.01 mm) and oriented `p0 → p1` along +x (else +y).
`bends3d` follows the same order. `FlatPattern`: `id = name = opts.name ?? mesh.name`,
`thickness`, `materialId`, outline CCW, holes CW, bends (`angle` rounded to 0.01°, `innerRadius`
to 1e-3 mm, `kFactor = opts.kFactor`, `direction`, sources all `'step'` when the mesh had
faceGroups else `'mesh'`; bends of ≥ 179.5° are hems: `hem = 'open'` with `hemGap = 2·ri` when
that gap is ≥ t/4, else `hem = 'closed'`, `hemGap = 0`), `sourceUnits: 'mm'`, `provenance { file,
format: 'step' | 'mesh', faces, cylinders }`, `warnings` = the same array as `issues`.

`meshToPart` = the rigid transform mesh → PART frame: rows `e1, e2, n_root`, translation
`(−e1·o + shift.x, −e2·o + shift.y, −n·o + t/2)` — the root's reference face sits at `z = +t/2`
because the PART frame's root mid-surface is `z = 0`. Verified in the tests: mesh vertices mapped
through `meshToPart` have the bounds of `partBoundsFolded(foldGeometry(buildPartModel(flat),
finishedState))` within 0.1 mm for every sample, both formats, moved or not.

### 1.9 Confidence
1.0 minus the penalties above, clamped to [0, 1], rounded to 0.01. Every sample (STEP and STL)
scores 1.0 with no warning-severity issue.

---

## 2. `matchToDxf(rec, flat): MatchResult` (`match.ts`)
Aligns `rec.flat.bends` with `flat.bends` (a DXF flat of the same part) by a 2D rigid motion,
optionally with a reflection, and copies the recognised attributes onto the DXF bends.
- **Hypotheses** (both reflections; the rec coordinates are mirrored `x → −x` first): k = 1 →
  the rotation from the line directions (both orientations) + midpoints; k ≤ 4 → 2D Kabsch
  (`φ = atan2(Σ a'×b', Σ a'·b')` about the centroids) over every injective assignment of the
  smaller bend set into the larger; always in addition: two-correspondence samples (exhaustive
  up to 20 000, deterministic random beyond) whose inter-midpoint distances agree within 20 mm —
  immune to midpoints shifted along their line (lines drawn across reliefs) and to extra /
  missing bends.
- **Pair rule** after mapping a rec line: directions parallel within 2°, both end points within
  1 mm of the DXF line, projected overlap ≥ 50 % of the shorter line; pairs are assigned greedily
  1-1 by increasing distance. Each hypothesis is refined by three Gauss–Newton steps on
  `(φ, tx, ty)` minimising the perpendicular distances of the matched end points (damped, so
  all-parallel bend sets stay put along the lines), then re-scored.
- **Choice**: most pairs, then summed distance (ties within 0.05 mm), then the smallest outline
  mismatch (mean distance of the mapped rec outline vertices to the DXF outline plus the mean
  hole-centroid distance — this decides the mirror question for asymmetric parts), then the
  most agreements with the DXF's own direction labels (decides it for symmetric parts), then the
  proper rotation.
- **Result.** `flat` = a copy of the DXF flat (new bend objects) where every matched bend gets
  `angle`, `innerRadius`, `direction` (inverted when mirrored), `hem` and `hemGap` from the
  recognised bend with `sources.angle/radius/direction = 'step' | 'mesh'`; geometry (`p0/p1`, `sources.geometry`)
  and `kFactor` stay from the DXF. `pairs`, `unmatchedDxf`, `unmatchedRec`, `mirrored`,
  `transform = { rotationDeg, translation, mirrored }` mapping rec → DXF as
  `p' = R(rotationDeg)·(mirrored ? (−x, y) : (x, y)) + translation` (`applyFlatTransform`).
  Warnings (also appended to `flat.warnings`): `warnings.recognize.bendCountMismatch { dxf, rec }`,
  `warnings.recognize.unmatchedDxfBend { bendId }`, `warnings.recognize.unmatchedRecBend
  { bendId }`, `warnings.recognize.matchMirrored` (info), `warnings.recognize.noBendsToMatch`
  (info). 12 × 12 bends match in ≈ 35 ms.

---

## 3. Tests — `npx vitest run src/core/import/recognize` (5 files, 95 tests, ≈ 5 s)
- `recognize.test.ts`: every sample on `.step` and `.stl` — thickness within 0.05 mm, bendCount,
  angles within 0.5°, radii within 0.1 mm, `flatsEquivalent(rec.flat, truth.flat)` (tol 0.5, not
  mirrored), hole counts, sources, `matchToDxf(rec, truth.flat)` pairs every bend with nothing
  unmatched and the copied attributes equal the truth, `buildPartModel(rec.flat)` has no
  warnings and `meshToPart` maps the mesh onto the folded model (bounds within 0.1 mm, det 1,
  root face at z = t/2). The same for every mesh moved by an arbitrary rotation + translation
  (identical flat within 0.02 mm, axes moved with the mesh). Options, timing (< 150 ms).
- `stages.test.ts`: topology (counts, inward meshes flipped, open edges), grouping (STEP 8 + 3,
  STL the same), planar face outline / hole / winding, cylinder fits (r 2 / 4 / 5, 90°, hole
  full), circle fit, thickness (2.0, sheet faces, hint), pairing (flanges, partners), synthetic
  meshes (flat plate, plate on edge, tetrahedron, open mesh, empty mesh) and synthetic STL-like
  L-brackets at 0.5°–18° facets (exact) and 0.25° (graceful).
- `match.test.ts`: Kabsch, identity, rotated + translated, mirrored asymmetric (tabbed plate)
  and symmetric (U-channel) DXFs, lines drawn across reliefs, extra / missing bends, six bends
  (RANSAC path, shuffled ids, an extra line), no bends, a single bend, tolerance boundaries.
- `synthetic.ts` (test-only, not in the barrel) builds a closed folded triangle mesh of ANY
  FlatPattern through `foldGeometry` (flange prisms + tessellated zones sharing the tangent-line
  vertices; soup or one face group per face). `synthetic.test.ts` round-trips every sample truth
  flat (soup + groups) and parts the samples lack: a corner tab bent up / down off a standing wall
  (perpendicular second-level axis), two coaxial tabs up, three walls up + two coaxial tabs down,
  30/60/120/150/170° bends with mixed directions and radii, shallow 10° / 15° bends (a one-facet 5°
  bend is lost with `facesIgnored`), open hems ri 2 / 1 / 0.5 (+ `hem`/`hemGap`, copied by
  `matchToDxf`), hem + 90° down, `bends3d.axisDir` orientation, holes on both flanges incl. a
  coarse 15°-step hole and a square, 360 / 720-segment holes, an R20 corner at 0.5° steps, facet
  steps 15° … 0.5° (22.5° is beyond the curved band → `facesIgnored`), coordinates quantised to
  0.001 / 0.01 mm, inward normals, a 10 m offset, R10 with a 6 mm leg, t = 6 / 500 wide, t = 0.5 /
  10 wide, a U with long legs, a square flat, a two-body mesh.
- `review.test.ts`: a sliver triangle (1 µm high, normal 0.57° off) in a planar face on both paths,
  `simplifyLoop3` / `simplifyCollinearSafe` bounds, 12 / 24 / 72-facet tubes are `full` and a 270°
  curl is not, an R0.5 edge fillet along a cut edge, `kabsch2d([], [])`, an inch-sourced DXF flat,
  reversed and zero-length DXF lines.

## 4. i18n keys (ui adds en/th)
`warnings.recognize.meshNotClosed { open, nonManifold }` (info), `warnings.recognize.noPlanarFaces`
(error), `warnings.recognize.thicknessUnknown` (error; warning with a hint),
`warnings.recognize.nonSheetFace { count }` (info), `warnings.recognize.unpairedCylinder
{ faceId, radius }`, `warnings.recognize.bendFlangesMissing { count }`,
`warnings.recognize.bendCycle { bendId }`, `warnings.recognize.facesIgnored { count }`,
`warnings.recognize.flangeOverlap { faceA, faceB }`, `warnings.recognize.outlineFailed`,
`warnings.recognize.noBends` (info), `warnings.recognize.bendCountMismatch { dxf, rec }`,
`warnings.recognize.unmatchedDxfBend { bendId }`, `warnings.recognize.unmatchedRecBend { bendId }`,
`warnings.recognize.matchMirrored` (info), `warnings.recognize.noBendsToMatch` (info).

## 5. Notes for other modules
- ui: `recognizeSheet(result.mesh, { materialId, kFactor, thicknessHint, name })` is synchronous
  (≈ 5–50 ms on the samples); show `rec.issues`, `rec.confidence`, and offer `matchToDxf` when a
  DXF flat is loaded too (badge the copied attributes by `sources`). `rec.flat` feeds
  `buildPartModel` directly.
- sim: `meshToPart` lets the imported mesh be drawn over the folded part model
  (`mesh → PART`, then the placement transforms).
- core-geometry: `buildPartModel` splits with a 1e-6 tolerance, so flats must be vertex-exact
  along the bend structure lines (this module guarantees it through §1.8 regularisation). A
  tolerant split (dropping fragments thinner than ~1e-4 mm) would make it robust to any
  recognised / hand-edited flat. `simplifyCollinear` (and `unionAdjacentPolygons`, which calls it
  at the chaining tolerance) tests each vertex against its ORIGINAL neighbours, so every vertex of
  an arc finer than the tolerance is dropped in one pass; this module keeps its own anchored
  simplifiers and unions at 1e-4 (§1.3, §1.8). Safe for `buildPartModel` itself as long as flats
  honour the ≤ 0.05 mm chord rule of the contract (its union tolerance is 1e-5).
