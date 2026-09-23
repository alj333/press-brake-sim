# ui — `src/app`, `src/i18n`, `src/index.css`

The bilingual (English / Thai) React UI of ARCHITECTURE "UI": a zustand project store that
wires every core module together (import → recognise → part model → tool setup → planner →
timeline → sim store), the i18n layer, and the panels. Depends on every other module through
their barrels only (`src/core/import`, `src/core/import/recognize`, `src/core/part`,
`src/core/bend`, `src/core/tools`, `src/core/machine`, `src/core/library`, `src/core/planner`,
`src/sim`) plus `src/core/types`. Units: mm, degrees, kN (with a tonne readout: 1 t = 9.80665 kN).
Public API: `<AppRoot/>` (`src/app/App.tsx`) — the integrator points `main.tsx` at it.
`src/App.tsx`, `src/main.tsx`, `index.html` and `public/**` are not touched.

Files:

| file | content |
|---|---|
| `src/i18n/index.ts` | `translate`, `t` helpers, `LanguageProvider`, `useI18n`, `tm`, `LANGUAGES`, dictionaries |
| `src/i18n/en.json`, `src/i18n/th.json` | flat `{ "dot.key": "text" }` dictionaries (identical key sets) |
| `src/app/store.ts` | `useProjectStore` (zustand), `libraryStore` (a `LibraryStore` singleton), `newProject()` |
| `src/app/project.ts` | project (de)serialisation, library overlay, program JSON / CSV export, file download helper |
| `src/app/format.ts` | number formatting (`fmt`, `fmtAngle`, `kNToTonnes`, …) |
| `src/app/App.tsx` | `<AppRoot/>`: language provider + shell (header, three columns, keyboard shortcuts) |
| `src/app/panels/PartPanel.tsx` | import drop zone / inputs, sample menu, material + thickness, bends table, `<FlatView/>` |
| `src/app/panels/ToolsPanel.tsx` | stations, punch/die/finger pickers, `<ProfilePreview/>`, library manager, `<CustomToolDialog/>` |
| `src/app/panels/CustomToolDialog.tsx` | DXF → `importToolProfileDxf` → reference / up / mirror → `normalizeProfile` → metadata → `createCustom*` |
| `src/app/panels/MachinePanel.tsx` | machine picker + grouped form + `validateMachine` messages + save as new |
| `src/app/panels/SequencePanel.tsx` | Plan button + options, step cards, drag-reorder → `fixedOrder` |
| `src/app/panels/ProgramPanel.tsx` | printable bilingual program table, export JSON / CSV, print |
| `src/app/components/*.tsx` | `Tabs`, `MessageList`, `NumberField`, `SourceBadge`, `FlatView`, `ProfilePreview`, `Dialog`, `FileDrop`, `Toasts` |
| `src/index.css` | design tokens, layout, panels, tables, dialogs, print stylesheet, Sarabun `@font-face` |
| tests | `src/i18n/i18n.test.ts`, `src/app/store.test.ts` (`// @vitest-environment jsdom`) |

---

## 1. i18n (`src/i18n`)

- Dictionaries are flat JSON maps. `en.json` is the reference: **every key of `en.json` exists in
  `th.json` and vice versa** (tested), and every string literal passed to `t('…')` / `tm` keys in
  `src/app` and `src/sim`, plus every `warnings.*`, `collisions.*` and `errors.*` key emitted by
  `src/core` (scanned by regex in the test), exists in `en.json`. Key families: `app.*` (shell),
  `part.*`, `tools.*`, `machine.*`, `sequence.*`, `program.*`, `common.*`, `sim.*` (the sim-3d
  labels, English defaults = `simLabelsEn`), `warnings.*`, `collisions.*`, `errors.*`,
  `severity.*`, `source.*`, `turn.*`, `phase.*`, `family.*`, `contact.*`, `ref.*`.
- `translate(lang, key, params?)`: looks the key up in the language, then in English, else returns
  the key itself. Interpolation replaces `{{name}}` **and** `{name}` (the sim's convention) with
  `String(params[name])`; numbers are printed as given (callers round). Unknown params stay as
  written.
- `t(key, params?)` = `translate(currentLanguage, …)` where `currentLanguage` is the last language
  set through `setGlobalLanguage(lang)` (the store calls it) — for non-React code (toasts, CSV
  headers). `tm(message)` = `t(message.key, message.params)`; `translateMessage(lang, message)`
  for an explicit language.
- React: `<LanguageProvider language onChange?>` provides `{ lang, t, tm, setLanguage }` through
  context; `useI18n()` reads it (a default English context exists so components render without
  a provider). `LANGUAGES = ['en', 'th']`, `languageName(lang)`.
- Thai strings use the shop-floor register: เครื่องพับ (press brake), พันช์ (punch), ดาย (die),
  แบ็คเกจ / ตัวหยุดหลัง (backgauge / finger), ความหนา, มุมพับ, มุมภายใน, รัศมีด้านใน, แรงกด (kN / ตัน),
  ลำดับการพับ, พลิกชิ้นงาน, หมุนชิ้นงาน 180°, ระยะกดลง.

## 2. Project store (`src/app/store.ts`)

`libraryStore = new LibraryStore()` (browser defaults: localStorage + `/api/library`; in tests the
store is created with `storage: null, fetch: null` through `createProjectStore(opts)`). The zustand
store mirrors its snapshot in `library` (subscription) and exposes:

```ts
interface ProjectState {
  project: Project;                       // types.ts Project (version 1)
  library: ToolLibrary;                   // libraryStore.get() snapshot
  thickness: number;                      // sheet thickness used for DXF imports / new flats (mm)
  dxfFlat: FlatPattern | null;            // the last imported DXF flat (geometry source)
  recognized: RecognizedSheet | null;     // the last recognised 3D model
  mesh: TriangleMesh | null;
  importWarnings: Message[];              // importer + recogniser + match messages of the last import
  importing: boolean;
  planning: boolean;
  planProgress: PlannerProgress | null;
  planError: Message | null;
  fixedOrder: string[] | null;            // mirrors project.plannerOptions.fixedOrder
  selectedBendId: string | null;
  selectedStepIndex: number | null;
  dxfUnits: 'auto' | DxfUnits;            // import overrides
  meshUnits: MeshUnits;
  notices: Notice[];                      // toasts { id, message, severity }
  activeLeftTab: 'part' | 'tools' | 'machine';
  activeRightTab: 'sequence' | 'program';
}
```

Actions (all synchronous unless noted; every part change rebuilds the `PartModel` with
`buildPartModel` and clears the program + sim keyframes; every program change pushes
`buildTimeline(...)` keyframes into `useSimStore`):

- `importFiles(files: File[]): Promise<void>` — reads each file, then `importInputs(inputs)`:
  DXF → `importFile` with `{ thickness, materialId, kFactor, material, units }` → `dxfFlat`; if a
  recognised model exists `matchToDxf(recognized, flat).flat` is used, else the DXF flat.
  STEP / STL / OBJ / GLB / GLTF → `importFile` (mesh) → `recognizeSheet(mesh, { materialId, kFactor,
  thicknessHint, name })` → `thickness = rec.thickness` (when > 0) → if a DXF flat is loaded
  `matchToDxf(rec, dxfFlat).flat` else `rec.flat`. DXF files are processed before meshes so the
  drawing is the geometry source and the 3D model supplies angle / radius / direction. `ImportError`
  → `err.toMessage()` in `importWarnings` + a toast; other errors → `errors.import.unknown`.
- `loadSample(name)` — `fetch('/samples/<name>/<name>-flat.dxf')` and `.step` → `importInputs`
  (a failed fetch → `errors.app.fetchFailed`).
- `loadFlat(flat)` — replaces the part from a ready `FlatPattern` (tests, sample truth files).
- `setBend(id, patch)` (fields of `BendLine`; changed attributes get `sources.* = 'user'`),
  `addBend(p0, p1, direction?)` (id = next free `B<n>`, defaults angle 90, ri from the material's
  air-bend rule, k = material k), `removeBend(id)`, `setBendAngleCorrection(id, deg)`.
- `setMaterial(id)` (updates `project.materialId` and `flat.materialId`, rebuilds),
  `setThickness(t)` (rebuilds the part with the new `flat.thickness`), `setPartName(name)`.
- `setSetup(setup)`, `addStation()` (next free `S<n>` in the largest free Z gap, default
  punch/die of `defaultToolSetup`), `updateStation(id, patch)`, `removeStation(id)`,
  `resetSetup()` (= `defaultToolSetup(library, machine, thickness)`).
- `setMachine(id)` (machine from the library; the setup's `machineId` follows), `updateMachine(patch)`
  (deep partial of the current machine; upserted into the library store as the same id),
  `saveMachineAs(name)` (copy with a `custom:` id).
- `plan(): Promise<void>` — `setTimeout(0)` so React paints the busy state, then `planProgram(input,
  signal, onProgress)`; `cancelPlan()` aborts the signal (the abort is honoured between step
  evaluations). Success → `project.program`, sim keyframes, `activeRightTab = 'sequence'`;
  `AbortError` → silent; `RangeError` / other → `planError` (`errors.plan.failed {detail}`).
- `setFixedOrder(ids | null)` then re-plan is the Sequence panel's drag-reorder; `null` = Auto.
- `setPlannerOptions(patch)`.
- `saveProject(): string` (JSON of `Project` with `libraryOverlay` = every referenced item
  (setup tools, machine, material, finger) plus every custom item), `loadProject(json)` (validates
  the shape, upserts the overlay's custom items into the library, rebuilds the part from
  `part.flat`, keeps the program and rebuilds the timeline; throws `Error` with an i18n key on bad
  input), `newProject()`.
- `setLanguage(lang)`, `selectBend(id)`, `selectStep(i)` (also seeks the sim),
  `setLeftTab / setRightTab`, `setDxfUnits / setMeshUnits`, `dismissNotice(id)`, library:
  `upsertLibraryItem(item)`, `removeLibraryItem(id)`, `saveLibrary()` (→ `libraryStore.save()` with
  a toast on conflict / unavailable), `loadLibrary()`, `exportLibraryJson()`, `importLibraryJson(json,
  mode)`, `resetStandardItems()`.

The store never mutates a `PartModel`, program, keyframe or library item in place.

## 3. Layout (`App.tsx`)

`<AppRoot/>` = `<LanguageProvider>` + shell: header (app name, project name input, language toggle
`data-testid="language-toggle"`, New / Save / Load project buttons), three columns on a CSS grid
(`minmax(300px, 360px) 1fr minmax(320px, 400px)` at ≥ 1280 px; `280px 1fr 320px` between 1024 and
1279 px; stacked below 1024 px) — left `<Tabs>` Part / Tools / Machine (`data-testid="tab-part"`,
`tab-tools`, `tab-machine`), centre `<SimViewport>` (dark frame) + `<SectionView>` (shown by the
sim store's `showSection` as a full-width strip under the viewport) + `<TransportBar t hideSteps>`,
right `<Tabs>` Sequence / Program (`tab-sequence`, `tab-program`). Keyboard: Space = play/pause,
← / → = previous / next phase (ignored while typing in inputs, selects, textareas, dialogs).
Toasts bottom-right. The `library`, `setup` and `machine` objects passed to the sim components are
referentially stable per store state (memoised `Pick`).

## 4. Panels

- **Part**: `<FileDrop>` (drag & drop + `<input type="file" data-testid="import-3d">` accepting
  `.step,.stp,.stl,.obj,.glb,.gltf` and `data-testid="import-dxf"` for `.dxf`), units overrides,
  `Load sample` menu (`data-testid="sample-<name>"` for the 7 `SAMPLE_NAMES`), part name, material
  `<select>`, thickness `<NumberField>`, import / part warnings (`<MessageList>`), recognition
  confidence, `<FlatView>` (canvas: outline, holes, bend lines coloured up = blue / down = orange,
  selected bend highlighted, click to select, "add bend" mode = click two points on the flat,
  snapping to outline vertices within 3 px) and the bends table (`data-testid="bend-row-<id>"`):
  id, direction toggle, angle, inner radius, k, correction, length, `<SourceBadge>` per attribute
  (dxf / step / mesh / user / default), delete. `Add bend` toggles the two-click mode.
- **Tools**: station list (`data-testid="station-<id>"`): Z start / end, segments editor (text
  `835, 835, …` parsed to numbers; "auto" fills from the punch's segment lengths), punch and die
  `<select>` grouped by family (`<optgroup>`), flip toggles, remove; `Add station`, `Reset to
  default`; `validateSetup` messages; `<ProfilePreview>` canvases of the selected station's punch
  and die (tip arc highlighted from `derivePunchParams(...).arcVertices`); finger picker (machine
  `backgauge.fingerId`); library section: custom tools list with remove, `Add custom tool` dialog
  (`data-testid="custom-tool-dialog"`; fields `custom-tool-file`, `custom-tool-kind`,
  `custom-tool-name`, `custom-tool-rating`, `custom-tool-segments`, `custom-tool-updir`,
  `custom-tool-mirror`, `custom-tool-scale`, punch `custom-tool-tip-angle` / `custom-tool-tip-radius`,
  die `custom-tool-v-width` / `custom-tool-v-angle`, `custom-tool-save`): DXF upload →
  `importToolProfileDxf(text, { units })` → preview → click a reference point on the canvas (or
  auto) + up direction + mirror + scale → `normalizeProfile` (messages shown; `error` disables
  save) → `createCustomPunch/Die/Finger(profile, meta)` → `upsertLibraryItem` + `saveLibrary`;
  `Export library` (`data-testid="export-library"`) / `Import library` (file input, merge) /
  `Reset standard items`.
- **Machine**: `<select>` of `library.machines`, grouped `<NumberField>` form for every `Machine`
  field (general, ram, table, backgauge incl. `independentX/R` checkboxes, `retractAtPinch`,
  finger count / id, speeds, `yCorrection`); `data-testid="machine-bed-length"` on the bed length
  input; `validateMachine` messages; `Save as new machine`.
- **Sequence**: `Plan` button (`data-testid="plan-button"`, busy state with progress
  phase / done / total, `Cancel`), options (sweep step, weights, min-leg factor), `Auto` /
  fixed-order badge; program summary (feasible flag, max force kN / t vs capacity, sequences
  evaluated, time); program warnings; per step card (`data-testid="step-<index>"`, draggable):
  index, bend id, kind, station + punch / die names, `includedAngle → loadedIncludedAngle`
  (springback, overbend), per-finger X / R / Z, ram depth, force kN and t, % of tool, turn icon +
  text, gauge contact, bottoming flag, warnings and collisions via `tm` — clicking a warning /
  collision seeks the sim to that step (collision: to the keyframe at its `atFraction`); clicking
  the card selects the step and seeks its start. Dragging a card onto another reorders →
  `setFixedOrder(newOrder)` → `plan()`; `Auto` clears the order and re-plans.
- **Program**: printable table (`data-testid="program-table"`) with **both languages side by
  side** in every header cell (`EN / TH`), a header block (part, machine, material, thickness,
  date, feasible), per-step rows: step, bend, tools + segments, included angle, loaded angle,
  outside dimension + reference (`virtual-sharp` / `tangent`), bend deduction, X / R / Z per
  finger, part Z offset, ram depth, force (kN and t), % of tool, turn, orientation; footer: max
  force (t) and capacity; buttons `Print` (`window.print()`, `@media print` hides everything but
  the panel), `Export JSON` (`data-testid="export-json"`), `Export CSV` (`data-testid="export-csv"`,
  bilingual header row, `;`-free, UTF-8 BOM so Excel opens Thai correctly).

## 5. Formatting

`fmt(n, digits = 2)` (fixed, trailing zeros trimmed, `–` for non-finite), `fmtAngle(deg)` (`0.1°`),
`fmtMm(v)` (`0.01`), `kNToTonnes(kN) = kN / 9.80665`, `fmtForce(kN)` → `"11.9 kN (1.22 t)"`.
Dates through `Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB')`.

## 6. CSS (`src/index.css`)

Design tokens on `:root` (`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`,
`--accent`, `--accent-2`, `--warn`, `--error`, `--ok`, `--viewport-bg`, `--font`, `--mono`,
`--radius`), industrial look: dark viewport frame, light panels, dense 13 px tables, flat buttons.
`@font-face` Sarabun Regular / Bold from `/fonts/Sarabun-Regular.woff2` and `/fonts/Sarabun-Bold.woff2`
(`font-display: swap`; the integrator ships the files) with the fallback stack `'Sarabun', 'Noto
Sans Thai', system-ui, 'Segoe UI', Roboto, sans-serif`. `html[lang="th"]` bumps the line height.
The sim's `pbsim-*` classes are overridden to the tokens. Print stylesheet: `body.printing-program`
hides the shell except `.program-print`.

## 7. Tests

`npx vitest run src/i18n src/app`:
- `i18n.test.ts`: `{{param}}` / `{param}` interpolation, missing params left as written, English
  fallback for a key missing in Thai and the key itself for an unknown key, `tm` on a `Message`,
  key completeness en ↔ th, every `t('…')` / `tt('…')` / `` t(`prefix.${}`) `` prefix literal in
  `src/app` + `src/sim` exists in `en.json` (template keys are checked by prefix against the
  enumerated suffixes), every `warnings.* / collisions.* / errors.*` literal in `src/core` and
  every `simLabelsEn` key exists in `en.json`, no empty strings.
- `store.test.ts` (jsdom): `loadFlat(loadTruth('L-bracket').flat)` builds a 2-flange part;
  `setBend('B1', { angle: 120 })` recomputes the bend allowance and marks `sources.angle = 'user'`;
  `setThickness` / `setMaterial` rebuild; `addBend` / `removeBend`; `plan()` with the standard
  library and default setup yields one feasible step for the L-bracket and pushes keyframes into
  `useSimStore`; `setFixedOrder` on the U-channel is honoured; `saveProject` → `loadProject` round
  trip keeps the part, setup and program; `importFiles` with an STL `File` recognises the L-bracket
  and, after a DXF `File`, matches it (sources `mesh` on the DXF flat); station / machine actions
  and their validation messages; `cancelPlan`.
