# ui — `src/app`, `src/i18n`, `src/index.css`

The bilingual (English / Thai) React UI of ARCHITECTURE "UI": a zustand project store that
wires every core module together (import → recognise → part model → tool setup → planner →
timeline → sim store), the i18n layer, and the panels. Depends on the other modules through
their barrels (`src/core/import`, `src/core/import/recognize`, `src/core/part`, `src/core/tools`,
`src/core/machine`, `src/core/library`, `src/core/planner`, `src/sim`) plus `src/core/types`;
the store alone imports the sim's pure files `src/sim/store` and `src/sim/interpolate` directly
(same module instances as the barrel) so it can be unit-tested without three / R3F. Units: mm, degrees, kN (with a tonne readout: 1 t = 9.80665 kN).
Public API: `<AppRoot/>` (`src/app/App.tsx`, re-exported by the barrel `src/app/index.ts` together
with the store, the project-file helpers and the formatters) — the integrator points `main.tsx` at it.
`src/App.tsx`, `src/main.tsx`, `index.html` and `public/**` are not touched.

Files:

| file | content |
|---|---|
| `src/i18n/index.ts` | `translate`, `t` helpers, `LanguageProvider`, `useI18n`, `tm`, `LANGUAGES`, dictionaries |
| `src/i18n/en.json`, `src/i18n/th.json` | flat `{ "dot.key": "text" }` dictionaries (identical key sets) |
| `src/app/index.ts` | barrel: `AppRoot` (named + default), store, project-file helpers, formatters, `SAMPLE_NAMES` |
| `src/app/store.ts` | `useProjectStore` (zustand), `createProjectStore`, `libraryStore` (a `LibraryStore` singleton), selectors |
| `src/app/plan.worker.ts` | module Worker running `planProgram` off the main thread (progress / done / error messages) |
| `src/app/sampleNames.ts` | the 7 bundled sample names (the Node-only fixtures cannot be imported by the app) |
| `src/app/project.ts` | project (de)serialisation, library overlay, program JSON / CSV export, file download helper |
| `src/app/format.ts` | number formatting (`fmt`, `fmtAngle`, `kNToTonnes`, …) |
| `src/app/App.tsx` | `<AppRoot/>`: language provider + shell (header, three columns, keyboard shortcuts) |
| `src/app/panels/PartPanel.tsx` | import drop zone / inputs, sample menu, material + thickness, bends table, `<FlatView/>` |
| `src/app/panels/ToolsPanel.tsx` | stations, punch/die/finger pickers, `<ProfilePreview/>`, library manager, `<CustomToolDialog/>` |
| `src/app/panels/CustomToolDialog.tsx` | DXF → `importToolProfileDxf` → reference / up / mirror → `normalizeProfile` → metadata → `createCustom*` |
| `src/app/panels/MachinePanel.tsx` | machine picker + grouped form + `validateMachine` messages + save as new |
| `src/app/panels/SequencePanel.tsx` | Plan button + options, step cards, drag-reorder → `fixedOrder` |
| `src/app/panels/ProgramPanel.tsx` | printable bilingual program table, export JSON / CSV, print |
| `src/app/components/*.tsx` | `Tabs`, `MessageList`, `NumberField`, `SourceBadge`, `FlatView`, `ProfilePreview`, `Dialog`, `FileDrop`, `Toasts`; `canvas.ts` (DPR sizing, fit transform) |
| `src/index.css` | design tokens, layout, panels, tables, dialogs, print stylesheet, Sarabun `@font-face` |
| tests | `src/i18n/i18n.test.ts`, `src/app/store.test.ts`, `src/app/store.edge.test.ts` (`// @vitest-environment jsdom`) |

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

`createProjectStore({ libraryStore?, useWorker?, language? })` builds the zustand store; the app
uses the singletons `libraryStore = new LibraryStore()` (browser defaults: localStorage cache +
`/api/library`) and `useProjectStore = createProjectStore({ libraryStore })`. Tests create their
own with `new LibraryStore({ storage: null, fetch: null })` and `useWorker: false`. The store
mirrors the library snapshot (`library`, subscription) and a memoised `simLibrary`
(`Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>`, referentially stable per library state) for
the planner and the sim components. Only the pure sim pieces are imported here
(`../sim/store`, `../sim/interpolate`), so the store is unit-tested under jsdom without three /
R3F; the barrel `../sim` is used by `App.tsx`.

```ts
interface ProjectState {
  project: Project;                       // types.ts Project (version 1)
  library: ToolLibrary; simLibrary: SimLibrary;
  thickness: number;                      // sheet thickness for DXF imports / new flats (mm), default 2
  dxfFlat: FlatPattern | null;            // last imported DXF flat (geometry source)
  recognized: RecognizedSheet | null; mesh: TriangleMesh | null;
  matchInfo: { pairs, count, mirrored } | null;   // matchToDxf summary
  importWarnings: Message[]; importing: boolean;
  planning: boolean; planProgress: PlannerProgress | null; planError: Message | null;
  programStale: boolean;                  // setup / machine / library changed after planning
  fixedOrder: string[] | null;            // mirrors project.plannerOptions.fixedOrder
  selectedBendId: string | null; selectedStepIndex: number | null;
  dxfUnits: 'auto' | DxfUnits; meshUnits: MeshUnits;
  notices: Notice[];                      // toasts { id, message, severity }, auto-dismissed after 7 s
  activeLeftTab: 'part' | 'tools' | 'machine'; activeRightTab: 'sequence' | 'program';
}
```

Selectors (stable references): `selectMachine(s)` (project machine, else the first library
machine, else a module-level default), `selectMaterial(s)`, `selectSetupMessages(s)` /
`selectMachineMessages(s)` (fresh arrays — components wrap them in `useMemo`).

Actions. Every part change rebuilds the `PartModel` with `buildPartModel`, clears the program
and the sim keyframes and keeps the right tab on Sequence; a flat whose model has no flange (empty
or degenerate outline, or a bend zone wider than the sheet) is **refused** with an
`errors.app.partBuildFailed` toast and the current part is kept; a `fixedOrder` is trimmed to the
bend ids that still exist (cleared when none remain). Setup / machine / library / planner-option
changes keep the program but set `programStale` (a machine rename does not); every new program
pushes `buildTimeline(program, part, material, machine, simLibrary)` into `useSimStore`. The
`simLibrary` pick keeps its identity while only materials / machines change.

- `importFiles(files: File[])` reads the files, then `importInputs(inputs, { fresh? })`: meshes are
  processed before DXFs so the recognised thickness feeds the drawing's defaults (the drawing stays
  the geometry source). DXF → `importFile` with
  `{ thickness, materialId, kFactor, material, units: dxfUnits }` → `dxfFlat`. STEP / STL / OBJ /
  GLB / GLTF → `importFile` (mesh, `meshUnits`) → `recognizeSheet(mesh, { materialId, kFactor,
  thicknessHint: thickness, name })` → `thickness = rec.thickness` (when > 0). Then the flat =
  `matchToDxf(recognized, dxfFlat).flat` when both exist (the DXF re-stamped with the recognised
  thickness), else the DXF flat, else `rec.flat`; `materialId` / `thickness` are stamped on it and
  the part rebuilt. A base name ending in `-flat` / `_flat` is stripped (`L-bracket-flat.dxf` →
  `L-bracket`). `ImportError` → `err.toMessage()`; other errors → `errors.import.unknown`; all
  importer / recogniser / match messages land in `importWarnings`; a toast confirms the import.
- `loadSample(name)`: `fetch('/samples/<name>/<name>-flat.dxf')` + `.step` (a failed fetch →
  `errors.app.fetchFailed`, the other file is still used), project name = sample name,
  `importInputs(…, { fresh: true })`.
- `loadFlat(flat)` (tests / truth files), `setPartName(name)`.
- `setBend(id, patch)` (`direction | angle | innerRadius | kFactor | angleCorrection | hem |
  hemGap | p0 | p1`; changed attributes get `sources.* = 'user'`; angle clamped to [0.5, 180], 180
  ⇒ `hem: 'closed'`; ri ≥ 0; k ∈ [0.05, 1]; correction ∈ [−45, 45], 0 removes it),
  `addBend(p0, p1, direction = 'up')` → next free `B<n>`, angle 90, ri = `defaultInnerRadius(t,
  material)` (1.28·t mild steel), k = material k, sources all `'user'`, selected; `null` for a
  line shorter than 0.5 mm; `removeBend(id)`.
- `setMaterial(id)` (project + flat, rebuild), `setThickness(t)` (clamped 0.1–50, rebuild).
- `setSetup(setup)`, `addStation()` (next free `S<n>` in the largest free Z gap rounded to 5 mm,
  default punch / die of `defaultToolSetup`, auto segments), `updateStation(id, patch)`
  (segments recomputed from the punch's segment lengths when the punch or the Z range changes and
  no segments were given), `autoSegments(id)`, `removeStation(id)`, `resetSetup()`.
- `setMachine(id)`, `updateMachine(patch)` (deep partial; upserted into the library under the same
  id — standard machines are editable, as ratings are), `saveMachineAs(name)` → `custom:` copy.
- `plan()`: refuses without part / bend lines / stations / material (toast, `errors.plan.noPart`,
  `noBends`, `noStations`, `noMaterial`); sets `planning`, yields until after the next paint,
  reads the inputs **after** yielding, then runs `planProgram` in a module Worker
  (`plan.worker.ts`, progress messages throttled to 60 ms, `cancelPlan()` = terminate) or, when
  workers are unavailable / fail to start, in-thread with an `AbortController` signal. A result
  for a part that changed meanwhile is dropped; a setup / machine / library / option edit made
  while the worker ran leaves the new program `programStale`. Success → `project.program`,
  keyframes, step 0 selected, right tab Sequence, toast (`app.notice.planned` /
  `plannedInfeasible`); `AbortError` → silent; `RangeError` / other → `planError`
  (`errors.plan.failed {detail}`).
- `setFixedOrder(ids | null)` (`plannerOptions.fixedOrder`; an empty list clears it),
  `setPlannerOptions(patch)` (marks the program stale).
- `saveProject(): string` (JSON of `Project` + `app`, `savedAt`, `libraryOverlay` = referenced
  items + every custom item), `loadProject(json)` (validated by `parseProject`; a running plan is
  cancelled; overlay items the library lacks are upserted; unknown machine / material ids fall
  back; the program is kept only when every step has the full `BendStep` shape and its bend ids
  exist — otherwise it is dropped with an `app.notice.programDropped` toast; zero planner weights
  survive; the timeline is rebuilt; throws `AppError` with `errors.app.invalidProject` /
  `errors.app.projectVersion`). Machine snapshot policy: when the file's copy of the project's
  machine differs from the library's, a library machine that is still the pristine standard one
  **adopts the snapshot** (`app.notice.machineFromProject` — the file brings the shop's calibration
  to a fresh PC); a machine edited locally wins and a saved program is flagged `programStale`
  (`app.notice.machineDiffers`). `newProject()`, `setProjectName(name)`.
- `setLanguage(lang)` (also `setGlobalLanguage` + localStorage `pbsim.language`), `selectBend`,
  `selectStep(i)` (seeks the sim to the step), `seekToCollision(step, report)` (locates
  `atFraction` in the bend phase's keyframe fold states — the phase is linear in ram travel, not
  in fold fraction — and interpolates the time; a fraction past the overbend lands on the end of
  the phase; `atFraction ≤ 0` = the end of the gauge phase), `setLeftTab / setRightTab`,
  `setDxfUnits / setMeshUnits`,
  `notify(message, severity?)`, `dismissNotice(id)`, library: `upsertLibraryItem`,
  `removeLibraryItem(id)` (refused with a toast when mounted on a station, used as the finger of
  any library machine, or the project's machine / material), `saveLibrary()` (toast with the
  remote outcome), `loadLibrary()` (called once at mount; keeps the project's machine / material
  valid and rebuilds the default setup of a still-empty project for the loaded machine — its bed
  may be shorter than the standard one the store started with), `exportLibraryJson()`,
  `importLibraryJson(json, mode)`, `resetStandardItems()`.

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
  e2e hooks: `data-testid="part-importing"` (busy text), `part-recognized` (the recognition line),
  `part-summary` with `data-flanges` / `data-bends` / `data-holes`.
- **Tools**: station list (`data-testid="station-<id>"`): Z start / end, segments editor (text
  `835, 835, …` parsed to numbers; "auto" fills from the punch's segment lengths), punch and die
  `<select>` grouped by family (`<optgroup>`), flip toggles, remove; `Add station` (largest free
  Z gap rounded to 5 mm; on a full bed the last 100 mm, overlapping, never beyond the bed),
  `Reset to default`; `validateSetup` messages; `<ProfilePreview>` canvases of the selected station's punch
  and die (tip arc highlighted from `derivePunchParams(...).arcVertices`); finger picker (machine
  `backgauge.fingerId`); library section: custom tools list with remove, `Add custom tool` dialog
  (`data-testid="custom-tool-dialog"`; fields `custom-tool-file`, `custom-tool-units` (changing it re-parses the chosen file), `custom-tool-kind`,
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
  `setFixedOrder(newOrder)` → `plan()`; `Auto` clears the order and re-plans. e2e hooks on the
  card: `data-bend-id`, `data-turn`, `data-errors`; inside it `step-station-<i>`, `step-angle-<i>`,
  `step-turn-<i>`, `step-backgauge-<i>` (`data-contact`), `step-finger-<i>-<j>` (`data-x/r/z`),
  `step-ramdepth-<i>` (`data-ram-depth`), `step-force-<i>` (`data-force-kn`).
- **Program**: printable table (`data-testid="program-table"`) with **both languages side by
  side** in every header cell (`EN / TH`), a header block (part, machine, material, thickness,
  date, feasible), per-step rows: step, bend, tools + segments, included angle, loaded angle,
  outside dimension + reference (`virtual-sharp` / `tangent`), bend deduction, X / R / Z per
  finger, part Z offset, ram depth, force (kN and t), % of tool, turn, orientation; footer: max
  force (t) and capacity; buttons `Print` (`window.print()`, `@media print` hides everything but
  the panel), `Export JSON` (`data-testid="export-json"`), `Export CSV` (`data-testid="export-csv"`,
  bilingual header row, `;`-free, UTF-8 BOM so Excel opens Thai correctly; the springback and
  actual-radius columns use the plain labels `program.col.springback` / `program.col.actualRadius`,
  never the parametrised sequence messages). Header block hooks: `program-header`, `program-part`,
  `program-machine` (`data-bed-length`). The print stylesheet lets the 16-column table fit an A4
  landscape page (no horizontal scroll, wrapping headers, 8.5 px type, white page background).

## 5. Formatting

`fmt(n, digits = 2)` (fixed, trailing zeros trimmed, `–` for non-finite), `fmtAngle(deg)` (`0.1°`),
`fmtMm(v)` (`0.01`), `kNToTonnes(kN) = kN / 9.80665`, `fmtForce(kN)` → `"11.9 kN (1.22 t)"`.
Dates through `Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB')`.
`<NumberField>` edits a local draft and commits on blur / Enter only when the **text** changed
(Escape reverts): focusing and leaving a field whose value has more decimals than it shows (a
recognised thickness of 1.983 shown as `1.98`) never pushes the rounded value into the store.

## 6. CSS (`src/index.css`)

Design tokens on `:root` (`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`,
`--accent`, `--accent-2`, `--warn`, `--error`, `--ok`, `--viewport-bg`, `--font`, `--mono`,
`--radius`), industrial look: dark viewport frame, light panels, dense 13 px tables, flat buttons.
`@font-face` Sarabun Regular / Bold from `/fonts/Sarabun-Regular.woff2` and `/fonts/Sarabun-Bold.woff2`
(`font-display: swap`; the integrator ships the files) with the fallback stack `'Sarabun', 'Noto
Sans Thai', system-ui, 'Segoe UI', Roboto, sans-serif`. `html[lang="th"]` bumps the line height.
The sim's `pbsim-*` classes are overridden to the tokens. Print stylesheet: `body.printing-program`
hides the shell except `.program-print`.

## 7. Tests and smoke

`npx vitest run src/i18n src/app` (49 tests, ≈ 6 s):
- `i18n.test.ts` (Node): `{{param}}` / `{param}` interpolation, unknown params kept, English
  fallback and key-as-fallback, `tm` / `translateMessage` / global language, key completeness
  en ↔ th, identical parameter sets per key, every `simLabelsEn` key, every `t('…')` / `tt('…')`
  / `` t(`prefix.${}`) `` literal in `src/app` + `src/sim` (prefixes checked against the
  enumerated keys), every `warnings.* / collisions.* / errors.*` literal in `src/core` + `src/app`,
  `collisions.<ObstacleKind>` and the recogniser's `issue('…')` keys, every `{ key: '…' }` Message
  literal built in `src/app`, and the enumerated dynamic families (`family.*`, `turn.*`,
  `contact.*`, `machine.*` field labels, `tools.remote.*`, `part.sample.*`, …).
- `store.test.ts` (`// @vitest-environment jsdom`): `loadFlat(loadTruth('L-bracket').flat)`;
  `setBend` recompute + sources + clamping + hem; `setThickness` / `setMaterial`; `addBend` /
  `removeBend`; default setup, station edits, overlap validation, machine edits / validation,
  save-as; `plan()` → one feasible L-bracket step (force 11.93 kN) with keyframes, invalidation on
  edit; stale flag + `setFixedOrder` on the U-channel; refusals + cancel before start;
  `selectStep` / `seekToCollision`; project round trip incl. custom machine overlay and language;
  JSON / CSV exports; `importFiles` with an STL `File` then a DXF `File` (recognised, matched,
  sources `mesh`); `loadSample` through a mocked `fetch` (STEP read in-process); format helpers.
- `store.edge.test.ts` (jsdom): empty-outline flat refused, plan refused without bends, `setBend`
  clamping / NaN / hem toggling, a bend line that does not span the part, thickness clamping,
  reversed and full-bed stations, every sample planned through the store (one step per bend,
  included angles), stale `fixedOrder` trimming, acute bracket infeasible on 88° tools and
  feasible on the acute station (loaded angle vs the truth golden), flipped gooseneck tooling,
  angle correction → overbend fraction > 1 in the timeline and `seekToCollision` landing on the
  fold fraction, hem expansion (pre-bend + flatten, infeasible without a hemming station),
  `newProject` during a plan, stale flags (options / machine edits vs rename), inch DXF with a
  down bend and a hole through `importFiles` (+ forced-units re-import refused as a degenerate
  part), a cube STL, mesh thickness re-stamping a later DXF, project files with zero weights /
  malformed steps / foreign bend ids, the machine snapshot policy (pristine adopts, edited wins
  + stale), overlay custom finger + delete refusal, CSV escaping, `loadLibrary` default-setup
  refresh, `simLibrary` identity.

`scratch/ui-smoke` (README there): builds a page mounting `<AppRoot/>` and drives it in headless
Chromium through the data-testids — sample load (DXF + STEP worker), Plan (planner worker,
verified by the network log), Space / arrow keys, language toggle, Program tab (Thai), Tools tab
+ custom-tool dialog with `samples/tools/custom-gooseneck-punch.dxf`, Machine edit (stale
badge), bends-table edit, box sample + drag reorder + Auto, 1024 px layout — with zero page
errors; screenshots `shot-*.png`.
