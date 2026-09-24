# Press Brake Simulator

A browser application for shop-floor staff to **import a sheet-metal part** (3D STEP / STL / OBJ / GLB and/or
a 2D DXF flat pattern), pick the **tooling and machine**, let the **planner design the bend program**
(sequence, station, backgauge X / R / Z, ram depth, tonnage, collision checks) and **watch a 3D simulation** of
the folding — bilingual English / ไทย.

Stack: Vite + React 19 + TypeScript (strict) + three.js (@react-three/fiber, drei) + zustand; vitest;
Express 5 server for the shared tool library; Docker image for a Synology NAS.

---

## Features

- **Import**
  - STEP (`.step` / `.stp`, via OpenCascade in a Web Worker), STL (binary + ASCII), OBJ, GLB / GLTF.
  - DXF flat pattern (Fusion 360 / Inventor / SolidWorks style layers, bend lines, bend notes,
    arcs, splines, blocks, mm / inch).
  - **3D sheet recognition**: thickness, planar flanges, bend cylinders → bend angles / radii / directions
    and an unfolded flat pattern; when a DXF is loaded as well, the 3D bends are matched onto the DXF
    (the drawing stays the geometry source, the model supplies angle / radius / direction).
  - Bends table with editable angle, inner radius, direction, k-factor, trial-bend correction, hems; per-attribute
    source badges (DXF / STEP / mesh / user / default); add bends on the flat view.
- **Tooling & machine**
  - Standard library: Promecam / European style punches (straight 88° / 85°, gooseneck, acute 30° / 28°,
    radius R3 / R5 / R10, hemming), V dies V6 – V80 at 88°, V12 / V16 at 85° and 30°, a 4-way multi-V block,
    a hemming die; flat and stepped backgauge fingers; materials (mild steel, stainless 304, aluminium 5052 /
    6061, galvanised steel); a generic 100 t × 3100 mm machine.
  - **On-site tools**: upload a DXF cross-section of your own punch, die or finger, pick the reference point /
    up direction / mirror, fill the metadata — the profile is used for drawing and collision checks.
  - Editable machine parameters (bed, capacity, stroke, daylight, ram / clamp geometry, table, backgauge axes,
    speeds); validation of the stack / stroke / daylight inequalities; save as a new machine.
  - Stations: which punch / die is mounted where on the bed (Z range, segments, flipped).
  - Shared library: cached in the browser and synchronised with the server (`/api/library`) so every PC in the
    shop sees the same custom tools and machine calibration.
- **Planner**
  - Bend-sequence search (exhaustive ≤ 7 bends, beam search above) minimising flips / rotations / station
    changes / short flanges / collision warnings, or a **fixed order** by dragging the steps.
  - Per step: station and V selection, included / loaded angle with springback and overbend, actual air-bend
    radius, ram depth, pinch and retract heights, force (kN / t) and % of tool rating, punch length / segments /
    part Z offset, per-finger backgauge X / R / Z and contact type, outside dimension + bend deduction with the
    dimension reference (virtual sharp / tangent), orientation, turn between steps, bottoming flag.
  - Collision model: the folded part is swept through the bend against punch, clamp, ram, die, holder, table,
    fingers, backgauge beam and side frames; minimum-leg, tool-angle, daylight, stroke, tonnage and
    tool-load checks; hems expand into a pre-bend + a hem-flatten step on a hemming station.
- **Simulation**: 3D machine + tools + folding part (constant-arc-length bend zones), playback with phases
  (position, gauge, approach, bend, release, retract, reposition), camera presets, 2D section view (operator
  side left, backgauge right), collision highlighting with auto-pause.
- **Program**: printable bilingual bend program (A4 landscape), JSON / CSV export; project files (`.pbsim.json`)
  that carry the part, setup, program and the custom tools they reference.

---

## Running it

### Development

```bash
npm install                # once (Node 22 recommended)
npm run serve              # API + static server on http://localhost:8080 (shared library in ./data)
npm run dev                # Vite dev server on http://localhost:5173 (proxies /api → :8080)
```

The app works without the API server too: the library is then kept in the browser's `localStorage` only
(the toast after "Save library" says *server unavailable — saved locally only*).

Other scripts: `npm run typecheck` (`tsc -b`), `npm test` (vitest, ≈ 700 tests incl. the server), `npm run build`
(type-check + production bundle in `dist/`), `npm run preview` (serve `dist/` on :4173, `/api` proxied to :8080),
`npm run e2e` (Playwright suite against the production build — run `npm run build` first; it uses
`/opt/pw-browsers/chromium` when present, else `PW_CHROMIUM=/path/to/chromium`, else the browser from
`npx playwright install chromium`; `e2e/*.spec.ts` cover boot + EN/TH, sample and DXF import, planning, playback,
custom tools, machine edits, program export / print, with screenshots in `scratch/e2e/`), `npm run lint`.

### Production build without Docker

```bash
npm ci
npm run build
PORT=8080 DATA_DIR=/srv/pbsim/data npm run serve
```

`server/index.ts` (Express 5, run with `tsx`; on Node ≥ 22.18 plain `node server/index.ts` works too) serves
`dist/` with an SPA fallback and the API:

| Route | Purpose |
|---|---|
| `GET /api/health` | `{ ok, uptimeS, dist, library: { exists, revision } }` |
| `GET /api/library` | the shared `ToolLibrary` JSON (`404` until the first save — the client then uses its defaults) |
| `PUT /api/library` | replace the shared library; the body must carry the current `revision`, a stale one gets `409` + the current body (the client merges and retries once); the stored copy gets `revision + 1` and a fresh `updatedAt`; written atomically to `$DATA_DIR/library.json` |

Environment: `PORT` (8080), `DATA_DIR` (`./data`), `DIST_DIR` (`./dist`), `HOST` (`0.0.0.0`).

### Docker on a Synology NAS (Container Manager), step by step

1. **Copy the project** to the NAS, e.g. to the shared folder `docker/press-brake-sim` (File Station upload, or
   `git clone` over SSH). `node_modules` and `dist` are not needed — the image builds them.
2. Open **Container Manager → Project → Create**.
   - Project name: `pbsim`
   - Path: `/docker/press-brake-sim` (the folder that contains `docker-compose.yml`)
   - Source: **Use existing docker-compose.yml** — Container Manager reads the file, builds the image from the
     `Dockerfile` (multi-stage `node:22-alpine`: `npm ci` → `npm run build` → slim runtime with `dist/`,
     `server/` and only the runtime packages — `express` + `tsx`, versions taken from the lockfile) and starts
     the container. The first build takes a few minutes (it downloads the npm packages).
3. Check **Container → pbsim → Log**: you should see `[pbsim] listening on http://0.0.0.0:8080` and the health
   check turning green (`GET /api/health`).
4. Open `http://<nas-ip>:8080` from any PC in the shop. Load a sample from **Part → Load sample** to see the
   whole flow.
5. **Data**: the shared library is the single file `data/library.json` next to `docker-compose.yml`
   (bind-mounted to `/data`, written atomically, included in your normal NAS backups). The container starts as
   root only to make that folder writable, then drops to the unprivileged `node` user.
6. **Update**: copy the new version over the folder, then in Container Manager choose the project →
   **Action → Build** (or `docker compose up -d --build` over SSH). The library file is kept.
7. Optional: change the host port on the left side of `"8080:8080"` in `docker-compose.yml`, set `TZ`, or put
   the app behind the NAS reverse proxy (Control Panel → Login Portal → Advanced → Reverse Proxy) for HTTPS.

Without Container Manager: `docker compose up -d --build` in the project folder does the same on any Docker host.

---

## Importing parts from Fusion 360

Load both files of a part when you can: the **STEP** gives the real bend angles, radii and directions; the
**DXF flat pattern** gives the exact laser-cut outline, holes and bend-line positions (the flat is the
authoritative geometry). Drop them together on the **Part** panel (or use the buttons); the app matches the 3D
bends onto the DXF bend lines and shows `STEP` badges on the angle / radius / direction columns.

### 1. STEP export (3D)

Fusion 360: **File → Export…**, type **STEP Files (`*.stp`, `*.step`)** — or right-click the sheet-metal
component in the browser and export it alone. Export the **folded** body (not the flat pattern). Units are read
from the file. STL also works (right-click the body → *Save As Mesh* → STL, *Refinement: High*) but STEP is
preferred — the B-rep faces make the recognition exact; STL bend cylinders must be tessellated with at least
5 facets per 90° and at most 20° per facet.

What is recognised: constant thickness 0.5–6 mm sheets, planar flanges, cylindrical bend zones (angles
10°–180°, open hems), holes and cutouts. Not recognised: hems with touching flanges, formed features
(louvres, embosses), cones, drafted walls, parts with more than one bend between the same two flanges.

### 2. DXF flat pattern export (2D)

Fusion 360 (Sheet Metal workspace):

1. **Create Flat Pattern** (Sheet Metal tab → Create Flat Pattern, select the stationary face — the face that
   lies on the die is a good choice; the flat's "top" is the side you look at).
2. In the FLAT PATTERN tab click **Export Flat Pattern as DXF** and set:
   - **Unit type**: `mm` (inches are accepted too, they are converted — the unit is read from the file header;
     if a file has no unit the app guesses and lets you override it in *DXF units*),
   - **Convert splines to polylines**: on, tolerance `0.01`–`0.05 mm` (splines are also accepted, but
     rational splines lose their weights),
   - **Visible geometry → Center lines**: **on** — these are the bend lines,
   - **Visible geometry → Extent lines**: off (they are ignored anyway).
3. **Finish Flat Pattern**. Name the file `<part>-flat.dxf` — the `-flat` suffix is stripped from the part
   name.

Fusion (like Inventor) writes each kind of geometry on its own layer, which is how the importer reads it:

| Layer (prefix, case-insensitive) | Meaning |
|---|---|
| `IV_OUTER_PROFILE`, `OUTER`, `OUTLINE`, `CONTOUR`, `CUT`, `PROFILE` | outer contour (largest closed loop) |
| `IV_INTERIOR_PROFILES`, `INTERIOR`, `INNER`, `HOLE`, `CUTOUT` | holes and cutouts |
| `IV_BEND`, `BEND`, `BEND_UP`, `BENDLINE`, `BEND_LINES` | bend centre lines, **up** (toward the flat's top side) |
| `IV_BEND_DOWN`, `BEND_DOWN`, `BENDDOWN` (any bend layer containing `DOWN`) | bend centre lines, **down** |
| `IV_ARC_CENTERS`, `IV_TANGENT`, `IV_FEATURE_PROFILES`, `IV_ALTREP*`, `IV_TOOL_CENTER*`, `DIMENSION*`, `TEXT`, `DEFPOINTS`, `NOTES`, `TITLE`, `BORDER` | ignored |
| anything else (`0`, …) | geometry — chained into loops; the largest loop is the outline when no outline layer exists |

Rules that make a DXF import cleanly:

- One closed outer contour, drawn once (double lines are dropped with an info message), gaps ≤ 0.01 mm
  (≤ 0.5 mm are closed with a warning).
- One `LINE` per bend on a bend layer, running across the part from edge to edge (lines that stop short of, or
  overshoot, the outline are trimmed / extended to it — also across relief slots).
- Bend angle / radius: without a note every bend is **90°** with the material's natural air-bend radius
  (`sources: default`) — a STEP file or a manual edit fixes that. A text on the bend layer next to the line is
  read as a **bend note**: `UP 90.00° R 1.00`, `DOWN 135 DEG R 0.8`, `A=45 R=1.5 K=0.44` (angle from flat,
  radius in the drawing's units, k-factor); `180°` marks a hem.
- Bend lines on layer `0` distinguished only by line type (the SolidWorks default) are **not** detected —
  put them on a `BEND*` layer, or add the bends in the app (*Add bend* → click two points on the flat).
- Material and thickness come from the Part panel (set them before importing a DXF alone; a STEP sets the
  thickness itself).

### 3. Other CAD

Inventor uses the same `IV_*` layers. SolidWorks: export the flat pattern with *Bend lines* on and rename the
layer to `BEND`. Any DXF with the outline on one layer and bend lines on a `BEND*` layer works.

---

## Adding on-site dies, punches and fingers

**Tools → Library → Add custom tool**: choose the DXF, the kind (punch / die / finger), the units, then click
the **reference point** on the preview (or keep *auto*), set the **up direction** as drawn, **mirror** if
needed, optional **scale**, and fill the metadata (name, rating kN/m, segment lengths, and the values the
derivation could not read). The tool is saved to the library and synchronised to the server; it shows up in the
station pickers with a profile preview. Three templates live in `samples/tools/` (`custom-gooseneck-punch.dxf`,
`custom-v16-die.dxf`, `custom-finger.dxf`).

DXF conventions for the cross-section:

- **One closed loop** (LWPOLYLINE with bulge arcs, or lines + arcs chained end to end) on any layer, drawn in the
  machine's XY plane — the section perpendicular to the bend line, **1 : 1 in mm** (inches are converted).
- Draw the tip radius / shoulder fillets as real arcs (that is how tip radius, V angle and shoulder radius are
  derived); no dimensions, hatches or centre lines are needed (they are ignored if present).
- Orientation is chosen in the dialog, but drawing it "as mounted" (+Y up) with the machine's back toward +X
  keeps the defaults right. The profile is shifted so that the reference point becomes the origin of the tool
  frame below.

Tool frames (2D, extruded along the bed / Z):

```
 PUNCH — origin at the TIP; y ∈ [0, height]; +X = toward the backgauge   DIE — origin at the V CENTRE on the shoulder
                                                                          plane (top face); y ∈ [−height, 0]
            y = height  ┌─────────┐  ← clamped tang (top edge)
                        │  tang   │     tangCentreX = x of the tang           shoulder plane y = 0
                        │         │     centre (0 for straight punches,      ┌──────┐          ┌──────┐
             operator   │         │     ≈ +7 for a gooseneck)                │      │\   V    /│      │  shoulder
              −X  ◄──   │  body   │   ──►  +X  backgauge                     │      │ \      / │      │  radius rs
                         \       /                                           │      │  \    /  │      │
                          \     /   ← tip angle (88°, 85°, 30° …)            │      │   \  /   │      │  vAngle
                           \   /                                             │ body │    \/    │ body │
                            \_/     ← tip radius; tip = origin (0, 0)        │      │  x = 0   │      │
                             ▲                                               └──────┴──────────┴──────┘ y = −height
                          (0, 0)                                                     bodyWidth

 FINGER — origin at the BOTTOM of the STOP FACE; the stop face is the segment (0, 0)–(0, stopHeight) on x = 0;
          the body extends toward +X (behind the stop face, toward the beam); y ∈ [0, height]

                 y = height ┌──────────────────────────┐
                            │                          │
      sheet ──►  stop face  │    body (bodyDepth)      │  ──► +X (backgauge beam behind)
      (from −X)     x = 0   │                          │
                            ├──────────────────┐       │
              stopHeight ──►│                  └───────┘
                    (0, 0)  └─── origin           width along Z is entered in the form (default 30 mm)
```

Metadata: `maxLoadPerMeter` (kN/m, default 600 for custom tools), `segmentLengths` (available pieces in mm,
empty = one full-length tool), punch `tipAngle` / `tipRadius` / `tangCentreX`, die `vWidth` / `vAngle` /
`shoulderRadius` (a flat die without a notch, e.g. a hemming die, takes `vWidth 0 / vAngle 180`; a U die derives
`vAngle` from the angle between its walls), finger
`stopHeight` / `bodyDepth` / `width`. Derived values are shown; correct them when the derivation says
*tip not found* / *notch not found* / *stop face not found* (e.g. V angles above ~145°, asymmetric shoulders,
tips drawn without an arc).

Library management: **Export library** / **Import library** (JSON, merged by id — custom tools travel with a
project file too), **Reset standard items** (regenerates every `std:` item, keeps custom ones), **Save library**
(pushes to the server; another PC's newer copy is merged automatically).

---

## Machine setup fields (Machine panel)

All lengths mm, forces kN (≈ 9.81 kN per tonne), speeds mm/s. Frame: origin at the die V centre on the shoulder
plane at the operator's left end of the bed, +X toward the backgauge, +Y up, +Z along the bed.

| Group | Field | Meaning |
|---|---|---|
| General | Bed length | usable tool length along Z |
| | Capacity | max press force (checked per step: `warnings.machine.capacity`) |
| | Stroke | ram Y travel |
| | Daylight | table top (die-holder seat) → clamp bottom face at top dead centre; the tool stack `holderHeight + die.height + punch.height` must fit with room to bend (`stroke ≥ daylight − stack + maxRamDepth + 5`) |
| | Throat depth | bend line → side-frame throat (parts deeper than this hit the frames outside the space between them) |
| | Distance between frames | clear width between the side frames, centred on the bed |
| | Y correction | calibration added to every computed ram depth |
| Ram and clamp | Ram thickness / height | upper beam collision volume, centred on the bend line |
| | Clamp thickness / height / front offset | Promecam-style clamp block below the beam; *front offset* = how far its front face sits in front of the bend line (asymmetric clamps) |
| Speeds | Approach / Bend / Retract | ram speeds for the simulation timing |
| Table and holder | Table width, holder width / height, table height | lower beam collision volumes |
| Backgauge | X min / max | finger stop-face travel from the bend line |
| | R min / max | finger height range (origin at the bottom of the stop face; negative = below the die plane) |
| | Z min / max, number of fingers, finger | finger travel along the bed, count, finger tool |
| | Independent X / R per finger | whether the two fingers may take different X / R (X1/X2, R1/R2) |
| | Beam depth / height | backgauge beam behind the fingers (collision volume) |
| | Retract at pinch | +X retract of the fingers once the sheet is pinched (0 = none); suggested when a finger touches the swinging leg |
| | Backgauge speed | for the simulation timing |

Tool stations (Tools panel): punch + die per Z range, punch segments (from the punch's segment lengths; *auto*
composes them), *flipped* mounts a tool mirrored in X (gooseneck relief to the back). The default setup puts
one station over the whole bed with the standard 88° punch and the V closest to the recommended opening for the
sheet thickness.

---

## Bend maths

Notation: `t` thickness, `ri` inner radius, `k` k-factor, `θ` bend angle from flat (deg), `θi = 180 − θ`
included angle, `V` die opening, `Rm` tensile strength (MPa), `L` bend length (mm), `rs` die shoulder radius,
`β = vAngle / 2`. Single source of truth: `src/core/bend/formulas.ts`.

- Bend allowance `BA = θ·π/180 · (ri + k·t)`; neutral radius `rn = ri + k·t`; mid-surface radius `rm = ri + t/2`.
- Outside setback `OSSB = tan(θ/2)·(ri + t)` for θ ≤ 90 (dimension to the **virtual sharp**); `ri + t` for
  θ > 90 (dimension to the **tangent** line). Bend deduction `BD = 2·OSSB − BA`. Every program row states which
  reference its outside dimension uses.
- Air-bend force `F = 1.42 · Rm · L · t² / (V · 1000)` kN (`F/m = 1.42 · Rm · t² / V` kN/m), checked against the
  punch / die ratings (`loadPercentOfTool`) and the machine capacity.
- Hem flattening force `F ≈ 0.7 · Rm · t · L / 1000` kN, checked against the hemming tools' ratings.
- Actual air-bend inner radius `ri_actual = max(0.16 · V · Rm / 420, punch.tipRadius, minInnerRadiusFactor · t)` —
  used for ram depth, springback and the simulated arc; a mismatch with the drawing's radius larger than
  `max(0.25·t, 20 %)` is reported with the flange error `ΔBA/2` per leg.
- Springback `sb = springbackDeg · (0.5 + 0.5 · ri_actual / t) · (θ / 90)`, clamped to [0.3°, 12°];
  `overbend = θ + sb + angleCorrection`; `loadedIncludedAngle = 180 − overbend`.
- Ram depth (punch tip below the shoulder plane) for legs at `θi/2` from vertical, outer radius `R = ri + t`
  tangent to both legs: sharp shoulders `D = (V/2)·cot(θi/2) + ri − (ri + t)/sin(θi/2)`; with a shoulder fillet
  the contact moves to the fillet circle (centre `(V/2 + rs·(1 − sin β)/cos β, −rs)`, radius `rs`) and `D` is
  solved so the outer leg line is tangent to it. `D(θi = 180) = −t` (tip on the sheet at the pinch point);
  `D ≥ −t`. `ramDepth = D + yCorrection`; ram Y (clamp bottom) `= punch.height − D`.
- Tool angle: a bend is only feasible on a station whose punch tip angle and die V angle both fit inside the
  loaded included angle; `bottoming` is flagged when `180 − overbend ≤ vAngle + 1` (every 90° bend on 88°
  tools bottoms slightly — an information flag, not an error; 85° tools avoid it).
- Minimum leg (outside, to the virtual sharp) `Lmin = (V/2) / sin(θi_loaded / 2) + rs + 2`; below it the step is
  infeasible on that station, below `1.15 · Lmin` a warning.
- V selection: the mounted die with V closest to `8·t` (t ≤ 3), `10·t` (3–6 mm), `12·t` (> 6 mm) among the
  dies passing the angle rule; acute bends need the 30° dies; hems need an acute station for the 150° pre-bend
  and a hemming station for the flattening.
- Fold model (simulation): constant arc length — at fold fraction `f` the zone of flat width `BA` wraps onto an
  arc of neutral radius `BA / rad(f·θ)`, so the flanges keep their flat length and the arc ends where the
  flanges begin.

---

## Project files, samples and the shared library

- **Save project** writes `<name>.pbsim.json`: part (flat pattern + bends), tool setup, machine id, material,
  planner options, the program, the language and a `libraryOverlay` with every library item the project uses
  (custom tools included). **Load project** restores it on any PC; a machine calibration in the file is adopted
  by a PC whose machine is still the untouched standard one, otherwise the local machine wins and the program is
  flagged *re-plan*.
- **Load sample** (Part panel) loads the bundled parts from `public/samples/` (L-bracket, U-channel,
  Z-bracket, hat channel, acute bracket, box with 4 flanges, tabbed plate) — each has a STEP, STL, DXF and a
  `.truth.json` with closed-form goldens used by the tests.
- The shared library JSON (`data/library.json`) contains the full library (standard items included, so a shop
  can edit ratings); its `revision` protects against two PCs overwriting each other.

---

## Limitations

- Air bending only (no bottoming / coining depth calculation, no rotary or folding-machine kinematics);
  hems are modelled as an acute pre-bend + flattening.
- Recognition needs constant-thickness sheet parts: no formed features, cones, drafted walls, closed hems or
  parts with more than one bend between the same two flanges; STL tessellations must have 5–90 facets per 90°
  of bend.
- Bend lines must be on a `BEND*` layer in the DXF (line-type-only conventions are not read); bend notes are
  read as angles from flat.
- The collision model checks the part against the machine and tools (punch, clamp, ram, die, holder, table,
  fingers, beam, frames) — **not the part against itself**; flange holes are ignored (conservative).
- The planner treats the two fingers as a pair with the same X / R; sequences with more than 7 bends use a beam
  search (not exhaustive) and a coarser sweep during the search.
- Standard tool profiles are parametric approximations (Promecam / European style); ratings are typical values —
  enter your own tools and ratings for real capacity checks. The machine model is schematic (no tool holders /
  clamping systems / crowning).
- Springback and natural-radius rules are empirical; use the per-bend *correction* after a trial bend.
- The 3D viewport needs WebGL; the STEP importer downloads a 7.6 MB WebAssembly module on first use.

---

## Development

```
src/core/geom, bend, part   pure geometry, bend formulas, flange tree + fold kinematics (core-geometry)
src/core/import              DXF / STL / OBJ / GLB / STEP importers, STEP Web Worker (import-files)
src/core/import/recognize    3D sheet recognition + unfolding + DXF matching (recognize-3d)
src/core/tools, machine, library   standard tools, custom tools, checks, machine, obstacles, LibraryStore
src/core/planner             stations, placements, collisions, backgauge, search, program, timeline
src/sim                      R3F viewport, section view, transport bar, playback store
src/app, src/i18n            React shell, panels, project store, EN / TH dictionaries
server/                      Express server (static + /api/library + /api/health)
samples/                     sample parts with ground truth, custom tool DXFs
docs/specs/*.md              per-module specifications; ARCHITECTURE.md is the contract, src/core/types.ts the types
```

`npm test` runs every module's tests against the samples (geometry goldens, importer round trips, recognition
on STEP and STL, planner programs, timeline continuity, the server API). `scratch/boot-check.mjs` boots the
production build in headless Chromium, loads the L-bracket STEP through the worker, plans it and takes
screenshots.

Fonts: Sarabun (SIL Open Font License, `public/fonts/OFL.txt`).
