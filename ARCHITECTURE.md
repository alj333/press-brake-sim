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
| `core-geometry` | `src/core/geom/**`, `src/core/bend/**`, `src/core/part/**` | types |
| `import-files` | `src/core/import/**` except `recognize/` | types, geom |
| `recognize-3d` | `src/core/import/recognize/**` | types, geom, bend, part |
| `tooling-machine` | `src/core/tools/**`, `src/core/machine/**`, `src/core/library/**` | types, geom |
| `planner` | `src/core/planner/**` | types, geom, bend, part, tools, machine |
| `sim-3d` | `src/sim/**` | types, part, planner (timeline), tools, machine |
| `ui` | `src/app/**`, `src/i18n/**`, `src/index.css` | everything above |
| integrator | `src/App.tsx`, `src/main.tsx`, `server/**`, `Dockerfile`, `package.json`, `vite.config.ts` | — |

Tests live next to the code as `*.test.ts` (vitest). Fixtures in `samples/` (shared, read-only).
Every module exports a barrel `index.ts`. **Do not add npm dependencies** — everything needed is
installed (three, @react-three/fiber, @react-three/drei, occt-import-js, dxf-parser, zustand,
express, vitest, jsdom, @playwright/test, tsx). If something is truly missing, say so in your
result instead of installing.

Commands: `npm run test` (vitest run), `npm run typecheck` (tsc -b), `npm run build`, `npm run dev`.

## Coordinate frames

See the header of `src/core/types.ts`. Summary:

- FLAT (u,v): DXF plane; +w = sheet top normal. 'up' bends fold toward +w.
- PART (x,y,z): root flange in z=0 plane, u→x, v→y, w→z.
- MACHINE: origin at die V centre on the shoulder plane at the left end of the bed;
  +X to the back (backgauge), +Y up, +Z left→right along the bed. Bend line ∥ Z.
- Tool profiles: 2D polygons in the machine XY plane, extruded along Z.

## Sheet-metal maths (single source of truth: `src/core/bend/`)

Notation: t thickness, ri inner radius, k k-factor, θ bend angle from flat (deg), V die opening,
θi = 180 − θ = included angle between the legs, Rm tensile strength (MPa), L bend length (mm).

- Bend allowance: `BA = (π/180)·θ·(ri + k·t)`.
- Outside setback: `OSSB = tan(θ/2)·(ri + t)` for θ ≤ 90 else `ri + t` (for the "dimension to the
  virtual sharp" convention; used only for display/deductions).
- Bend deduction: `BD = 2·OSSB − BA`.
- Neutral radius `rn = ri + k·t`, mid-surface radius `rm = ri + t/2`.
- Air-bend force (kN): `F = 1.42·Rm·L·t² / (V·1000)` (Rm in MPa, lengths in mm). Per metre:
  `F/m = 1.42·Rm·t² / V` kN/m. Check against punch/die `maxLoadPerMeter` and machine `capacity`.
- Ram depth for air bending (punch tip below the die shoulder plane), treating the die shoulders
  as sharp edges at x = ±V/2, y = 0, legs symmetric about Y at θi/2 from vertical, outer radius
  R = ri + t tangent to both legs, punch tip at the inner-arc apex:
  `D = (V/2)·cot(θi/2) + ri − (ri + t)/sin(θi/2)`  (θi = included angle at the moment).
  Sanity: V=12, t=2, ri=2, θi=90 → D ≈ 2.34 mm. Add `machine.yCorrection`. Clamp D ≥ 0.
  (The controller's own depth calc will differ slightly; this is for simulation + training.)
- Natural inner radius in air bending if the user doesn't specify: `ri ≈ 0.16·V` (mild steel);
  use `max(that, material.minInnerRadiusFactor·t)`.
- Springback: `sb = material.springbackDeg · (0.5 + 0.5·(ri/t))` clamped to [0.5°, 8°];
  `overbendAngle = θ + sb`. Ram depth is computed for the overbend angle.
- Minimum flange (gauged leg from bend line to edge) ≈ `plannerOptions.minFlangeFactor · V`
  (default 0.7·V) → warning below that; below `0.5·V` it is an error (sheet falls into the V).
- V selection rule of thumb: `V ≈ 8·t` for t ≤ 3 mm, `10·t` for 3–6, `12·t` above; the planner
  prefers the mounted die closest to that.

## Fold kinematics (core-geometry, `src/core/part/`)

`buildPartModel(flat)` splits the flat outline by the bend zones into flanges and builds the
tree (root = largest-area flange). Each bend line is the zone centre; zone half-width = BA/2.
`foldGeometry(part, foldState)` returns `FoldedGeometry`: parent flange fixed, arc zone of angle
θ·fraction, child subtree transformed by the arc. Mapping of the zone: distance s across the
zone (0..BA) → arc angle φ = s/rn; render the sheet from radius ri to ri+t around the arc centre,
mid-surface at rm. The child flange continues tangentially from the arc end. For a 'down'
bend the centre of curvature is on the −w side. Symmetric-bend rendering for the simulation
(both legs rising by θ/2 in the machine frame) is done by the sim by composing the placement
transform with a rotation of −θ/2 about the bend axis — core stays "parent fixed".

## Bend-sequence planner (`src/core/planner/`)

1. **Stations**: the user's `ToolSetup` lists mounted punch/die stations. The planner picks a
   station per bend (prefer one station; a change costs).
2. **Placements**: for bend b with the part folded at all previously-done bends, there are
   4 candidate placements: gauged side ∈ {parent side, child side} × flipped ∈ {false, true}.
   Build the PART→MACHINE transform so the bend line lies on Z at X=0 (line centred in the
   station's Z range), the sheet's lower face on Y=0, gauged flange toward +X.
3. **Collision model (2D projection, conservative)**: project the folded part (all flange
   mid-surface polygons thickened by t, plus arc zones) onto the machine XY plane as a set of
   polygons (`partSilhouette`). Machine obstacles as XY polygons: punch (at ram Y), ram clamp,
   ram beam, die, die holder, table front, backgauge finger at (x, r), backgauge beam. Z-gating:
   punch/die only collide with part geometry inside the station Z range; ram/table/beam are full
   length. Test with polygon–polygon intersection (segment crossing + containment). Sweep the
   current bend from fraction 0 → 1 in `sweepStepDeg` steps: at fraction f the ram is at depth
   D(θ_f) and the legs are at ±θ_f/2 (symmetric). Report the first contact as `CollisionReport`.
4. **Backgauge**: gauged flange length = distance from the bend line to the far edge of the
   gauged flange, measured ⟂ to the bend line at the finger Z positions; X must be within
   [xMin,xMax]; try R ∈ {0, rMax/2, rMax} until the finger polygon does not intersect the part
   silhouette; fingers at 2 Z positions within the gauged edge (or 1 if the edge is short). If the
   far edge is not parallel to the bend line, gauge on the two fingers at different X → warn.
5. **Search**: bends ≤ 7 → exhaustive over orders with early pruning on hard collisions;
   > 7 → beam search (width 40) with the same cost. Cost = Σ weights·(flip, rotate180,
   stationChange, shortFlange, collisionWarning) with tie-breakers: shorter flanges first,
   outer bends before inner (leaf → root), keep already-bent flanges pointing up/away from the
   die. `fixedOrder` skips the search. Produce `BendProgram`.
6. **Timeline**: `buildTimeline(program, part, machine, setup): SimKeyframe[]` — phases per step:
   position (part appears/moves in), gauge (fingers move, part slides to stop), approach (ram down
   to pinch), bend (fold 0→overbend, ram to D), release (springback: fold overbend→target, ram up
   a little), retract (ram to top), reposition (flip/rotate animation). Keyframes are dense enough
   for smooth interpolation (≥ 24 per phase) and include collisions for highlighting.

## Importers (`src/core/import/`)

- **DXF flat pattern** (`dxf-parser`): units from `$INSUNITS` (1 = in, 4 = mm, 0/absent = mm
  unless bounds suggest inches). Entities: LINE, LWPOLYLINE (bulge arcs), POLYLINE, ARC, CIRCLE,
  SPLINE (flatten), INSERT (blocks). Layer mapping (case-insensitive, prefix match):
  bend up: `IV_BEND`, `BEND`, `BEND_UP`, `BENDLINE`, `BEND_LINES`; bend down: `IV_BEND_DOWN`,
  `BEND_DOWN`, `BENDDOWN`; ignore: `IV_ARC_CENTERS`, `IV_TANGENT`, `IV_FEATURE_PROFILES`,
  `IV_ALTREP*`, `DIMENSION*`, `TEXT`. Outline = the largest closed loop assembled from the
  remaining geometry (chain segments with 0.01 mm tolerance); other closed loops = holes.
  Bend lines: each LINE on a bend layer; angle default 90°, `source:'dxf'` for geometry and
  `'default'` for angle; ri default from material/V rule. A `BendLine` whose ends don't reach the
  outline is trimmed/extended to it. Bend angle text (e.g. "UP 90.00° R 1.00") on the same
  layer, when present (Fusion/Inventor annotate), is parsed to set angle/ri (`source:'dxf'`).
- **DXF tool profile**: the single closed loop → `ToolProfile`; user picks orientation in the UI
  (`normalizeProfile(points, {kind, tipPoint?, up?})` in `src/core/tools/custom.ts`).
- **Meshes**: STL (binary+ASCII), OBJ, GLB/GLTF via three's loaders → `TriangleMesh`.
- **STEP** (occt-import-js): browser loader uses the wasm via Vite `?url`; the Node loader (tests)
  uses `require('occt-import-js')()`. Merge all meshes; keep `brep_faces` as `faceGroups`.
  Params: `{ linearUnit: 'millimeter', linearDeflectionType: 'absolute_value',
  linearDeflection: 0.05, angularDeflection: 0.2 }`.

## 3D sheet recognition (`src/core/import/recognize/`)

Input `TriangleMesh` (mm). Steps: (1) group triangles into faces — by `faceGroups` when present,
else by normal continuity (planar: normals within 1°, connected via shared edges; cylindrical:
smoothly varying normals). (2) Planar faces: fit plane, outline via boundary edges (edges with a
single triangle inside the group) chained into loops; largest loop = outline, others holes.
(3) Thickness t = the most common distance between anti-parallel planar face pairs that overlap
in projection. (4) Cylindrical faces: fit axis (least squares on normals) and radius; pair
inner/outer (radii r and r+t, same axis) → bend, angle from the angular extent; the two planar
faces adjacent (sharing boundary edges) are the flanges. (5) Choose the reference side (the side
with the larger total area — the "outside" for boxes is fine) and build the flange graph.
(6) Unfold: root = largest face; BFS; each child face placed in the flat by rotating about the
bend axis and offsetting by BA (k-factor from material); produce `FlatPattern` with `BendLine`s
(`source:'step'` or `'mesh'`). (7) `matchToDxf(recognized, dxfFlat)`: rigid-align bend line
midpoints (Kabsch in 2D, try both mirrors), match lines by length + position (tolerance 1 mm),
copy angle/ri/direction into the DXF flat's bends; unmatched keep defaults and add a warning.

## Tooling & machine (`src/core/tools/`, `src/core/machine/`, `src/core/library/`)

Standard library (parametric generators, all profiles closed, CCW, mm):
- Punches (Promecam/European style, height 120 unless noted): straight 88° R0.8 and R0.2;
  gooseneck 88° R0.8 (relief toward −X by default); acute 30° R0.8 (and 28° R1.0);
  radius punches R3, R5, R10 (semi-round tip); hemming/flattening punch. Segment set
  10,15,20,40,50,100,200,300,415,835 mm and full 3000. `maxLoadPerMeter` 1000 kN/m typical,
  gooseneck 600, acute 400, radius 800.
- Dies: single-V 88° with V = 6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80 (height 60 for
  V≤16, 90 for larger, shoulder R = V/10 rounded to 0.5), 30° acute V12/V16; multi-V 4-way block
  (V 16/22/35/50) modelled as `family:'multi-v'` with `vWidth` = active V; hemming die.
- Fingers: standard flat finger (stopHeight 20, bodyDepth 60, width 30) and a stepped finger.
- Materials: mild steel (Rm 420, k 0.44, sb 1.5°, minR 0.8), stainless 304 (Rm 620, k 0.45,
  sb 3°, minR 1.5), aluminium 5052-H32 (Rm 230, k 0.42, sb 2°, minR 1.5), aluminium 6061-T6
  (Rm 310, k 0.42, sb 3°, minR 3.0), galvanised steel (as mild steel).
- Default machine "Generic 100t × 3100": capacity 1000 kN, bedLength 3100, stroke 200,
  daylight 470, throatDepth 400, distanceBetweenFrames 2600, ram 60×400 (clamp 60×80),
  table width 120 / holder 60×60 / height 500, backgauge X 10–750, R 0–150, Z 0–3100,
  fingers 2, beam 100 deep × 60 high, speeds approach 100, bend 10, retract 100.
- Library persistence: `LibraryStore` = in-memory + `localStorage` cache + optional remote
  (`GET/PUT /api/library`, JSON `ToolLibrary`). Export/import as a `.json` file. Custom tools
  are added with `createCustomPunch/Die/Finger(profile, meta)` after `normalizeProfile`.

## Simulation (`src/sim/`)

R3F scene: `<MachineModel>` (bed, table, holder, ram, clamp, side frames, backgauge beam +
fingers, from `Machine`), `<ToolModel>` (extruded profiles per station), `<PartMesh>` (rebuilt
from `foldGeometry` + `FoldState`; flanges extruded ±t/2; bend zones swept arcs with 12+
segments; double-sided material; colour by state: normal / gauged flange highlight / collision
red), lighting, grid, `OrbitControls`, camera presets (iso, front, side/section). `<SectionView>`:
a 2D canvas overlay drawing the XY cross-section (tools + part silhouette + fingers) — the
classic bend-sim picture. Playback: `useSimStore` (zustand) holds `keyframes`, `cursor` (float
index), `playing`, `speed`; `requestAnimationFrame` advances the cursor; interpolate ramY, fold
fractions and transform (slerp not needed: transforms are piecewise-constant per phase except
'reposition', which lerps position + rotates about Y/X; keep it simple and readable).
Collision highlighting: any keyframe with collisions tints the offending machine element red
and shows a badge; playback pauses on the first 'error' collision unless "continue" is on.

## UI (`src/app/`, `src/i18n/`)

Layout (desktop-first, 1280+; usable at 1024): header (app name, language toggle EN/TH,
project name, save/load JSON); left panel tabs **Part** (import buttons: STEP/STL/OBJ/GLB,
DXF; material + thickness; bends table with editable angle/ri/direction/k and per-bend badges
for source), **Tools** (station list; punch/die pickers with profile preview; library manager
with "Add custom tool" (DXF upload → preview canvas → orientation controls → metadata form) and
export/import library), **Machine** (machine picker + editable parameters); centre: 3D
viewport + section view toggle + transport bar (play/pause, step ◀ ▶, speed, step list scrubber);
right panel **Sequence** (steps with tool, angle, backgauge X/R, ram depth, force, warnings,
collisions; "Plan" button with options; drag to reorder → fixedOrder re-plan) and **Program**
(printable bilingual bend program table; export JSON/CSV; print). `useProjectStore` (zustand)
holds `Project`. i18n: `t(key, params)` hook from `src/i18n/` with `en.json` and `th.json`
dictionaries; every user-facing string goes through it. Thai font: Sarabun (bundled in
`public/fonts/`, `@font-face` in `index.css`), fallback 'Noto Sans Thai', system-ui.

## Server & Docker (integrator)

`server/index.ts` (Express 5): static `dist/`, `GET /api/library` → JSON file at
`$DATA_DIR/library.json` (404 → client uses defaults), `PUT /api/library` (validate shape,
write atomically), `GET /api/health`. Port `$PORT` (8080). `Dockerfile`: multi-stage
node:22-alpine build → runtime with `dist/` + `server/`; `VOLUME /data`; `docker-compose.yml`
for the NAS. Vite dev proxies `/api` → `localhost:8080`.

## Conventions

- TypeScript strict, no `any` in exported APIs, ES modules, named exports, barrel per module.
- Pure functions in `src/core` — no DOM, no three.js (except `src/core/import/mesh.ts` which
  may use three's loaders; guard so tests can run in Node/jsdom).
- Geometry tolerance: 1e-6 for exact comparisons, 0.01 mm for chaining, 0.05 mm chord error.
- Angles in degrees at API boundaries; convert internally.
- Every module ships tests; the planner and geometry modules test against the parts in
  `samples/` (`L-bracket`, `U-channel`, `Z-bracket`, `box-4-flange`, `hat-channel`).
- i18n keys are `dot.separated`, English fallback; collision/warning keys live under
  `warnings.*` and `collisions.*`.
