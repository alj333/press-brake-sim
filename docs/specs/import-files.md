# import-files — `src/core/import/` (except `recognize/`)

File importers: DXF flat patterns, DXF tool profiles, meshes (STL / OBJ / GLB / GLTF) and STEP.
Pure TypeScript except `mesh.ts` (three's `GLTFLoader` behind a dynamic import) and `step.ts`
(occt-import-js WASM: a module Web Worker in the browser, direct call in Node). Units: everything
returned is in **mm**; angles in degrees. Types from `src/core/types.ts`; geometry helpers from
`src/core/geom`. Nothing here depends on `bend`, `part`, `tools` or `recognize` (the recogniser
depends on this module, not the reverse — `importFile` never fills `ImportResult.recognized`;
the UI calls `recognizeSheet` on `result.mesh`).

Barrel `src/core/import/index.ts` (exact public names):

| export | signature |
|---|---|
| `importDxfFlat(text, opts)` | `(text: string, opts: DxfFlatOptions) => ImportResult` (sync) |
| `importToolProfileDxf(text, options?)` | `(text: string, options?: ParseDxfOptions) => ToolProfileImport` (sync) |
| `importMesh(buffer, ext, opts?)` | `(buffer: Uint8Array, ext: MeshExt, opts?: MeshOptions) => Promise<ImportedMesh>` |
| `importStep(buffer, name?)` | `(buffer: Uint8Array, name?: string) => Promise<ImportedMesh>` |
| `importFile(file, opts)` | `({ name, bytes }: ImportFileInput, opts: ImportFileOptions) => Promise<ImportResult>` |
| `ImportError` | `class ImportError extends Error { key; params?; toMessage(): Message }` |
| `weldMesh(positions, indices, tol?, faceGroups?)` | shared vertex welding (also used by the STEP worker) |
| `loadOcct`, `OCCT_PARAMS` | re-exported from `occt-loader.ts` (unchanged) |
| types | `DxfFlatOptions, ToolProfileImport, MeshExt, MeshOptions, ImportedMesh, ImportFileInput, ImportFileOptions, DxfUnits, ParseDxfOptions` |

```ts
interface DxfFlatOptions {
  thickness: number; materialId: string; name: string;
  defaultAngle?: number;                // default 90 (must be within (0, 180])
  defaultRadius?: number;               // default: air-bend rule (below)
  kFactor?: number;                     // default 0.44
  material?: { tensileStrength: number; minInnerRadiusFactor: number };   // for the radius rule
  id?: string;                          // FlatPattern.id, default = name
  units?: 'auto' | DxfUnits;            // default 'auto' ($INSUNITS / guess, §1.1); forces the drawing units
}
interface ParseDxfOptions { units?: 'auto' | DxfUnits }
interface ToolProfileImport { points: Polygon2; units: DxfUnits; warnings: Message[] }
type DxfUnits = 'mm' | 'in' | 'ft' | 'cm' | 'm' | 'yd' | 'mil' | 'uin' | 'um' | 'dm' | 'dam' | 'hm' | 'km';
type MeshExt = 'stl' | 'obj' | 'glb' | 'gltf';
interface MeshOptions { name?: string; units?: 'auto' | 'mm' | 'in' | 'm' | 'cm' }   // default 'auto'
interface ImportedMesh extends TriangleMesh { warnings: Message[] }   // still a TriangleMesh
interface ImportFileInput { name: string; bytes: Uint8Array }
interface ImportFileOptions extends Omit<DxfFlatOptions, 'name' | 'thickness' | 'materialId'> {
  thickness?: number;                   // required for a DXF (errors.import.badThickness otherwise); unused for meshes
  materialId?: string;                  // DXF only; '' when omitted (the UI sets flat.materialId)
  name?: string; meshUnits?: MeshOptions['units'];
}
```

Errors: unusable input throws `ImportError` (never a bare `Error`) with an i18n key under
`errors.import.*` and `params`; `toMessage()` gives a `Message` with `severity: 'error'`. Every
non-fatal issue is a `Message` in `warnings` (keys under `warnings.dxf.*`, `warnings.mesh.*`,
`warnings.step.*`, `severity: 'warning'` unless stated). The ui module must add en/th strings for
every key listed at the end of this document.

---

## 1. DXF (shared machinery, `dxf-common.ts`)

Parsing uses `dxf-parser` (`new DxfParser().parseSync(text)`); a parser exception, a `null`
result or a file without an ENTITIES section throws `errors.import.dxfParse { detail }`.

### 1.1 Units
`$INSUNITS` → scale to mm: 1 in (25.4), 2 ft (304.8), 4 mm (1), 5 cm (10), 6 m (1000),
8 µin, 9 mil, 10 yd, 13 µm, 14 dm, 15 dam, 16 hm, 17 km. Other known-but-unsupported values
(3 miles, 7 km …) → mm + `warnings.dxf.unitsUnknown { insunits }`.
`0` / absent = **unitless**: mm, unless the raw geometry's max extent is ≤ 12 units (a sheet-metal
part smaller than 12 mm is unrealistic, 12 in = 305 mm is not) ⇒ inches +
`warnings.dxf.unitsGuessed { units: 'in' }` (`severity: 'info'`). `options.units` (a `DxfUnits`)
overrides all of this without a warning (a unitless 24" plate, a wrong `$INSUNITS`). Everything
(points, text positions / heights, bend-note radii) is scaled before any tolerance is applied.
`FlatPattern.sourceUnits` is `'in'` for inches and `'mm'` otherwise; the exact unit name goes to
`provenance.units`.

**Text decoding** (`decodeDxfText(bytes)`): UTF-8 (BOM tolerated) when the bytes are valid UTF-8,
otherwise windows-1252 (the ANSI code page most DXF writers use — a "°" byte 0xB0 in a bend note).

**Raw pre-scan.** Before dxf-parser runs, the group codes are walked once to recover what the
parser drops: the extrusion direction (210/220/230) of `CIRCLE`, `ELLIPSE` and `TEXT` entities
(looked up later by entity ordinal within the ENTITIES section or the block; counters restart per
block traversal), and LWPOLYLINE vertex-identifier groups (code 91, AutoCAD 2010+), which are
removed because dxf-parser stops reading vertices at them.

### 1.2 Layer classification (`classifyLayer(name)` → `LayerClass`)
Case-insensitive, **prefix** match, checked in this order:
- bend layers: name starts with `IV_BEND` or `BEND` (covers `IV_BEND_DOWN`, `BEND_UP`, `BENDLINE`,
  `BEND_LINES`, `BEND LINES`, `BendLinesDown`, …) ⇒ `bend-down` when the name contains `DOWN`
  anywhere, else `bend-up`;
- `ignore`: `IV_ARC_CENTERS`, `IV_TANGENT`, `IV_FEATURE_PROFILES`, `IV_ALTREP`, `IV_TOOL_CENTER`,
  `IV_ROLL`, `IV_UNCONSUMED_SKETCHES`, `DIMENSION`, `TEXT`, `DEFPOINTS`, `NOTES`, `TITLE`, `BORDER`;
- `hole-hint`: `IV_INTERIOR_PROFILES`, `INTERIOR`, `INNER`, `HOLE`, `CUTOUT`, `CUT_OUT`, `CUT OUT`
  (geometry that is never chosen as the outline while any other loop exists);
- `outline-hint`: `IV_OUTER_PROFILE`, `OUTER`, `OUTLINE`, `CONTOUR`, `CUT`, `PROFILE` (geometry;
  preferred as the outline, see 2.1);
- everything else: `geometry` (`0`, …).

Entities inside a block on layer `0` inherit the INSERT's layer (DXF semantics).

### 1.3 Entities → paths
Every geometric entity becomes a `DxfPath { points: Vec2[]; closed: boolean; layer; type;
handle }` in mm (chord tolerance 0.05 mm, via `arcToPoints` / `bulgeArcToPoints`):
- `LINE` → 2 points, open. `LWPOLYLINE` / `POLYLINE` (2D; z dropped) → vertices with bulge arcs
  expanded (`shape` flag or first ≈ last ⇒ closed). `ARC` → open (dxf-parser gives start/end in
  radians, CCW). `CIRCLE` → closed full circle. `ELLIPSE` → sampled at ≤ 0.05 mm chord error from
  `center`, `majorAxisEndPoint`, `axisRatio`, parameter range (closed when the range is 2π).
- `SPLINE` → De Boor evaluation of the (non-rational: dxf-parser drops weights) B-spline from
  control points / knots / degree, sampled every ≈ 0.5 mm of control-polygon length (≥ 16
  samples) and thinned with Douglas–Peucker at 0.01 mm; only fit points ⇒ polyline through
  them; invalid knots ⇒ the control polygon + `warnings.dxf.splineApprox`. `closed` flag ⇒ closed.
- `INSERT` → the block's entities transformed by `T(position) · R(rotation) · S(xScale, yScale)
  · T(−block.basePoint)`, recursively (depth ≤ 8), with `columnCount × rowCount` arrays at
  `columnSpacing` / `rowSpacing`; a missing block ⇒ `warnings.dxf.blockMissing { name }`. A negative
  scale flips arc directions (points are transformed after flattening, so this is automatic).
- OCS extrusion `(0, 0, −1)` on ARC / CIRCLE / LWPOLYLINE / POLYLINE / INSERT (its insertion point
  is in OCS, so the whole inserted block is mirrored) / TEXT mirrors x (arbitrary-axis algorithm
  for the ±Z cases). ELLIPSE is a WCS entity: a −Z extrusion only flips its minor axis (N × major),
  i.e. an elliptical arc goes to the other side of the major axis. Any other non-Z extrusion ⇒
  `warnings.dxf.nonPlanar { type }` (once per type) and the entity is used as drawn.
- `TEXT` / `MTEXT` are collected separately (`DxfText { text, position, height, layer }`; MTEXT
  formatting codes `\A1;`, `{}`, `\P`, `\~` stripped, `%%d` → `°`, `\U+XXXX` decoded). Justified /
  aligned TEXT (72/73 ≠ 0) is positioned by its second alignment point (11); fit / aligned text by
  the midpoint of the two points.
- `POINT`, `DIMENSION`, `SOLID`, `3DFACE`, `ATTDEF` are ignored; entity types dxf-parser does not
  know (HATCH, …) never reach us.

### 1.4 Chaining (`chainLoops(paths, opts)`) — 0.01 mm
Closed paths are loops as they are. **Double-drawn entities** (an open path whose points equal
another's within tol, forward or reversed; a closed loop equal to an existing one up to a cyclic
shift / reversal) are dropped first — they would otherwise hijack the chain at their shared end
points — and counted once in `warnings.dxf.duplicateEntities { count }` (`severity: 'info'`). Two
different arcs between the same end points (a lens) are not duplicates. Open paths are joined end
to end through a spatial hash of their end points (cell = tol, 9-cell lookup): starting from an
unused path, the chain grows at its
tail with the unused path whose nearest end point lies within `tol` (closest wins), then the same
backwards from the head, until nothing matches. Head–tail gap ≤ tol ⇒ closed loop; ≤ `closeTol`
(0.5 mm) ⇒ closed with `warnings.dxf.loopClosed { gap }`; otherwise the chain is dropped with
`warnings.dxf.openChain { length, gap, layer }`. Loops are `dedupe`d (tol), and dropped when they
have < 3 points or |area| < 1e-6 mm² (`warnings.dxf.tinyLoopDropped { count }`, once).

---

## 2. `importDxfFlat(text, opts): ImportResult` (`dxf-flat.ts`)

### 2.1 Outline and holes
Paths on `geometry`, `outline-hint` and `hole-hint` layers are chained (1.4). The **outline** is
the largest loop by area among the `outline-hint` loops when any exist, else among the loops that
are not `hole-hint`, else among all loops (CCW via `ensureCCW`). Every other loop is a **hole**
(CW) when at least half of its vertices lie inside the outline; loops outside the outline are
dropped with `warnings.dxf.loopOutsideOutline { layer }`. No loop at all ⇒ throws
`errors.import.dxfNoOutline`. Holes crossing the outline are not detected here (core-geometry
reports `holeDropped`).

### 2.2 Bend lines
Every straight open path on a bend layer — a LINE, or a polyline whose interior vertices lie on
the chord within 0.01 mm — is a `BendLine` (ids `B1, B2, …` in file order); bent polylines or
closed paths on bend layers ⇒ `warnings.dxf.bendEntityIgnored { type, layer }`. Exact
duplicates (same end points within 0.01 mm, either order) are merged. `direction` from the layer
(`sources.direction = 'dxf'`, `geometry = 'dxf'`); `angle = opts.defaultAngle ?? 90`
(`sources.angle = 'default'`); `innerRadius = opts.defaultRadius ??` the air-bend rule with an
unknown V = 8·t: `max(0.16·8t·Rm/420, minR·t)` with `Rm = material.tensileStrength ?? 420`,
`minR = material.minInnerRadiusFactor ?? 0.8` (mild steel ⇒ 1.28·t), rounded to 0.01
(`sources.radius = 'default'`); `kFactor = opts.kFactor ?? 0.44`. No bend line at all ⇒
`warnings.dxf.noBendLines` (`severity: 'info'`; the UI lets the user add bends).

**Trim / extend to the outline.** For each bend line the crossings of its infinite line with the
outline edges are collected as parameters `s` along the line (vertex-on-line crossings counted
once). Per end (`p0` at `s = 0`, then `p1` at `s = len`): an end lying on the boundary
(`classifyPoint === 'edge'`, 1e-6) stays; any other end — inside the material or outside it (a
relief slot, an overshoot) — moves to the **nearest crossing in either direction** that keeps the
line ≥ 0.01 mm long (the minimal change that puts the end on the outline). Moves > 0.1 mm are
reported as `warnings.dxf.bendTrimmed { bendId, end, amount }` (the line got shorter at that end)
or `warnings.dxf.bendExtended { … }` (longer); smaller moves are silent snaps. Consequences: a
line overshooting the part by 5 mm is trimmed to the edge; a line 2 mm short of the edges is
extended; a line drawn exactly across relief slots (CAD style) is untouched; a line overshooting
across the slots into the plate arms is pulled back to the slot edges (not extended through the
plate); a line stopping 0.05 mm short is snapped silently. A line with no usable crossing is left
as drawn (core-geometry then reports `bendEndInMaterial` / `bendNoMaterial`). A degenerate result
is dropped with `warnings.dxf.bendDegenerate { bendId }`.

**Bend notes.** `TEXT` / `MTEXT` on bend layers are parsed: direction `UP` / `DOWN` (word),
angle `<number>°` / `<number> DEG` / `A=<number>` (bend angle from flat, 0–180; `UP 45` without a
degree sign also works), radius `R <number>` / `R=<number>` **in the drawing's units** (scaled to
mm: an inch note `R 0.06` gives 1.524 mm), k-factor `K=<number>`. A note is assigned to the
nearest bend line (distance from the text insertion point to the segment) when that distance ≤
max(20 mm, 5·textHeight); parsed values set `angle` / `innerRadius` / `kFactor` / `direction`
with source `'dxf'`. Direction from a note contradicting the layer ⇒ the note wins +
`warnings.dxf.bendTextConflict { bendId }`. A note matching nothing ⇒
`warnings.dxf.bendTextUnassigned { text }`. Angle 180 ⇒ `hem: 'closed'`.

### 2.3 Result
`ImportResult.flat = { id, name, thickness, materialId, outline, holes, bends, sourceUnits,
provenance: { file, format: 'dxf', units, insunits, outlineLayer, bendLayers, layers }, warnings }`
(`flat.warnings` and `ImportResult.warnings` are the same array). Nothing is re-centred: FLAT
coordinates are the DXF coordinates in mm (the UI may translate).

Sample results (tests): every `samples/<name>/<name>-flat.dxf` reproduces the truth outline bounds
and bend end points / directions within 0.05 mm; holes: L-bracket 1, tabbed-plate 1 (circles
flattened at 0.05 mm chord error: Ø10 → 23 points, Ø8 → 20 points), others 0; every imported
sample builds a `PartModel` (core-geometry) with the truth's flange count and no warnings.

---

## 3. `importToolProfileDxf(text): ToolProfileImport` (`dxf-profile.ts`)
All geometry paths except `ignore` layers (bend layers count as geometry here) are chained (1.4).
Exactly one loop ⇒ its points; several ⇒ the largest + `warnings.dxf.multipleProfiles { count }`;
none ⇒ throws `errors.import.dxfNoProfile`. Points are in mm, `dedupe`d and `simplifyCollinear`ed
at 1e-6, CCW; no translation (the user picks the reference point / orientation in the UI via
`normalizeProfile`). `units` = the detected DXF unit. Sample profiles: `custom-finger.dxf` → 6
points, x ∈ [0, 60], y ∈ [0, 35]; `custom-gooseneck-punch.dxf` → 11 points, x ∈ [−12, 26],
y ∈ [0, 120]; `custom-v16-die.dxf` → 7 points, x ∈ [−30, 30], y ∈ [−60, 0].

---

## 4. Meshes (`mesh.ts`, `stl.ts`, `obj.ts`, `weld.ts`)

`importMesh(buffer, ext, opts?)` → `ImportedMesh` (mm, welded, `units: 'mm'`, `name = opts.name ??
ext`; `normals` omitted — consumers compute triangle normals from positions).
- **STL** (`stl.ts`, pure): binary when `byteLength === 84 + 50·n` (n = uint32 at 80) — the
  "solid" prefix alone does not make a file ASCII; else ASCII (`vertex x y z` triplets per facet,
  any whitespace, `facet normal` optional). Bad counts / not a multiple of 3 vertices ⇒
  `errors.import.stlInvalid`.
- **OBJ** (`obj.ts`, pure): `v x y z [w]`, `f` with `v`, `v/vt`, `v//vn`, `v/vt/vn`, negative
  (relative) indices, polygons fan-triangulated; everything else ignored. Out-of-range indices ⇒
  `errors.import.objInvalid { line }`.
- **GLB / GLTF**: the file is first normalised by `normalizeGltf` (`gltf.ts`, pure TS) into a
  self-contained GLB: every buffer (the GLB BIN chunk and/or `data:` URIs) merged into one BIN
  chunk with the bufferViews re-based, and `materials / textures / images / samplers / skins /
  animations` removed (geometry only — this also keeps three's `FileLoader` out of the picture, so
  nothing is fetched and the loader behaves identically in Node and in the browser). Then
  `await import('three/examples/jsm/loaders/GLTFLoader.js')`, `loader.parse(glb, '', …)`; every
  `Mesh` in the scene (after `updateMatrixWorld`) is baked through its `matrixWorld` (instanced
  meshes per instance) and appended, indexed or not. External `.bin` references, Draco / meshopt
  compression, bad JSON or a non-2.x asset fail with `errors.import.gltfUnsupported { detail }`.
- **Units** (`opts.units`, default `'auto'`): `'auto'` ⇒ if the bounding box's largest extent
  < 5 the file is taken as **metres** and scaled ×1000 with `warnings.mesh.unitsScaled { factor:
  1000, assumed: 'm' }`; explicit `'in'` ×25.4, `'cm'` ×10, `'m'` ×1000 (no warning).
- Empty mesh (0 triangles) ⇒ `errors.import.meshEmpty`.

`weldMesh(positions, indices, tol = 1e-3, faceGroups?)` → `{ positions, indices, faceGroups?,
degenerate }`: vertices within `tol` (grid hash on `round(x/tol)` with a 27-cell neighbourhood
check on misses — exact duplicates hit the fast path) share one index; triangles with two equal
indices after welding are removed (`degenerate` = their count, `warnings.mesh.degenerateTriangles
{ count }` when > 0) and `faceGroups` are remapped to the surviving triangle numbering (a group
left empty is dropped). Sample STLs: welded vertex count (≈ 392 for the L-bracket) < raw count
(3·n).

---

## 5. STEP (`step.ts`, `step.worker.ts`)

`importStep(buffer, name = 'step')` → `ImportedMesh` with `faceGroups`.
- Node (no `window` / `Worker`): `readStepHere(buffer)` = `const occt = await loadOcct();
  occt.ReadStepFile(buffer, OCCT_PARAMS)` → merge → weld, all in-process.
- Browser: `new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' })`; the
  worker (`step.worker.ts`) imports `loadOcct` / `OCCT_PARAMS`, `mergeOcctMeshes` and `weldMesh`,
  receives `StepWorkerRequest { buffer }` (a copy, transferred) and posts `StepWorkerResponse`:
  `{ ok: true, positions, indices, faceGroups, meshCount, degenerate, droppedGroups,
  rawVertexCount }` with the two array buffers transferred, or `{ ok: false, key, params, error }`
  (an `ImportError` key when the failure is typed, `errors.import.stepFailed` otherwise). The main
  thread re-throws it as an `ImportError`, maps a worker `onerror` to `errors.import.workerFailed
  { detail }`, and always terminates the worker. When the worker itself fails to start or load
  (`workerFailed`: module workers unsupported, CSP, bundling) `importStep` falls back to
  `readStepHere` on the calling thread; typed STEP errors are re-thrown. `occt-loader.ts` now detects **Node** positively
  (`process.versions.node`) instead of the browser (`window`), because a module worker has no
  `window` / `document` and must take the browser (Vite `?url` wasm) path.
- `mergeOcctMeshes(result)` (pure, `step-merge.ts`, shared): `success === false` or no meshes ⇒
  `errors.import.stepFailed`; all meshes concatenated (positions in mm — `OCCT_PARAMS.linearUnit =
  'millimeter'` — indices offset by prior vertex counts); `faceGroups` = every `brep_faces[{first,
  last}]` (triangle indices, inclusive) offset by the prior meshes' triangle counts; then
  `weldMesh(…, 1e-3, faceGroups)`. `faceGroups` is omitted (not `[]`) when occt reported no B-rep
  faces, so a faceGroups-driven recognizer falls back to normal continuity instead of seeing no
  faces. Several meshes ⇒ `warnings.step.multipleBodies { count }`
  (`'info'`). Sample: L-bracket → 11 face groups, 404 triangles, bounds 60 × 40 × 80, and after
  welding every edge is shared by exactly two triangles (V − E + F = 0 for the holed solid).
  Verified in headless Chromium through the bundled worker (scratch/import-smoke): `faces=11
  tris=404`.

---

## 6. `importFile({ name, bytes }, opts): Promise<ImportResult>` (`index.ts`)
Dispatch on the lower-cased extension (`splitFileName` strips directories): `dxf` →
`importDxfFlat(decodeDxfText(bytes), { …opts, name: opts.name ?? basename, thickness: opts.thickness
?? 0 (⇒ badThickness), materialId: opts.materialId ?? '' })` → `{ flat, warnings }`
(`warnings` is the same array as `flat.warnings`); `stl | obj | glb | gltf` → `importMesh(bytes,
ext, { name, units: opts.meshUnits })` → `{ mesh, warnings }`; `step | stp` → `importStep` →
`{ mesh, warnings }`; anything else throws `errors.import.unsupportedExtension { ext }`. The
`mesh` in the result is a plain `TriangleMesh` (the importer's `warnings` field is moved to
`ImportResult.warnings`). `ImportResult.recognized` is never set here — the UI runs
`recognizeSheet(result.mesh)` (recognize-3d). Tool profiles are imported through
`importToolProfileDxf` by the tool-library UI, not through `importFile`.

Extra exports of the barrel (beyond the ARCHITECTURE names): `parseBendNote`,
`defaultInnerRadius`, `classifyLayer`, `parseDxf`, `chainLoops`, `decodeDxfText`, `finishMesh`,
`METRES_EXTENT_LIMIT`, `parseStl`, `parseObj`, `normalizeGltf`, `weldMesh`, `positionsBounds`,
`WELD_TOL`, `readStepHere`, `mergeOcctMeshes`, `splitFileName`, `loadOcct`, `OCCT_PARAMS`.

---

## 7. i18n keys introduced (ui adds en/th)
Errors (`ImportError.key`): `errors.import.dxfParse {detail}`, `errors.import.dxfNoOutline`,
`errors.import.dxfNoProfile`, `errors.import.badThickness {thickness}`, `errors.import.stlInvalid
{detail}`, `errors.import.objInvalid {line}`, `errors.import.gltfUnsupported {detail}`,
`errors.import.meshEmpty`, `errors.import.stepFailed {detail}`,
`errors.import.unsupportedExtension {ext}`, `errors.import.workerFailed {detail}`.
Warnings: `warnings.dxf.unitsGuessed {units}`, `warnings.dxf.unitsUnknown {insunits}`,
`warnings.dxf.loopClosed {gap}`, `warnings.dxf.openChain {length, gap, layer}`,
`warnings.dxf.tinyLoopDropped {count}`, `warnings.dxf.duplicateEntities {count}` (info),
`warnings.dxf.loopOutsideOutline {layer}`,
`warnings.dxf.noBendLines`, `warnings.dxf.bendEntityIgnored {type, layer}`,
`warnings.dxf.bendTrimmed {bendId, end, amount}`, `warnings.dxf.bendExtended {bendId, end,
amount}`, `warnings.dxf.bendDegenerate {bendId}`, `warnings.dxf.bendTextConflict {bendId}`,
`warnings.dxf.bendTextUnassigned {text}`, `warnings.dxf.blockMissing {name}`,
`warnings.dxf.nonPlanar {type}`, `warnings.dxf.splineApprox`, `warnings.dxf.multipleProfiles
{count}`, `warnings.mesh.unitsScaled {factor, assumed}`, `warnings.mesh.degenerateTriangles
{count}`, `warnings.mesh.primitivesSkipped {count}`, `warnings.step.multipleBodies {count}`.
