# Press Brake Simulator — Architecture

A browser app for shop-floor staff to import a sheet-metal part (3D STEP/mesh and/or a 2D DXF
flat pattern), pick tooling and machine, let the planner design the bend program (sequence,
tools, backgauge, ram depth, tonnage, collision checks) and watch a 3D simulation of the folding.

Stack: Vite + React 19 + TypeScript (strict) + three.js (+ @react-three/fiber, drei) + zustand.
Tests: vitest (core is pure TS, no DOM). Bilingual UI: English / Thai (Sarabun font).
Deployment: Node/Express serving `dist/` + a tiny JSON API for the shared tool library, in Docker.

`src/core/types.ts` is the contract. Read it first. Every module builds against it.

## Module map & file ownership

| Module | Owns (only writes here) | Depends on |
|---|---|---|
| `core-geometry` | `src/core/geom/**`, `src/core/bend/**`, `src/core/part/**` | types, testing |
| `import-files` | `src/core/import/**` except `recognize/` (incl. `*.worker.ts`) | types, geom |
| `recognize-3d` | `src/core/import/recognize/**` | types, geom, bend, part, import |
| `tooling-machine` | `src/core/tools/**`, `src/core/machine/**`, `src/core/library/**` | types, geom, bend (`recommendedV`) |
| `planner` | `src/core/planner/**` | types, geom, bend, part, tools, machine |
| `sim-3d` | `src/sim/**` | types, part, planner (timeline), tools, machine |
| `ui` | `src/app/**`, `src/i18n/**`, `src/index.css` | everything above |
| integrator | `src/main.tsx`, `src/core/index.ts`, `src/core/testing/**`, `public/**`, `index.html`, `e2e/**`, `playwright.config.ts`, `server/**`, `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `package.json`, `vite.config.ts`, `tsconfig*.json`, `README.md` | — |

Tests live next to the code as `*.test.ts` (vitest). Fixtures in `samples/` (shared, read-only)
loaded through `src/core/testing/fixtures.ts` (`loadTruth(name)` → `{ flat: FlatPattern, expected }`,
`flatsEquivalent(a, b, tol)`). Every module exports a barrel `index.ts`. **Do not add npm
dependencies** — everything needed is installed (three, @react-three/fiber, @react-three/drei,
occt-import-js, dxf-parser, zustand, express, vitest, jsdom, @playwright/test, tsx).

Commands: `npm run test` (vitest run), `npm run typecheck` (tsc -b), `npm run build`, `npm run dev`.

## Coordinate frames

See the header of `src/core/types.ts`. Summary:

- FLAT (u,v): DXF plane; +w = sheet top normal. 'up' bends fold toward +w.
- PART (x,y,z): root flange in z=0 plane, u→x, v→y, w→z.
- MACHINE: origin at die V centre on the shoulder plane at the left end of the bed;
  +X to the back (backgauge), +Y up, +Z left→right along the bed. Bend line ∥ Z.
- Backgauge R = Y of the finger profile origin (bottom of the stop face). R = 0 ⇒ stop face spans
  y ∈ [0, stopHeight]. Flat-edge gauging uses R ≈ −(stopHeight − t)/2 (edge hits mid-face);
  flange-face gauging uses R ≈ ri + t + 2 (above the outer radius).
- Tool profiles: 2D CCW polygons in the machine XY plane, extruded along Z. Punch y ∈ [0, h],
  die y ∈ [−h, 0], finger y ∈ [0, h] with the stop face on x = 0.

## Sheet-metal maths (single source of truth: `src/core/bend/`)

Notation: t thickness, ri inner radius, k k-factor, θ bend angle from flat (deg), V die opening
at the shoulder plane, θi = 180 − θ = included angle between the legs, Rm tensile strength (MPa),
L bend length (mm), rs die shoulder radius, β = vAngle/2.

- Bend allowance: `BA = (π/180)·θ·(ri + k·t)`.
- Outside setback: `OSSB = tan(θ/2)·(ri + t)` for θ ≤ 90 (dimension to the virtual sharp,
  `dimensionRef = 'virtual-sharp'`); for θ > 90 use `ri + t` and `dimensionRef = 'tangent'`.
  Every BendStep states which convention its outside dimension uses.
- Bend deduction: `BD = 2·OSSB − BA`.
- Neutral radius `rn = ri + k·t`, mid-surface radius `rm = ri + t/2`.
- Air-bend force (kN): `F = 1.42·Rm·L·t² / (V·1000)`. Per metre: `F/m = 1.42·Rm·t² / V` kN/m.
  Check against punch/die `maxLoadPerMeter` (report `loadPercentOfTool`) and machine `capacity`.
- Hem flattening force (kind 'hem-flatten'): `F ≈ 0.7·Rm·t·L / 1000` kN (≈ 60 t/m at 2 mm mild
  steel) — checked against the hemming tools' ratings, never the air-bend formula.
- Actual air-bend inner radius (what forms, regardless of the drawing):
  `actualInnerRadius = max(0.16·V·Rm/420, punch.tipRadius, material.minInnerRadiusFactor·t)`.
  Used for ram depth, springback and the simulated arc. Warn `warnings.bend.radiusMismatch`
  when |actual − drawing| > max(0.25·t, 20 %), reporting the flange error ΔBA/2 per leg.
- Ram depth (punch tip below the die shoulder plane), sharp-shoulder closed form with legs
  symmetric about Y at θi/2 from vertical, outer radius R = ri + t tangent to both legs, tip at
  the inner-arc apex: `D = (V/2)·cot(θi/2) + ri − (ri + t)/sin(θi/2)`.
  With a shoulder fillet rs the contact moves to the fillet: replace `V/2` by
  `V/2 + rs·(1 − sin β)/cos β − rs·cos(θi/2)·…` — implement as: the outer leg line is tangent to
  the fillet circle (centre `(V/2 + rs·(1 − sin β)/cos β, −rs)`, radius rs); solve D so the leg
  line (direction at θi/2 from vertical, tangent to the outer arc of radius ri + t centred at
  (0, ri − D)) is at distance rs from the fillet centre. Sanity (sharp): V12 t2 ri2 θi 90 → 2.343;
  V16 t2 ri2.5 → 4.136; V50 t6 ri8 → 13.20; V12 t1.5 ri1.5 θi 45 → 8.15. `D(θi = 180) = −t`
  (tip on the sheet top at the pinch point) — D is legitimately NEGATIVE for the first ~40° of
  fold and for shallow finished bends. Clamp only to `D ≥ −t`. `ramDepth` in BendStep includes
  `machine.yCorrection`; ramY(clamp bottom) = punch.height − D. The fillet contact needs the die
  V half-angle β, so the signature is `ramDepth(V, t, ri, includedDeg, rs = 0, vAngleDeg = 88)`
  (same trailing parameter for `punchTipY`): callers with 85° / 30° dies pass `die.vAngle`.
- Springback: `sb = material.springbackDeg · (0.5 + 0.5·(ri_actual/t)) · (θ/90)` clamped to
  [0.3°, 12°]; `overbendAngle = θ + sb + (bend.angleCorrection ?? 0)`. Ram depth is computed for
  the overbend angle (`loadedIncludedAngle = 180 − overbendAngle`).
- Tool angle feasibility (hard constraint, the physical fit): `punch.tipAngle ≤ 180 − overbendAngle`
  and `die.vAngle ≤ 180 − overbendAngle`; a station failing it gets `warnings.tool.angle` (error)
  and if no mounted station passes the program is infeasible (e.g. the acute bracket or stainless
  304 on 88° tools). The 1° margin is reported, not enforced: `bottoming = true` +
  `warnings.tool.bottoming` (info, small cost) when `180 − overbendAngle ≤ die.vAngle + 1` — every
  standard 90° bend in mild steel on 88° tools (loaded 88.29°) is such a case; 85° tools avoid it.
  (`toolAngleFeasible` in `src/core/bend` still implements the strict +1° test for callers that
  want it.)
- Minimum leg (both legs, outside dimension to the virtual sharp): the leg edge must stay on the
  shoulder until the loaded angle: `Lmin = (V/2)/sin(θi_loaded/2) + rs + 2`. Error below Lmin
  (the bend is infeasible on that station — mount a narrower V), warning below
  `minFlangeWarnFactor·Lmin` (default 1.15). Evaluate at the finger/leg Z positions.
- V selection: prefer the mounted die with V closest to `8·t` (t ≤ 3), `10·t` (3–6), `12·t`
  (> 6) among the dies passing the angle constraint; acute bends need the acute (30°) dies.
- Hems (angle = 180): the planner expands a hem into `preBend` (acute station, 150° from flat) +
  `hem-flatten` (hemming station); no hemming station ⇒ warning + infeasible.

## Fold kinematics (core-geometry, `src/core/part/`)

`buildPartModel(flat)` splits the flat outline by the bend zones into flanges and builds the
tree (root = largest-area flange). Each bend line is the zone centre; zone half-width = BA/2 and
the zone is limited to the bend line's extent along the line (a "slab"). Splitting uses only
line splits of polygons (no general booleans): for each bend, split every piece by the two slab
boundary lines and the two strip long-side lines; discard fragments inside the strip; then
union-find the remaining fragments that share a boundary segment lying on a slab-boundary line.
Each set is a flange (possibly several polygons → `Flange.regions`). A bend joins the flanges
adjacent to its two long sides.

`foldGeometry(part, foldState)` returns `FoldedGeometry` with the parent flange fixed and the
child subtree carried by the arc — the **constant-arc-length model**. For a bend at fraction f,
θf = f·θ (f may exceed 1 during overbend):
- θf < 0.01° → the zone is a straight strip of width BA; child transform = identity.
- otherwise the zone's flat width BA is wrapped onto an arc: neutral radius `rn = BA / rad(θf)`
  (so rn = ri + k·t at f = 1), inner radius `ri_f = rn − k·t`, mid radius `rm = ri_f + t/2`.
  The arc centre C lies at distance rm from the mid-surface at the zone START line S (the parent
  side, at −BA/2 from the bend line along the child direction d̂), on the +w side for 'up' and −w
  for 'down' (w = the parent's current sheet normal). The zone's material is rendered from radius
  ri_f to ri_f + t around C; the mid-surface arc is C0/C1 continuous with both flanges.
- child transform = `R_C(+θf about axisDir) ∘ T(−BA·d̂)`: translate the child by −BA along d̂
  (closing the zone gap) then rotate about the axis through C; `axisDir` is chosen so the
  right-hand rotation carries the child toward the centre side. As θf → 0 this tends to identity.

`bendPose(placement: Mat4, folded, bendId, fraction, punchTipY, thickness): Mat4` (core-geometry,
used by BOTH the planner's sweep and the timeline — the sim never composes poses): both legs rise
symmetrically. Pose = `T(+BA/2 along machine X, ΔY, 0) ∘ R_C'(−θf/2) ∘ placement` where C' is the
current arc axis mapped through the placement and ΔY puts the mid-surface apex
(Y(C') − rm after the rotation) at `punchTipY − t/2`. The bend-line-centre material point then
stays at X = 0 for every f, and at f = 0 the pose equals the placement. `punchTipY(f) = −D(θi =
180 − θf)` = +t at f = 0.

## Bend-sequence planner (`src/core/planner/`)

1. **Stations**: the user's `ToolSetup` lists mounted punch/die stations with segments. Per bend
   the planner picks a station: angle-feasible (above), V preference, station Z length ≥ bend
   length − 2·(ri + t) (else `warnings.tool.tooShort`), and a **Z-clearance** check: the usable
   punch length is the Z distance between the nearest features standing above the die plane on
   each side of the bend line (from the folded geometry) — box bends 3/4 need a punch that fits
   between the two standing walls. `punchLength` = the station length actually used; `segments`
   from the station; `partZOffset` centres the bend line in the station unless clearance forces
   an offset.
2. **Placements**: exactly 2 candidates per bend and station — gauged side ∈ {parent, child}.
   The orientation about the bend axis is forced: concave side up (see `Placement` in types).
   `flipped` is derived (root +w → −Y). `manipulation.turn` between consecutive steps is derived
   from the relative rigid motion of the two placement transforms: 'none' (translation only),
   'rotate180' (180° about machine Y), 'flip-front-back' (180° about Z), 'flip-end-for-end'
   (180° about X). Cost: flips are minimised by grouping up- and down-bends in the order.
3. **Collision model**: the folded part is sliced by Z at every feature boundary (flange edges,
   standing walls, finger Z ± width/2, station ends, frame positions); each Z-slice is projected
   onto XY (flange mid-surface regions thickened by t; arc zones sampled with 8 points per
   surface; legs parallel to Z as thick rectangles; oblique regions as the convex hull of their
   projection — conservative) and intersected only with the obstacles active in that slice:
   punch (at ramY, per station), ram clamp (asymmetric, `clampFrontOffset`), ram beam, die,
   holder, table, fingers (only at their Z), backgauge beam, side frames (half-space
   X ≥ throatDepth for Z outside [frameLeft, frameRight], frames centred on the bed). Report a
   collision only when penetration depth > 0.2 mm, and EXCLUDE the intended contacts: the punch
   tip zone (|x| ≤ V/2, y ≥ punchTipY − 0.5), the die shoulder zones and the finger stop face at
   the gauge position. Sweep f ∈ [0, 1] in `sweepStepDeg` steps (default 5°); punch tip at
   punchTipY(f), ramY = punchTipY + punch.height; first contact per obstacle kind →
   `CollisionReport`. Finger contact during the bend is a 'warning' that suggests
   `backgauge.retractAtPinch` (when > 0, fingers move +X after the pinch in the timeline and the
   sweep uses the retracted position).
4. **Backgauge** (from the FOLDED silhouette, never the flat): for each finger Z (2 fingers at
   1/4 and 3/4 of the gauged edge's Z extent, 1 if shorter than 2×finger width; independent X/R
   per machine flags), the contact = max X of the part silhouette in that finger's Z band within
   the stop-face band y ∈ [R, R + stopHeight]; classify `gaugeContact`: 'cut-edge' (sheet edge),
   'flange-face' (outer face of a standing flange), 'radius' (an arc → warning), 'none' (change R
   or reject). R from the contact band (flat edge: −(stopHeight − t)/2 rounded; flange face:
   ri + t + 2). X within [xMin, xMax] else `warnings.gauge.outOfRange`. Reject finger Z positions
   where the contact across the finger width is not straight/continuous (holes, notches,
   reliefs → move the finger; none possible → warning). If the two fingers need different X and
   `independentX` is false → gauge with one finger + warning. The finger polygon at (X, R) and the
   beam must not intersect the silhouette; check the finger body against die/holder when
   X < die.bodyWidth/2. `gaugedFlangeOutside` = the outside dimension (flat distance + OSSB −
   BA/2 convention per `dimensionRef`).
5. **Search**: memoise `evaluate(bendId, doneSetMask, gaugedSide, stationId) → { placement,
   collisions, backgauge, cost }` (order-independent); the order search sums cached step costs
   plus pairwise manipulation costs. Exhaustive for ≤ 7 bends with pruning (hard 'error'
   collision or force > capacity ⇒ prune); beam search (width 40) above. Cost = Σ weights·(flip,
   rotate, stationChange, shortFlange, collisionWarning) with tie-breakers: shorter legs first,
   outer bends before inner (leaf → root), keep standing flanges pointing away from the die.
   `fixedOrder` skips the order search. `planProgram` accepts an optional `AbortSignal` and a
   progress callback and must finish < 2 s for the box on a 2-CPU machine.
6. **Program assembly**: every BendStep field in types.ts (included angles, actual radius, ram
   depth/pinchY/ramUpperLimit = part insertion height + 20 mm ≤ TDC, force and % of tool,
   punchLength/segments/partZOffset (the punch piece is centred in the station, the part placed
   relative to station.zStart), per-finger backgauge, gaugeContact, outside dimension +
   BD + dimensionRef (`gaugedFlangeOutside` = the caliper check dimension from this bend's virtual
   sharp/tangent to the gauged edge or face), orientation words, manipulation, bottoming,
   collisions, warnings).
   `feasible` = no 'error' collisions, all forces ≤ capacity and tool ratings, angle-feasible,
   every leg ≥ Lmin, hems have a hemming station.
7. **Timeline**: `buildTimeline(program, part, material, machine, library): SimKeyframe[]` —
   phases per step: position (part lerps in from a parked pose 300 mm in front and above),
   gauge (fingers to X/R/Z, part slides +X to touch), approach (ramY TDC/upper limit → pinchY),
   bend (f 0→overbend/θ via bendPose; ramY follows punchTipY; fingers retract if configured),
   release (springback: f relaxes to 1 while ramY rises 5 mm), retract (ramY → ramUpperLimit),
   reposition (only when `turn` ≠ 'none' — rotate about the part centre per `turn`, ~1.5 s).
   `timeS` from travel ÷ machine speeds; `pose` = decomposed `partTransform`; ≥ 24 keyframes per
   phase; each keyframe carries the collisions active at that instant.

## Importers (`src/core/import/`)

- **DXF flat pattern** (`dxf-parser`): units from `$INSUNITS` (1 = in, 4 = mm, 0/absent = mm
  unless bounds suggest inches). Entities: LINE, LWPOLYLINE (bulge arcs), POLYLINE, ARC, CIRCLE,
  SPLINE (flatten), INSERT (blocks). Layer mapping (case-insensitive, prefix match):
  bend up: `IV_BEND`, `BEND`, `BEND_UP`, `BENDLINE`, `BEND_LINES`; bend down: `IV_BEND_DOWN`,
  `BEND_DOWN`, `BENDDOWN`; ignore: `IV_ARC_CENTERS`, `IV_TANGENT`, `IV_FEATURE_PROFILES`,
  `IV_ALTREP*`, `DIMENSION*`, `TEXT`. Outline = the largest closed loop assembled from the
  remaining geometry (chain segments with 0.01 mm tolerance); other closed loops = holes.
  Bend lines: each LINE on a bend layer; angle default 90° (`sources.angle = 'default'`,
  geometry/direction 'dxf'); ri default = actual air-bend radius rule for the material (unknown V
  ⇒ 8·t). A `BendLine` whose ends don't reach the outline is trimmed/extended to it. Bend angle
  text (e.g. "UP 90.00° R 1.00") on the same layer, when present, sets angle/ri ('dxf').
- **DXF tool profile**: the single closed loop → points; user picks orientation in the UI
  (`normalizeProfile` in `src/core/tools/custom.ts`).
- **Meshes**: STL (binary+ASCII), OBJ, GLB/GLTF → `TriangleMesh` (mm). Vertices welded at
  1e-3 mm so the recognizer gets shared edges.
- **STEP** (occt-import-js): `importStep(buffer)` runs occt in a module Web Worker in the browser
  (`src/core/import/step.worker.ts`, `new Worker(new URL('./step.worker.ts', import.meta.url),
  { type: 'module' })`, transferring positions/indices) and calls occt directly in Node (tests)
  via `loadOcct()`. Merge all meshes; `faceGroups` = brep_faces as TRIANGLE index ranges offset by
  prior triangle counts. Params: `OCCT_PARAMS` in occt-loader.ts.

## 3D sheet recognition (`src/core/import/recognize/`)

Input `TriangleMesh` (mm, weld first). Steps: (1) group triangles into faces — by `faceGroups`
when present, else by normal continuity over shared edges (planar: dihedral ≤ 1°; curved:
1°–20°, matched to STL facets of ~5.7°). (2) Planar faces: fit plane, outline via boundary edges
(edges with a single triangle inside the group) chained into loops; largest loop = outline,
others holes. (3) Thickness t = the most common distance between anti-parallel planar face pairs
that overlap in projection. (4) Cylindrical faces: axis ⟂ to all normals (average of cross
products of well-separated normals), radius by least squares; pair inner/outer (same axis, radii
r and r+t) → bend, angle from the angular extent of the inner cylinder; the two planar faces
sharing boundary edges with the pair are the flanges. (5) Reference side = the face set
containing the largest planar face; bend direction 'up' when the centre of curvature is on the
+normal side of the parent face (propagated per flange). (6) Unfold: root = largest face; BFS;
each child face outline rotated into the parent's plane about the bend axis and offset by BA
(k-factor from options); outline = boundary of the union assembled by chaining unshared edges
(the two zone edges are matched and removed); keep holes. Produce `FlatPattern` with `BendLine`s
(sources 'step' when faceGroups exist, else 'mesh'), and `meshToPart`. Confidence 1.0 when all
cylinders paired and the unfolded flanges do not overlap. (7) `matchToDxf(rec, flat): MatchResult`
— 2D Kabsch on bend-line midpoints, brute-force the correspondence for n ≤ 4 (RANSAC above), try
both reflections; a pair matches when directions are parallel within 2°, perpendicular distance
≤ 1 mm and projected overlap ≥ 50 % of the shorter line (lengths may differ — CAD draws bend lines
across reliefs); on reflection invert every copied direction; copy angle/ri/direction into the DXF
flat's bends with sources 'step'/'mesh'; unmatched keep defaults + warning.

## Tooling & machine (`src/core/tools/`, `src/core/machine/`, `src/core/library/`)

Standard library (parametric generators, all profiles closed, CCW, mm; ids `std:<slug>`):
- Punches (Promecam/European style, height 120): straight 88° R0.8 and R0.2, straight 85° R0.8;
  gooseneck 88° R0.8 (short nose, relief cut back ABOVE the nose toward −X, load-bearing back —
  e.g. (0,0),(6,6.2),(6,25),(26,55),(26,120),(−12,120),(−12,92),(4,70),(6,45),(−7,28),(−6,6.2));
  acute 30° R0.8 and 28° R1.0; radius punches R3, R5, R10; hemming/flattening punch.
  `segmentLengths` 10,15,20,40,50,100,200,300,415,835 and 3000. `maxLoadPerMeter`: straight
  1000, gooseneck 600, acute 400, radius 800, hemming 800 kN/m. `tangCentreX` 0 except gooseneck
  (≈ +7).
- Dies (V = 6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80 at 88°; V12/V16 at 85°; V12/V16 at 30°
  acute): `bodyWidth = max(60, V + 2·max(10, 0.25·V))` rounded up to 10; height 60 (V ≤ 25), 90
  (V ≤ 50), 100 (V63/80); shoulder R = V/10 rounded to 0.5; `maxLoadPerMeter` V6 300, V8 400,
  V10 600, V ≥ 12 1000 kN/m. Multi-V 4-way block 90×90 (V 16/22/35/50, active on top). Hemming die.
- Fingers: standard flat finger (stopHeight 20, bodyDepth 60, width 30, height 35) and a stepped
  finger (samples/tools/custom-finger.dxf shape).
- Materials: mild steel (Rm 420, k 0.44, sb 1.5°, minR 0.8), stainless 304 (Rm 620, k 0.45,
  sb 3°, minR 1.5), aluminium 5052-H32 (Rm 230, k 0.42, sb 2°, minR 1.5), aluminium 6061-T6
  (Rm 310, k 0.42, sb 4.5°, minR 3.0), galvanised steel (as mild steel).
- Default machine "Generic 100t × 3100": capacity 1000 kN, bedLength 3100, stroke 200,
  daylight 420 (table top → clamp bottom at TDC; stack 60 + 60 + 120 = 240 → tip 180 above the
  die at TDC, 20 mm margin at max depth), throatDepth 400, distanceBetweenFrames 2600, ram
  thickness 60 / height 400 / clamp 110 thick × 90 high with `clampFrontOffset` 55, table width
  120 / holder 60×60 / height 500, backgauge X 10–750, R −25…150, Z 0–3100, 2 fingers,
  independent X and R, beam 100 deep × 60 high, retractAtPinch 0, speeds approach 100, bend 10,
  retract 100. `validateMachine` enforces the daylight/stroke inequalities in types.ts.
- Library persistence: `LibraryStore` = in-memory + `localStorage` cache + optional remote
  (`GET/PUT /api/library`, JSON `ToolLibrary` with `revision`; a PUT with a stale revision gets
  409 + the current body, and the store merges and retries once). `migrateLibrary(json)` upgrades
  old versions. Export/import as a `.json` file. Custom tools (`custom:<uuid>`) are added with
  `createCustomPunch/Die/Finger(profile, meta)` after `normalizeProfile`, which also enforces the
  profile extents and sets `height`.

## Simulation (`src/sim/`)

R3F scene: `<MachineModel>` (bed, table, holder, ram beam + asymmetric clamp at ramY — the CLAMP is
centred at the punch's `tangCentreX`, side frames, backgauge beam + fingers per `FingerSetting`),
`<ToolModel>` (extruded profiles per station, punch at its tip origin following ramY, mirrored in
X when flipped), `<PartMesh>`: ONE BufferGeometry
per flange built once per PartModel in FLAT coordinates (regions extruded ±t/2, holes via
`THREE.ShapeUtils.triangulateShape`), positioned every frame by `FoldedGeometry.flanges[].transform`
(`matrixAutoUpdate = false`); bend zones are regenerated in place into preallocated attributes
(12 arc segments, inner/outer surfaces + end caps) only when a fraction changes by > 0.002.
Double-sided material; colours: sheet, gauged-flange tint, collision red (emissive pulse).
`<SectionView>`: 2D canvas overlay of the XY cross-section (machine obstacles from
`machineObstacles`, part silhouette from `partSilhouette`, fingers) — operator side (−X) on the
LEFT, backgauge on the RIGHT, +Y up, labelled. Playback: `useSimStore` holds `keyframes`,
`timeS` cursor, `playing`, `speed`; between adjacent keyframes lerp ramY/backgauge/fold
fractions/position and slerp the quaternion. Camera presets iso/front/side/top; `OrbitControls`.
Collision highlighting: keyframes with collisions tint the offending element and show a badge;
playback pauses on the first 'error' collision unless "continue" is on.

## UI (`src/app/`, `src/i18n/`)

Layout (desktop-first, 1280+; usable at 1024): header (app name, language toggle EN/TH,
project name, save/load JSON); left panel tabs **Part** (import buttons: STEP/STL/OBJ/GLB,
DXF; load-sample menu; material + thickness; bends table with editable angle/ri/direction/k/
correction and per-attribute source badges), **Tools** (station list with Z range + segments;
punch/die pickers with profile preview; library manager with "Add custom tool" (DXF upload →
preview canvas → reference point + up direction + mirror → metadata form) and export/import
library), **Machine** (machine picker + editable parameters, validation messages); centre: 3D
viewport + section view toggle + transport bar; right panel **Sequence** (steps with tool,
included angle → loaded angle, X/R/Z per finger, ram depth, force kN/t and % of tool, turn icon,
warnings, collisions; "Plan" with options; drag to reorder → fixedOrder re-plan) and **Program**
(printable bilingual bend program: part/machine/material header, per-step rows with included
angles, outside dimensions + reference, per-finger X/R/Z, punch segments, part Z offset, ram
depth, tonnage; export JSON/CSV; print). `useProjectStore` (zustand) holds `Project`
(with `libraryOverlay`). i18n: `t(key, params)` with `en.json` and `th.json`; every user-facing
string goes through it; `Message` objects render via `t(m.key, m.params)`. Thai font: Sarabun
(bundled in `public/fonts/` by the integrator; fallback 'Noto Sans Thai', system-ui).

## Server & Docker (integrator)

`server/index.ts` + `server/app.ts` (`createApp({ distDir, dataDir })`, Express 5, run with tsx):
static `dist/` with SPA fallback and cache headers (hashed `/assets` immutable, html no-cache),
`GET /api/library` → JSON file at `$DATA_DIR/library.json` (404 → client uses defaults),
`PUT /api/library` (structural validation in `server/library-shape.ts` → 400, revision check →
409 with the current body, serialised + atomic write (temp file + rename), stored with
`revision + 1` and a fresh `updatedAt`, 200 with the stored body), `GET /api/health`.
Port `$PORT` (8080), `$DATA_DIR` (./data), `$DIST_DIR` (./dist). Tested end to end with the real
`LibraryStore` in `src/core/testing/server.test.ts`. `Dockerfile`: multi-stage node:22-alpine
(build → production deps + tsx → runtime with `dist/`, `server/`, `docker-entrypoint.sh` that
chowns `/data` and drops to the `node` user); `VOLUME /data`, `EXPOSE 8080`, `HEALTHCHECK` on
`/api/health`; `docker-compose.yml` (service `pbsim`, `8080:8080`, `./data:/data`, restart
unless-stopped) for Synology Container Manager. Vite dev and preview proxy `/api` →
`localhost:8080`; `worker: { format: 'es' }`; vendor chunks `three` / `react` / `vendor` via
rolldown `codeSplitting` groups. Fonts: Sarabun Regular/Bold woff2 (OFL) in `public/fonts/`.
`src/core/index.ts` re-exports every core barrel. `npm run e2e` = Playwright boot test of the
production build (`e2e/boot.spec.ts`); `scratch/boot-check.mjs` is the headless smoke used at
integration.

## Public API (barrel exports — exact names)

- core-geometry `src/core/geom`: `vec2`, `vec3` helpers; `mat4` (`identity, multiply, invert,
  translation, rotationAxisAngle(point, dir, deg), fromAxisAngle, applyToPoint, applyToDir,
  decompose(m) → {position, quaternion, scale}, compose`); polygons (`signedArea, area, isCCW,
  ensureCCW, centroid, bounds, pointInPolygon, segmentIntersect, polygonsIntersect,
  penetrationDepth(a, b), polygonDistance, splitPolygonByLine, clipPolygonByHalfPlane,
  arcToPoints, bulgeArcToPoints, transformPolygon, projectToXY, sharedBoundaryLength,
  convexHull, thickenSegment, clipToZ`).
  `src/core/bend`: `bendAllowance, outsideSetback, bendDeduction, neutralRadius, midRadius,
  airBendForce, hemFlattenForce, ramDepth(vWidth, t, ri, includedAngleDeg, shoulderRadius?,
  vAngleDeg?), punchTipY(…, vAngleDeg?), actualInnerRadius, springback, overbend, recommendedV,
  minLeg, legCheck, toolAngleFeasible`.
  `src/core/part`: `buildPartModel(flat): PartModel`, `foldGeometry(part, state):
  FoldedGeometry`, `flatState(part)`, `finishedState(part)`, `bendPose(...)`,
  `partSilhouette(folded, partToMachine, thickness, zBand?): Array<{polygon, zRange}>`,
  `flangeExtentFromBend(part, flangeId, bendId)`, `partBoundsFolded`.
- tooling-machine: `buildStandardLibrary(): ToolLibrary`, `migrateLibrary`, `LibraryStore`,
  `normalizeProfile`, `createCustomPunch/Die/Finger`, `toolLoadCheck`, `daylightCheck`,
  `defaultMachine`, `validateMachine`, `validateSetup`, `machineObstacles(machine, setup,
  library, ramY, fingers: FingerSetting[]): Array<{ id, kind: ObstacleKind, polygon: Polygon2,
  zRange: [number, number] | 'full' }>`.
- import-files: `importDxfFlat(text, opts)`, `importToolProfileDxf(text)`, `importMesh(buffer,
  ext)`, `importStep(buffer)`, `importFile({name, bytes}, opts)`.
- recognize-3d: `recognizeSheet(mesh, opts)`, `matchToDxf(rec, flat)`.
- planner: `planProgram(input, signal?, onProgress?): BendProgram`, `defaultPlannerOptions()`,
  `computePlacement`, `buildTimeline(program, part, material, machine, library)`.
- sim-3d: `<SimViewport>`, `<SectionView>`, `<TransportBar>`, `useSimStore`.
- ui: `<AppRoot>` (the integrator points `main.tsx` at it).

## Conventions

- TypeScript strict, `erasableSyntaxOnly` (no enums/namespaces/parameter properties),
  `verbatimModuleSyntax` (`import type`), `noUnusedLocals`; ES modules, named exports, barrel per
  module; no `any` in exported APIs.
- Pure functions in `src/core` — no DOM, no three.js (except `src/core/import/mesh.ts` which
  may use three's loaders behind a dynamic import so tests run in Node).
- Geometry tolerance: 1e-6 for exact comparisons, 0.01 mm for chaining, 0.05 mm chord error,
  0.2 mm collision penetration threshold, 0.5° / 2 % force in tests.
- Angles in degrees at API boundaries; convert internally.
- Every module ships tests; geometry/planner/recognizer test against `samples/` via
  `loadTruth` (`L-bracket`, `U-channel`, `Z-bracket`, `hat-channel`, `acute-bracket`,
  `box-4-flange`, `tabbed-plate`), on both `.step` (faceGroups) and `.stl` (no groups).
- i18n keys are `dot.separated`, English fallback; warning/collision keys live under
  `warnings.*` and `collisions.*` and carry `params`.

## Integration notes (resolved contract questions)

Conventions settled at integration; the module specs in `docs/specs/` and the comments in
`src/core/types.ts` carry the details.

- `FoldedGeometry.bends` has one entry per bend that touches material (look up by `bendId`);
  straight zones (`currentAngle < 0.01°`) report `Infinity` radii — branch on `isStraightZone`.
  `PartModel.bendAllowance` is NaN for a bend with invalid inputs (UI validates before planning).
- `bendPose(placement, folded, bendId, fraction, punchTipY, t)`: `folded` must have been computed
  for that fraction (a mismatch throws); the translation is `T(−apex.x)` (= +BA/2 when the child
  faces +X, −BA/2 when it faces −X).
- Flat dies (hemming, custom without a notch): `vWidth 0 / vAngle 180`; hemming stations are
  identified by `die.family === 'hemming'` and use `hemFlattenForce`; `toolLoadCheck` rejects a
  non-finite load. `Finger.maxLoadPerMeter` is 0 (unused).
- `validateMachine` uses the nominal 120 + 60 stack and 15 mm ram depth; `validateSetup` (per
  station) and `strokeCheck` (per bend) are the exact checks. The ram clamp obstacle is centred on
  the mounted punch's `tangCentreX`; the ram beam stays centred on the bend line.
- `Turn`: 'none' for translations and yaws ≤ 45°, 'rotate180' for any larger rotation about Y.
- `CollisionReport` carries the obstacle kind only; the sim identifies a report across keyframes by
  (kind, severity, atFraction, message.key) and highlights per kind.
- Recognition: planar tolerance 0.2° (not 1°) so fine tessellations keep their first bend facet;
  `bends3d[].axisDir` follows the fold model's right-hand convention; `ImportResult.recognized` is
  filled by the UI (`recognizeSheet` + `matchToDxf`), not by `importFile`; `FlatPattern.sourceUnits`
  is 'mm' for every non-inch unit (the real unit in `provenance.units`).
- `LibraryStore.save()` conflicts are resolved per item (ours win by id) — there are no per-item
  timestamps; the server answers 404 to the very first `GET /api/library` by design (browsers log
  it as a console error once).
- Project files carry no separate sheet thickness (it lives in `part.flat.thickness`); the UI keeps
  a `thickness` store field for DXF imports made before a part exists.
- The hat-channel sample is infeasible on the standard 60 mm wide V16 die body (the brim lands
  inside the die body — a real collision); the planner test also shows it feasible on a 50 mm body.
