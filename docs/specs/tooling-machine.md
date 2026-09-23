# tooling-machine — `src/core/tools`, `src/core/machine`, `src/core/library`

Pure TypeScript (no DOM, no three.js; `localStorage` / `fetch` are optional and guarded).
Units: mm, degrees at every API boundary, kN, kN/m, MPa. Types come from `src/core/types.ts`.
Every sub-module has a barrel `index.ts`. Depends on `src/core/geom` only (plus types).

Tool profile frames (contract header of `types.ts`): closed CCW `Polygon2` in the machine XY
plane, extruded along Z.
- Punch: origin at the physical TIP point (the lowest point of the tip arc), +Y up toward the
  clamp, +X toward the machine back; `y ∈ [0, height]`, tang top edge at `y = height`.
- Die: origin at the V centre on the shoulder plane; `y ∈ [−height, 0]`.
- Finger: origin at the bottom of the stop face; stop face = segment `(0,0)–(0,stopHeight)`;
  body toward +X; `y ∈ [0, height]`.

Profile arcs are flattened with chord error `TOOL_CHORD_TOL = 0.02 mm`; tip arcs always contain
the origin as an explicit vertex (even segment count) so "tip at the origin" holds exactly.

---

## 1. `src/core/tools`

### 1.1 Parametric punches (`punches.ts`) — all return `Punch` (`source: 'standard'` unless
`meta.source` says otherwise; ids default to `std:<slug>`)

Common tip construction (`tipArc` in `profile.ts`): for tip angle `2α` and radius `r > 0` the
tip circle has centre `(0, r)`; tangent points `T = (±r·cos α, r·(1 − sin α))`; the flanks leave
`T` along `(±sin α, cos α)`. The virtual sharp is at `y = −r·(1/sin α − 1)` (below the origin),
which is what the ram-depth formula assumes (tip on the sheet's inner apex). `r = 0` ⇒ single
vertex at the origin.

| generator | shape |
|---|---|
| `straightPunch({ tipRadius = 0.8, tipAngle = 88, height = 120, bodyWidth = 20, … })` | tip arc, flanks at ±α from vertical until the half-width reaches `bodyWidth/2`, vertical body to `y = height`, flat tang top. `tangCentreX = 0`. Family `'straight'` (or `meta.family`). |
| `gooseneckPunch({ tipRadius = 0.8, tipAngle = 88, height = 120 })` | ARCHITECTURE shape: tip arc, flanks to `x = ±6`, then `(6,25) (26,55) (26,120) (−12,120) (−12,92) (4,70) (6,45) (−7,28) (−6,y_flank)`. Relief toward −X above the nose, load-bearing back (+X). `bodyWidth = 38`, `tangCentreX = 7` (tang spans x ∈ [−12, 26]). Heights ≠ 120 scale the y of every point above `y = 25` by `(height − 25)/95`; heights < 45 are clamped to 45 (the outline would fold over), `tipAngle` ≥ 28 and the tip radius is limited so the flank to `x = ±6` stays ≥ 2 mm long. |
| `acutePunch({ tipAngle = 30, tipRadius = 0.8, height = 120, bodyWidth = 20 })` | `straightPunch` geometry with the acute tip; family `'acute'`. |
| `radiusPunch({ radius, tipAngle = 88, height = 120, bodyWidth? })` | `straightPunch` with `tipRadius = radius`; `bodyWidth = max(20, ceil(2·radius) + 6)`; family `'radius'`. |
| `hemmingPunch({ faceWidth = 30, height = 120 })` | flat-faced flattening punch: rectangle `x ∈ [−15, 15]`, `y ∈ [0, height]`; `tipAngle = 180`, `tipRadius = 0` (cannot air-bend — `toolAngleFeasible` rejects it). Family `'hemming'`. |

Every generator takes an optional `meta: { id?, name?, maxLoadPerMeter?, segmentLengths?, notes?, source? }`.
Generators never throw: non-finite / non-positive sizes fall back to the defaults, `tipAngle` is
clamped to [1, 180] and a negative tip radius becomes 0, so every generated profile is a simple
CCW polygon respecting its frame (property-tested over a sweep in `edge-cases.test.ts`).

### 1.2 Parametric dies (`dies.ts`) — return `Die`

- `vDie({ vWidth, vAngle = 88, shoulderRadius = 0, height, bodyWidth })`: V faces through the
  virtual sharp shoulders `(±V/2, 0)` at `β = vAngle/2` from vertical down to the bottom vertex
  `(0, −(V/2)/tan β)`. Shoulder fillets (when `rs > 0`) are arcs of radius `rs` tangent to the
  top surface and to the V face: centre `(±xc, −rs)`, `xc = V/2 + rs·(1 − sin β)/cos β` — the
  same circle `ramDepth()` uses. `height` / `bodyWidth` default to the standard formulas
  (`standardDieHeight(V)`, `standardDieBodyWidth(V)`, `standardShoulderRadius(V)`; exported).
  Polygon order (CCW): bottom left→right, right side up, top right→left through the notch, left
  side down. Guards (so the profile is always simple): `height ≥ vNotchDepth(V, angle) + 5` and
  `bodyWidth ≥ 2·(shoulderTangentX + 2)` — smaller requests are rounded up to 10 mm; the fillet
  radius is limited to `maxShoulderRadius(V, angle)` (the fillet takes at most half the V face);
  `vAngle` is clamped to [1, 180]. Standard dies are unaffected. Helpers `vNotchDepth`,
  `shoulderTangentX`, `maxShoulderRadius` are exported.
- `multiVDie({ vWidths = [16, 22, 35, 50], active = 0, vAngle = 88, size = 90 })`: 4-way
  block `size × size` (`bodyWidth = height = 90`) with `vWidths[active]` on top at the origin,
  `vWidths[(active+1)%4]` on the right side (+X), `+2` on the bottom, `+3` on the left; every V
  has `standardShoulderRadius(V)`. `vWidth/vAngle/shoulderRadius` describe the active V. The block
  grows (rounded up to 10 mm) when a V is too wide for its side or two opposite notches would meet.
- `hemmingDie({ width = 60, height = 60 })`: flat-topped block, origin at the centre of the top.
  `vWidth = 0`, `vAngle = 180`, `shoulderRadius = 0`, family `'hemming'` — never usable for
  air bending; the planner uses `hemFlattenForce` for it.

### 1.3 Fingers (`fingers.ts`) — return `Finger`
- `flatFinger({ stopHeight = 20, bodyDepth = 60, width = 30, height = 35 })`: `(0,0) (60,0)
  (60,35) (15,35) (0,20)` — stop face on x = 0, 45° chamfer from the stop face top to the body top.
- `steppedFinger({ stopHeight = 20, stepDepth = 25, height = 35, bodyDepth = 60, width = 30 })`:
  `(0,0) (60,0) (60,35) (25,35) (25,20) (0,20)` (the samples/tools/custom-finger.dxf shape).

### 1.4 Custom tools (`custom.ts`)

`normalizeProfile(points, { kind, referencePoint?, upDir = 'y+', mirrorX = false, scale = 1 })`
→ `{ profile, height, shift: Vec2, messages: Message[] }`:
1. scale every point; 2. translate `referencePoint → origin` (default reference, computed AFTER
   rotation/mirroring: punch = midpoint of the lowest vertex run (tip); die = detected V centre on
   the top surface (`deriveDieParams`), or the top-run midpoint when there is no notch; finger =
   lowest vertex of the front (min-x) face); 3. rotate so `upDir` becomes +Y (`'x+'` → +90°,
   `'y-'` → 180°, `'x-'` → −90°); 4. `mirrorX` (x → −x); 5. `dedupe(1e-3)` + `ensureCCW`;
6. y-extent rule: punch/finger `min y = 0`, die `max y = 0`; finger also `min x = 0` (stop face on
   x = 0) — any shift is applied and reported as `warnings.tool.profileShifted {kind, dx, dy}`
   (`shift` = the extra translation applied after the reference). `height` = y extent.
Messages (never throws): `warnings.tool.profileTooFewPoints` (error), `warnings.tool.profileDegenerate`
(error, area ≈ 0), `warnings.tool.profileSelfIntersecting` (error), `warnings.tool.profileInvalidPoints
{count}` (warning: non-finite points were dropped), plus the shift info above. A non-finite or
non-positive `scale` and a non-finite `referencePoint` are ignored.
`isSimplePolygon(poly)` (no non-adjacent edge crossings) is exported for the UI.

`createCustomPunch(profile, meta)`, `createCustomDie(profile, meta)`, `createCustomFinger(profile, meta)`
→ `Punch | Die | Finger` with `source: 'custom'`, `id = meta.id ?? 'custom:<uuid>'`
(`crypto.randomUUID`, fallback Math.random v4), `height` from the profile extent, and derived
parameters (any `meta` field overrides the derived value). The profile is first passed through
`enforceFrameExtents(points, kind)` (exported): a profile that violates its frame's extent rule
(punch/finger min y ≠ 0, finger min x ≠ 0, die max y ≠ 0) is translated to satisfy it; an
already-normalised profile is returned as the same array. (Only the extents are enforced — the
tip / V-centre x position comes from `normalizeProfile`'s reference point.)
- punch (`derivePunchParams` → `{ tipRadius, tipAngle, bodyWidth, tangCentreX, height, arcVertices,
  messages }`): the tip is the vertex within 0.05 mm of the origin, or the edge through the origin
  (a chord of an arc flattened with an odd segment count, or a flat face). Vertex with exterior
  turn < 0.5° or an edge whose ends both turn < 0.5° / > 50° ⇒ flat face: `tipAngle = 180`,
  `tipRadius = 0`. Vertex with turn > 50° ⇒ sharp: `tipRadius = 0`, `tipAngle` = interior angle.
  Otherwise a circle is fitted (Kåsa least squares) through the seed (tip vertex ± 1, or the chord
  ± 1) and grown on both sides while the next vertex lies within `0.02 + 0.01·r` of the circle;
  `tipRadius = r` (≤ 30 mm, else sharp) and `tipAngle` = angle between the two flank edges
  leaving the arc ends; `arcVertices` = the indices on the arc. The fit is accepted only when both
  flanks are tangent to the fitted circle at the arc ends (deviation ≤ 25°) and the resulting tip
  angle lies in [5°, 179°]; otherwise the seed was an obtuse SHARP vertex (three points always fit
  a circle) and the sharp/flat answer is returned (a 140° sharp tip ⇒ `tipRadius 0, tipAngle 140`,
  not "R12.4 / 0°"). Neither the origin's exact position on the arc nor the chord parity matters
  (tested with 2–24 chords, r 0.2–10). `bodyWidth` = x extent, `tangCentreX` = mid-x of the top
  run (`y ≈ height`). No vertex/edge at the origin ⇒ `warnings.tool.tipNotFound {distance}` and
  the LOWEST vertex (ties → nearest to x = 0) seeds the detection (a punch's tip is its lowest
  point), so a profile merely offset from the origin still derives its true tip. Defaults:
  `family 'custom'`, `maxLoadPerMeter 600` (`CUSTOM_DEFAULT_RATING`), `segmentLengths []`.
- die (`deriveDieParams`): top run = vertices within 0.005 mm of the max y; notch runs = CCW runs of lower
  vertices between two top vertices whose start x > end x (traversed right→left); the run
  straddling x = 0 (else the deepest) is the active V. On each side of the deepest vertex the V
  face = the longest non-horizontal edge; `vAngle` = angle between the two face directions,
  `vWidth` = distance between the face lines' intersections with `y = 0`, `shoulderRadius` = radius
  of the circle fitted through the vertices between the top vertex and the face start (0 when
  there are none / the fit is poor). No notch ⇒ `vWidth 0, vAngle 180, rs 0` + `warnings.tool.notchNotFound`.
  `bodyWidth` = x extent. Defaults: `family 'custom'`, `maxLoadPerMeter 600`. Limits: faces
  flatter than ~17° from horizontal read as top surface, so V angles above ~145° derive as "no
  notch" (set `vWidth/vAngle` in `meta`); a notch whose two shoulders are at different heights
  (offset dies) is not recognised either.
- finger (`deriveFingerParams`): `stopHeight` = top of the LOWEST chain of vertical edges on
  `x = 0` (the front face; a chamfer/radius of ≤ 2 mm under the face is tolerated — the chain then
  starts slightly above the origin); no such chain ⇒ `warnings.tool.stopFaceNotFound` and
  `stopHeight = min(height, 20)`; `bodyDepth` = max x; `width = meta.width ?? 30`.

### 1.5 Standard library (`standard.ts`) — `buildStandardLibrary(): ToolLibrary`
Ids (stable):
- punches: `std:punch-straight-88-r0.8`, `std:punch-straight-88-r0.2`, `std:punch-straight-85-r0.8`,
  `std:punch-gooseneck-88-r0.8`, `std:punch-acute-30-r0.8`, `std:punch-acute-28-r1` (numbers are
  printed without trailing zeros),
  `std:punch-radius-r3`, `std:punch-radius-r5`, `std:punch-radius-r10`, `std:punch-hemming`.
  Height 120. `segmentLengths` = `STANDARD_SEGMENT_LENGTHS` = 10,15,20,40,50,100,200,300,415,835,3000.
  `maxLoadPerMeter`: straight 1000, gooseneck 600, acute 400, radius 800, hemming 800.
- dies: `std:die-v<V>-88` for V ∈ {6,8,10,12,16,20,25,32,40,50,63,80}; `std:die-v12-85`,
  `std:die-v16-85`; `std:die-v12-30`, `std:die-v16-30` (acute); `std:die-multi-v16/22/35/50`
  (the 4-way block with that V active, 600 kN/m); `std:die-hemming` (800 kN/m).
  `bodyWidth = ceil10(max(60, V + 2·max(10, 0.25·V)))`, height 60 (V ≤ 25) / 90 (V ≤ 50) / 100;
  shoulder R = `round(V/10 to 0.5)` (V16 → 1.5, V12 → 1.0 — matches the samples' truth);
  `maxLoadPerMeter` V6 300, V8 400, V10 600, V ≥ 12 1000.
- fingers: `std:finger-flat`, `std:finger-stepped`.
- materials: `std:mild-steel` (420/0.44/1.5°/0.8), `std:stainless-304` (620/0.45/3°/1.5),
  `std:aluminium-5052-h32` (230/0.42/2°/1.5), `std:aluminium-6061-t6` (310/0.42/4.5°/3.0),
  `std:galvanised-steel` (as mild steel).
- machines: `std:machine-generic-100t` = `defaultMachine()`.
- `version: LIBRARY_VERSION (1)`, `revision: 0`, `updatedAt` ISO.

### 1.6 Checks (`checks.ts`)
- `toolLoadCheck(forcePerMeter, punch, die)` → `{ ok, percentOfTool, limitingTool, message? }`:
  `percent = 100·F/m ÷ min(punch.maxLoadPerMeter, die.maxLoadPerMeter)` (a rating of 0 = unrated =
  ignored); `ok = percent ≤ 100`; message `warnings.tool.overload {tool, percent}` (error) above
  100 %, `warnings.tool.loadNearLimit` (warning) above 90 %. A NaN or infinite load (e.g.
  `airBendForce` called with the hemming die's V = 0) is never OK (`percentOfTool = Infinity`,
  overload); a negative load counts as 0.
- `daylightCheck(machine, punch, die, partHeight, margin = 20)` → `{ ok, message? }`: the tool
  stack `holderHeight + die.height + punch.height` must fit the daylight
  (`warnings.machine.stackTooTall {stack, daylight}`) and the tip clearance at TDC
  (`daylight − stack`) must be ≥ `partHeight + margin` (`warnings.machine.daylight {partHeight, available}`).
- `strokeCheck(machine, punch, die, ramDepth)` → `{ ok, maxRamDepth, message? }`: ram depth
  reachable within the stroke (`warnings.machine.stroke {ramDepth, maxRamDepth}`); default
  machine + standard stack ⇒ `maxRamDepth = 20`.

### 1.7 Default setup (`setup.ts`)
- `segmentsForLength(length, available)` → greedy sectionalisation (largest first, repeats
  allowed, a small remainder fixed by splitting the last piece: 25 = 15 + 10); every multiple of 5
  ≥ 10 is exact with the standard pieces (3100 → 835,835,835,415,100,50,20,10).
- `pickDieForThickness(dies, t, vAngle = 88)` → the `'v'` die whose opening is closest to
  `recommendedV(t)` (t 2 → V16, 1.5 → V12, 1 → V8, 3 → V25, 6 → V63); ties go to the larger V;
  `vAngle = null` accepts any angle (< 180). Multi-V, hemming and U dies are never picked.
- `defaultToolSetup(library, machine, t, opts?)` → one station `S1` over the whole bed with
  `std:punch-straight-88-r0.8` (fallback: any straight punch, then any punch with `tipAngle < 180`)
  and the picked 88° die (fallback: the closest V of any angle), segments from the pieces ≤ 835
  (never the 3 m bar) — reproduces every sample's `expected.defaultSetup`; `null` when no tools
  fit. `opts.zStart/zEnd` are clamped to the bed. When the pieces cannot compose the station
  length within 0.5 mm (a bed that is not a multiple of 5 mm, e.g. 48 in = 1219.2 mm) the station
  is SHORTENED to the composed length (1215) so the result always passes `validateSetup`; a punch
  without pieces gets `segments: []` (one full-length piece).

---

## 2. `src/core/machine`

- `defaultMachine(): Machine` — "Generic 100t × 3100" exactly as ARCHITECTURE lists it
  (`id 'std:machine-generic-100t'` = `DEFAULT_MACHINE_ID`, backgauge `speed 300`,
  `fingerId 'std:finger-flat'`).
- `machineLevels(machine, dieHeight = 60, punchHeight = 120)` → `{ tableTopY, holderTopY, tdcClampY,
  bdcClampY, tipAtTdcY, maxRamDepth }` (machine Y, die shoulder plane = 0): `tableTopY =
  −(holderHeight + dieHeight)`, `tdcClampY = tableTopY + daylight`, `bdcClampY = tdcClampY − stroke`,
  `tipAtTdcY = tdcClampY − punchHeight`, `maxRamDepth = punchHeight − bdcClampY`. Default machine:
  table top −120, TDC 300, tip at TDC 180, max ram depth 20.
- `validateMachine(m, opts?)` → `Message[]` (`opts = { punchHeight = 120, dieHeight = 60,
  maxRamDepth = 15 }`): every dimension positive and finite (`warnings.machine.invalid {field}`,
  error); `clampFrontOffset ∈ [0, clampThickness]`; backgauge `xMin < xMax`, `rMin < rMax`,
  `zMin < zMax` (`warnings.machine.range {field}`); `fingerCount ≥ 1`; `distanceBetweenFrames ≤
  bedLength` and `zMax ≤ bedLength` (warnings); the daylight/stroke inequalities of types.ts:
  `stack ≤ daylight` (`warnings.machine.stackTooTall`) and `stroke ≥ (daylight − stack) + maxRamDepth + 5`
  (`warnings.machine.strokeTooShort {stroke, required}`). The default machine passes.
- `validateSetup(setup, machine, library)` → `Message[]`: `warnings.setup.noStations` (warning);
  per station: `duplicateStation`, `unknownTool {stationId, toolId}` (error), `stationReversed`,
  `stationOutsideBed {stationId, zStart, zEnd, bedLength}` (error), `segmentsMismatch {stationId,
  sum, length}` (error when |Σ − length| > 0.5), `segmentNotAvailable {stationId, length}`
  (warning), `stackTooTall {stationId, stack, daylight}` (error); `stationsOverlap {a, b}` (error)
  for EVERY overlapping pair (a station enclosing two others is reported against each);
  `mixedDieHeights` (warning); `machineMismatch`; `unknownFinger {fingerId}` (error).
- `machineObstacles(machine, setup, library, ramY, fingers)` → `MachineObstacle[]` =
  `{ id, kind: ObstacleKind, polygon: Polygon2 (CCW), zRange: [z0, z1] | 'full' }`:
  - per station: `punch:<id>` (profile translated by `(0, ramY − punch.height)`, x-mirrored when
    `punchFlipped`), `die:<id>` (profile at the origin, mirrored when `dieFlipped`), `clamp:<id>`
    (x from `tang − clampFrontOffset` to `tang + clampThickness − clampFrontOffset`, `tang =
    ±punch.tangCentreX`; y from `ramY` to `ramY + clampHeight`); station Z ranges;
  - `clamp:gap-<n>` centred at x = 0 for the bed portions not covered by a station;
  - `ram` (x ± thickness/2, y from `ramY + clampHeight` up by `ram.height`, 'full');
  - `holder` / `table` ('full'): table top at `−(holderHeight + dieHeight)` where `dieHeight` is
    the tallest mounted die (60 when no station);
  - `finger:<i>` per `FingerSetting` (profile translated by `(x, r)`, z `[z − width/2, z + width/2]`);
  - `backgauge-beam` ('full', only when fingers are given): x from `max(x_i) + bodyDepth` to
    `+ beamDepth`, y from `min(r_i)` to `max(r_i) + beamHeight`;
  - `frame:left` / `frame:right`: rectangles x from `throatDepth` to `throatDepth + FRAME_DEPTH`
    (2000), y from `tableTopY − table.height − 1000` to well above the ram, z
    `[frameLeft − FRAME_THICKNESS, frameLeft]` / `[frameRight, frameRight + FRAME_THICKNESS]`
    (5000 mm — finite stand-ins for the half-spaces, big enough for any sheet overhanging the
    bed) with `frameLeft = (bedLength − distanceBetweenFrames)/2`.
  Missing tools (unknown ids) are skipped — `validateSetup` reports them.

---

## 3. `src/core/library`

- `LIBRARY_VERSION = 1`, `STORAGE_KEY = 'pbsim.library.v1'`.
- `migrateLibrary(json: unknown): ToolLibrary` (throws `TypeError` for a non-object) and
  `migrateLibraryDetailed(json)` → `{ library, messages }`: accepts v0 objects (missing
  `version/revision/updatedAt`, tools without `kind/source/segmentLengths/maxLoadPerMeter/height`,
  profile points as `{x,y}` or `[x,y]`), fills every default (derived tool parameters via the
  custom-tool derivations, `maxLoadPerMeter` 600, `source` from the id prefix; a `std:` id whose
  record lacks `family`/`maxLoadPerMeter` takes them from the generated standard item), drops
  invalid items with `warnings.library.itemDropped {collection, index, reason}`, normalises
  profile winding AND the profile frame (`enforceFrameExtents`: an old die whose top sits at
  y = 65 is shifted to y = 0), sanitises numbers (negative / non-finite sizes, ratings, widths,
  `tipAngle`/`vAngle` outside [0, 180], `kFactor` outside (0, 1] → derived or default values),
  forwards the derivations' messages (`warnings.tool.tipNotFound/notchNotFound/stopFaceNotFound`
  tagged with `{collection, id}`), and sets `version = LIBRARY_VERSION`.
  `warnings.library.migrated {from, to}` is `info` for an older file and `warning` for a file
  from a NEWER app version (read best-effort). Unknown extra fields are dropped; machine numbers
  are kept as given (`validateMachine` is the check for those).
- `mergeLibraries(base, overlay)` → union by id (overlay wins); `withStandardItems(lib)` adds
  missing standard items.
- `class LibraryStore` — options `{ storage?: StorageLike | null, storageKey?, fetch?: FetchLike | null,
  remoteUrl = '/api/library', initial? }` (defaults: `globalThis.localStorage` / `globalThis.fetch`
  when present, guarded with try/catch — works in Node with `storage: null, fetch: null`; tests
  use a Map-backed storage and an in-memory fake server).
  - `get(): ToolLibrary` (snapshot; every change creates a new object, so zustand/React can
    compare by reference), `find(id)`, `upsert(item: Tool | Material | Machine)` (collection by
    shape: `collectionOf(item)`), `remove(id) → boolean`, `subscribe(fn) → unsubscribe` (called
    after every change with the new snapshot), `replace(lib)`, `resetStandardItems()` (regenerates
    every `std:` item from code, keeps custom items).
  - `loadLocal()` → `'loaded' | 'empty' | 'invalid' | 'unavailable'` (cache → state, migrated,
    standard items filled in), `saveLocal() → boolean`.
  - `load(): Promise<LoadResult { local, remote: 'loaded' | 'not-found' | 'unavailable' | 'disabled', messages }>`
    = local cache, then remote `GET` (404 ⇒ keep local; network error ⇒ `'unavailable'`), merged
    (remote wins for the same id, local-only items kept, revision = remote's) and re-cached.
  - `save(): Promise<SaveResult { local, remote: 'saved' | 'conflict-resolved' | 'conflict' | 'unavailable' | 'disabled' | 'error', revision, messages }>`
    = `saveLocal()` + remote `PUT` (JSON body with our `revision`); `409` ⇒ merge the returned
    server copy under our items (ours win), take its revision and retry once (a second 409 ⇒
    `'conflict'`, state keeps the merged copy for a later retry); on `200` the server body (bumped
    revision) replaces the state and the cache.
  - `exportJson(): string` (pretty JSON), `importJson(json, mode = 'merge' | 'replace')` runs
    `migrateLibraryDetailed` first and returns its messages (imported items win by id; `replace`
    keeps the standard items). It throws (`SyntaxError` / `TypeError`) for text that is not a JSON
    object — the UI catches and reports.
- Lookups (`lookup.ts`): `findPunch/findDie/findFinger/findMaterial/findMachine(lib, id)`,
  `findTool(lib, id)` — accept `Project.libraryOverlay`-shaped objects.

## 4. i18n keys introduced (for the ui module)
`warnings.tool.overload {tool, percent}`, `warnings.tool.loadNearLimit {tool, percent}`,
`warnings.tool.profileShifted {kind, dx, dy}`, `warnings.tool.profileTooFewPoints {count}`,
`warnings.tool.profileDegenerate`, `warnings.tool.profileSelfIntersecting`, `warnings.tool.profileInvalidPoints {count}`,
`warnings.tool.tipNotFound {distance}`, `warnings.tool.notchNotFound`, `warnings.tool.stopFaceNotFound`,
`warnings.machine.invalid {field}`, `warnings.machine.range {field}`,
`warnings.machine.framesWiderThanBed`, `warnings.machine.gaugeBeyondBed`,
`warnings.machine.stackTooTall {stack, daylight}`, `warnings.machine.strokeTooShort {stroke, required}`,
`warnings.machine.daylight {partHeight, available}`, `warnings.machine.stroke {ramDepth, maxRamDepth}`,
`warnings.setup.noStations`, `warnings.setup.duplicateStation {stationId}`,
`warnings.setup.unknownTool {stationId, toolId}`, `warnings.setup.stationReversed {stationId}`,
`warnings.setup.stationOutsideBed {stationId, zStart, zEnd, bedLength}`,
`warnings.setup.segmentsMismatch {stationId, sum, length}`, `warnings.setup.segmentNotAvailable {stationId, length}`,
`warnings.setup.stackTooTall {stationId, stack, daylight}`, `warnings.setup.stationsOverlap {a, b}`,
`warnings.setup.mixedDieHeights`, `warnings.setup.machineMismatch {setupMachineId, machineId}`,
`warnings.setup.unknownFinger {fingerId}`, `warnings.library.itemDropped {collection, index, reason, id?}`,
`warnings.library.migrated {from, to}`.

## 5. Tests
`npx vitest run src/core/tools src/core/machine src/core/library` — per-file unit tests plus
`edge-cases.test.ts` in each sub-module (reviewer additions: obtuse/offset tips, odd notches,
inch drawings, NaN points, parametric sweeps, non-multiple-of-5 beds, nested stations, clamp /
ram / frame collision semantics, hostile library JSON, store failure modes).

## 6. Notes for downstream modules
- planner: `machineObstacles` polygons are plain CCW `Polygon2` in machine XY; slice by
  `zRange` ('full' = every slice). Intended contacts (punch tip zone, die shoulders, finger stop
  face) are NOT excluded here — the planner excludes them per ARCHITECTURE. `ramY` is the clamp
  bottom = `punchTipY + punch.height`. Use `machineLevels(machine, die.height, punch.height)` for
  TDC (`tdcClampY`), the retract limit and `maxRamDepth`; `strokeCheck` for per-bend depth.
- planner: hemming tools have `vWidth 0 / vAngle 180` (die) and `tipAngle 180 / tipRadius 0`
  (punch): `toolAngleFeasible` rejects them for air bends, and `airBendForce` must not be called
  with the hemming die (V = 0 ⇒ Infinity) — use `hemFlattenForce` for `kind: 'hem-flatten'`.
  Identify the hemming station by `die.family === 'hemming'`.
- sim: draw punches translated by `(0, ramY − punch.height)` and mirrored in x when
  `punchFlipped` (`mirrorProfileX`), the clamp centred at `±tangCentreX`; the multi-V block's
  other three notches are part of its profile.
- ui: `normalizeProfile` messages with `severity 'error'` mean the profile is unusable; `'info'`
  shift messages are informational. `derivePunchParams(...).arcVertices` can highlight the
  detected tip arc in the preview.
