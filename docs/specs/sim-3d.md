# sim-3d — `src/sim`

The 3D simulation of ARCHITECTURE "Simulation": an R3F scene (machine, tools, part), a 2D
section view, a transport bar and a zustand playback store. Depends on `types`, `geom`, `part`,
`tools`, `machine` and the planner's timeline shape (`SimKeyframe[]` from `buildTimeline`); it
never composes poses itself (`SimKeyframe.partTransform` is FINAL). Units: mm, degrees,
seconds. Pure files (`store.ts`, `interpolate.ts`, `partGeometry.ts`, `scene.ts`, `labels.ts`)
are unit-tested in Node (`partGeometry.ts` imports only three's `ShapeUtils`/`Vector2`, allowed
here); components (`*.tsx`, `threeUtils.ts`) are browser-only, not unit-tested, but exercised
headlessly (scratch/sim-smoke: Chromium + SwiftShader, dev and production builds, no page
errors, screenshots). No dependency on `src/i18n`: every label goes through a `t(key, params)`
prop with English defaults (§6).

Barrel `src/sim/index.ts` (exact public names):

| export | from |
|---|---|
| `SimViewport`, `SimViewportProps`, `SimSceneProps` | `SimViewport.tsx` |
| `SectionView`, `SectionViewProps` | `SectionView.tsx` |
| `TransportBar`, `TransportBarProps` | `TransportBar.tsx` |
| `PartMesh`, `PartMeshProps`, `MachineModel`, `MachineModelProps`, `ToolModel`, `ToolModelProps` (scene pieces for custom scenes) | `PartMesh.tsx`, `MachineModel.tsx`, `ToolModel.tsx` |
| `useSimStore`, `SimState`, `SimActions`, `SimStore`, `CameraPreset`, `currentFrame`, `simDuration`, `currentStepIndex`, `SPEED_MIN`, `SPEED_MAX` | `store.ts` |
| `frameAt`, `keyframeIndexAt`, `interpolateKeyframes`, `slerpQuat`, `lerpFoldState`, `lerpFingers`, `phaseSegments`, `hasErrorCollision`, `hasNewErrorCollision`, `firstNewErrorKeyframe`, `SimFrame`, `PhaseSegment` | `interpolate.ts` |
| `buildFlangeGeometry`, `buildBendZoneGeometry`, `fillBendZoneArrays`, `zoneIndices`, `zoneHandedness`, `zoneToLocal`, `zoneParentFlangeIndex`, `zoneVertexCount`, `zoneIndexCount`, `meshDataBounds`, `ZONE_SEGMENTS`, `MeshData` | `partGeometry.ts` |
| `idleFrame`, `idleRotation`, `sceneFrameOf`, `stepOf`, `stationOf`, `stationCentreZ`, `collisionKinds`, `punchPieces`, `toolStack`, `formatTime`, `SIM_COLORS`, `EMPTY_SETUP`, `SIM_SPEEDS`, `ZONE_REFILL_DELTA`, `SEGMENT_GAP`, `FRAME_PLATE`, `FRAME_COLUMN`, `SceneFrame`, `SimLibrary` | `scene.ts` |
| `simLabelsEn`, `defaultT`, `withFallback`, `TranslateFn` | `labels.ts` |

`SimLibrary = Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>` (same shape as the planner's
`PlannerLibrary` and the machine module's `LibraryTools`).

---

## 1. Playback store (`store.ts`) — `useSimStore`

```ts
type CameraPreset = 'iso' | 'front' | 'side' | 'top';
interface SimState {
  keyframes: SimKeyframe[];      // from buildTimeline (the ui sets them after planning)
  timeS: number;                 // cursor, 0 … duration
  playing: boolean;
  speed: number;                 // SPEED_MIN 0.25 … SPEED_MAX 4 (×real time)
  continueOnCollision: boolean;  // false ⇒ playback pauses on the first 'error' collision
  showSection: boolean;          // 2D section inset on/off
  cameraPreset: CameraPreset;    // 'iso' initially
  cameraNonce: number;           // bumped by setCameraPreset so re-selecting a preset re-frames
  pausedAtCollision: number | null;  // keyframe index of the last automatic collision pause
}
interface SimActions {
  setKeyframes(frames): void;    // replaces the timeline, timeS = 0, paused, pausedAtCollision = null
  play(): void;                  // no-op without keyframes; at the end of the timeline it restarts from 0
  pause(): void; toggle(): void;
  seekTime(s): void;             // clamped to [0, duration]; clears pausedAtCollision
  seekKeyframe(i): void;         // timeS = keyframes[clamp(i)].timeS
  seekStep(stepIndex): void;     // start of that step's first phase segment (unknown step: no-op)
  stepPhase(dir: 1 | -1): void;  // pauses; +1 → start of the next phase segment (the duration after
                                 // the last), −1 → start of the current segment when more than
                                 // 1e-6 s into it, else the previous one
  setSpeed(v): void;             // clamped; NaN → 1
  setContinueOnCollision(on), setShowSection(on), setCameraPreset(p): void;
  tick(dtS): void;               // advance timeS by dt·speed while playing (render loop)
}
```

`tick(dt)`: `t1 = min(timeS + dt·speed, duration)`. Unless `continueOnCollision`, the keyframes
strictly after the cursor's keyframe up to `t1`'s keyframe are scanned for the first one carrying
a **new** `'error'` report (`firstNewErrorKeyframe` / `hasNewErrorCollision`: an error report at
index k whose identity — obstacle kind, severity, `atFraction`, message key — keyframe k−1 does
not carry; so a second, distinct error appearing while an earlier one persists pauses again,
while the same error continuing does not) — playback stops exactly at that keyframe's time
(`playing = false`, `pausedAtCollision = k`); pressing play again continues past it (the scan
starts strictly after the cursor). The cursor never overshoots: a tick that ends before the
error keyframe does not pause. Reaching the end pauses at `duration`. Invalid `dt` (NaN, ≤ 0)
is ignored; `seekTime(NaN)` → 0.

Selectors (pure functions of the state, usable as `useSimStore(currentFrame)`):
`currentFrame(state) → SimFrame | null` (memoised on the `keyframes` array identity and `timeS`:
the returned object is referentially stable between changes, safe for zustand/React),
`simDuration(state)` (last keyframe time, 0 when empty), `currentStepIndex(state)` (−1 when
empty).

## 2. Interpolation (`interpolate.ts`)

`keyframeIndexAt(keyframes, timeS)` = binary search for the LAST keyframe with `timeS ≤ t`
(0 before the start and for NaN, −1 for an empty timeline); at a phase boundary (two keyframes
with the same time) this is the first keyframe of the NEW phase — also when the shared time is
the timeline's start. `frameAt(keyframes, timeS)`
interpolates between that keyframe `a = k[i]` and `b = k[i+1]` with `u = (t − a.t)/(b.t − a.t)`
(0 when the interval is empty, clamped to [0, 1]):

| field | rule |
|---|---|
| `ramY` | lerp |
| `foldState` | per bend id (union of keys, missing = 0): lerp |
| `pose.position` / `pose.quaternion` | lerp / `slerpQuat` (shortest arc, normalised) |
| `partTransform` | `mat4.compose(position, quaternion)` — never lerped element-wise |
| `backgauge` | per finger lerp of x/r/z (`lerpFingers`); an empty list yields the other list at once (fingers appear/disappear as in the timeline); other count mismatches ⇒ the nearer keyframe's list |
| `collisions` | the nearer keyframe's list (u < 0.5 ⇒ a, else b) |
| `stepIndex`, `phase` | of `a`; `phaseT` = lerp of `t` |

A frame exactly at a keyframe time equals that keyframe (`u = 0`, `index = keyframeIndexAt`).
`SimFrame` also carries `index`, `nextIndex`, `u`. `phaseSegments(keyframes)` lists the maximal
runs of equal `(stepIndex, phase)` as `{ stepIndex, phase, first, last, startTime, endTime }`
(used by `stepPhase`, `seekStep` and the transport bar's step list).

## 3. Part geometry (`partGeometry.ts`, pure)

`MeshData = { positions: Float32Array (xyz), normals: Float32Array, indices: Uint32Array }`.

- `buildFlangeGeometry(part, flangeIndex, t)`: ONE mesh per flange in **FLAT coordinates**
  (u, v, w): every `Flange.regions[j]` is extruded from `w = −t/2` to `+t/2`. Top and bottom
  faces are triangulated with `THREE.ShapeUtils.triangulateShape(polygon, holes)` (points wrapped
  as `Vector2`; the triangles are re-oriented so the top face winds CCW about +w and the bottom
  CW), side walls are one quad (two triangles) per outline / hole edge with the outward normal
  `(e.y, −e.x)` (outline forced CCW, holes forced CW). Flat per-face normals (top +w, bottom
  −w, walls outward); vertices are not shared between faces: `2·n + 4·n` vertices and
  `2·(n + 2h − 2) + 2·n` triangles per region (n ring vertices, h holes). Positioned in the
  scene by `partTransform · FoldedGeometry.flanges[i].transform`. Throws `RangeError` for a bad
  index.
- `buildBendZoneGeometry(bend: FoldedGeometry['bends'][i], t, segments = ZONE_SEGMENTS (12),
  out?)`: the curved zone from the constant-arc-length model with **constant vertex/index
  counts** for any fraction: 4 strips of 2 rows × `segments + 1` samples — inner surface
  (radius `max(0, innerRadius)`, normal −r̂ toward the axis), outer surface (`innerRadius + t`,
  normal +r̂), and the two end caps at λ = 0 / λ = 1 (normal ∓ axial direction `startEdge[1] −
  startEdge[0]`), sampled with `zonePoint(b, φ, λ, r)` at φ = i·θf/segments where r̂(φ) =
  −toCentre·cos φ + tangent·sin φ. A STRAIGHT zone (`isStraightZone`) uses `zoneStripPoint` with
  `along = i·BA/segments` and offsets ±t/2 toward toCentre (inner +t/2 with normal +toCentre, outer −t/2 with normal −toCentre). `zoneVertexCount = 8·(segments +
  1)` (104), `zoneIndexCount = 24·segments` (288). `out` = preallocated `{ positions, normals }`
  arrays to fill in place (`fillBendZoneArrays(bend, t, segments, positions, normals)` is the
  in-place writer, `RangeError` when too small). `zoneIndices(handedness, segments)` builds the
  index buffer whose winding depends only on `zoneHandedness(bend) = sign((−toCentre × tangent)
  · axial)`: for a curved zone it equals side·σ of the fold model and is constant across
  fractions; a STRAIGHT zone always has `toCentre = +w`, so 'down' bends flip handedness between
  their straight and curved states — `PartMesh` therefore re-evaluates the handedness whenever it
  refills a zone and swaps the index attribute when it changed (cheap, 288 indices).
- `zoneToLocal(bend, inverseParentTransform)`: the same zone expressed in the PARENT flange's
  local (FLAT) frame (points through `applyToPoint`, directions through `applyToDir`, the start
  edge then lies in w = 0). In that frame the zone geometry depends only on the bend's OWN
  fraction, so `PartMesh` regenerates a zone only when its own fraction changes by more than
  `ZONE_REFILL_DELTA = 0.002`, whatever the ancestors do, and positions the zone mesh with
  `partTransform · T_parent` every frame (`T_parent = FoldedGeometry.flanges[parent].transform`).
  `zoneParentFlangeIndex(part, bendId)` = the link's parent flange, or for a loose (unlinked)
  bend the first flange whose `bendIds` contains it — exactly the flange that carries it in
  `foldGeometry`; −1 when no flange touches the bend (such zones are omitted).
- `meshDataBounds(data, transform?)` → `{ min, max }` (tests, camera framing).

Verified (`partGeometry.test.ts`, 10 tests): L-bracket flanges (index counts, no NaN, unit
normals, triangle winding agrees with the vertex normals, bounds inside `FoldedGeometry.bounds`
after the fold transform — float32 storage ⇒ 1e-3 tolerance, the vertex/triangle count
formulas above, the root flange holds the hole), every sample's flanges flat and finished, the
finished L-bracket zone (inner vertices at ri = 2.0 and outer at ri + t from the axis, inner
normals pointing at the axis, bounds inside the folded bounds), mid-fold / overbend states,
the straight zone (a BA × t × 80 strip), in-place refill ≡ fresh build, handedness constant over
curved fractions for every sample bend and flipped only for straight 'down' zones, parent-local
zones of the hat-channel chain mapped by `T_parent` ≡ PART-frame zones.

## 4. Scene components

Shared props (`SimSceneProps`): `{ part: PartModel | null, program: BendProgram | null,
machine: Machine, library: SimLibrary, setup?: ToolSetup }` (default `program.setup`, else
`EMPTY_SETUP`). The keyframes come from the store: the ui calls
`useSimStore.getState().setKeyframes(buildTimeline(program, part, material, machine, library))`
after planning (and `setKeyframes([])` when the program is cleared). Without keyframes the
viewport shows an **idle** frame (`idleFrame`): the part fully folded laid on the die plane with
its top face up and its LONGEST bend line along the bed (`idleRotation(part)` = the fixed map
u→Z, v→X, w→Y after a rotation about w that turns that bend line onto u; u→Z for a part without
bends), X centred, Z centred on the bed, lowest point on Y = 0; ram at TDC (`machineLevels`
with the tallest mounted die/punch, defaults 60/120), no fingers.
`SceneFrame = { ramY, foldState, partTransform, backgauge, collisions, stepIndex (−1 idle), phase
| null }` is what every scene component consumes (`sceneFrameOf(simFrame)` converts).

- `<SimViewport part program machine library setup? t? className? style? sectionInset?>`:
  `<Canvas frameloop={playing || hasCollision ? 'always' : 'demand'} dpr=[1,2] camera fov 40
  near 1 far 40000>` with hemisphere + two directional + ambient lights (three r155+ physical
  units), a drei `<Grid>` on the floor (`tableTopY − table.height − 120`), `<OrbitControls
  makeDefault>`, a `<CameraRig>` that applies the store's `cameraPreset` whenever the preset, the
  nonce, the framing target/radius or the program/part change: camera = target + dir·d with
  `d = radius / tan(fov/2) × 1.25`, target `(10, 80, active station centre Z)`, `radius =
  max(stack, 0.7·finished-part diagonal + 60)` where `stack = max(300, 1.3 × half the tool
  stack height (table top → clamp bottom at TDC + clamp height))` — the integrator widened the
  framing so a small part is seen together with its die, punch and clamp instead of from inside
  the ram extrusion (400 mm without a part), directions `iso (−0.75, 0.6, −0.5)` (front-left-
  above), `front (−1, 0.45, 0)` (from the operator, +Z to the right), `side (−0.5, 0.3, 1)`
  (from +Z looking along the bend line, offset to the operator side so the camera stays in
  front of the clamp: operator LEFT, backgauge RIGHT like the section view), `top (−0.05, 1, 0)`
  (operator at the bottom) with `d` raised so the camera is ≥ 150 mm above the ram beam at TDC.
  The tools, clamps and ram are extruded along the whole bed, so a preset must never put the
  camera inside them. In the top preset the ram beam, clamps and punch are drawn translucent
  (`xray` prop of `MachineModel` / `ToolModel`, opacity 0.28, no depth write) so the plan view
  shows the part, fingers and punch segments under them. `<Clock>` drives `tick(min(dt, 0.25))`
  from `useFrame` while playing, skipping the first delta after a pause (in demand mode the
  clock keeps running while paused, so that delta spans the whole pause). The interpolated frame comes from the memoised `currentFrame`
  selector; `invalidate()` is called on every frame change so a paused (demand) scene redraws
  after a seek. DOM overlays (outside the Canvas): caption (`sim.step` + `sim.phase.*`, or
  `sim.idle` / `sim.noProgram`), the collision badge listing the active reports
  (`t(report.message.key, params)`, falling back to `"<kind> (<depth> mm)"` when the key is
  untranslated) with the `sim.pausedOnCollision` note, and the `<SectionView>` inset (bottom
  right, `sectionInset` default true) while `showSection` is on.
- `<PartMesh part thickness foldState partTransform gaugedFlangeId? collision?>`: one `<mesh>`
  per flange (`matrixAutoUpdate = false`, matrix = `partTransform · flanges[i].transform`, geometry
  from `buildFlangeGeometry` built once per `part`/`thickness`, disposed on change) plus one mesh
  per bend zone (preallocated `DynamicDrawUsage` position/normal attributes refilled in place
  through `fillBendZoneArrays` only when `|f − fLast| > ZONE_REFILL_DELTA` or on creation; both
  index attributes (`zoneIndices(±1)`) preallocated, the geometry swaps to the one matching
  `zoneHandedness` after a refill;
  `computeBoundingSphere` after each refill; `frustumCulled = false`). Matrices are written in a
  layout effect that ends with `invalidate()`. Materials: `MeshStandardMaterial` `DoubleSide`,
  colours `SIM_COLORS.sheet #c3c9d0`, gauged flange `#8fb5d9`, collision `#d63b3b` with an
  emissive pulse (`0.35 + 0.35·sin(2π·1.5·t)` in `useFrame`). The whole part is red when the
  frame has any collision (every report is between the part and a machine element).
- `<MachineModel machine setup library ramY fingers collisionKinds xray?>`: the clamp / gap-clamp /
  ram / holder / table / backgauge-beam rectangles come straight from `machineObstacles(machine,
  setup, library, ramY, fingers)` (so the picture matches the collision model), extruded over
  their `zRange` (`'full'` = the bed; the beam over `[zMin, zMax]` of the backgauge); one
  extruded finger profile (`library.fingers[backgauge.fingerId]`, else `flatFinger()`) per
  `FingerSetting` at `(x, r, z − width/2)`; side frames as C-frames of `FRAME_PLATE = 80` mm at
  `frameLeft = (bedLength − distanceBetweenFrames)/2` / `frameRight` (back column `x ∈
  [throatDepth, throatDepth + FRAME_COLUMN 300]` from the floor to above the ram at TDC, bottom
  and top arms). Every box carries a subtle drei `<Edges>` (35 % opacity). An element whose
  `ObstacleKind` appears in `collisionKinds` is tinted red.
- `<ToolModel station punch? die? ramY step? collisionKinds xray?>`: `THREE.ExtrudeGeometry` of the
  profile polygon (`mirrorProfileX` when `punchFlipped` / `dieFlipped`) along +Z: the die over
  `[zStart, zEnd]` at the origin; the punch pieces (`punchPieces`: the station's `segments` with
  `SEGMENT_GAP = 0.4` mm visual gaps, one full-length piece when empty; when `step` uses this
  station, the step's `segments` / `punchLength` piece CENTRED in the station — `(zStart +
  zEnd)/2 ± punchLength/2`, the planner's convention) in a group at `(0, ramY − punch.height,
  0)` (geometry built once per station/tools/piece lengths, only the group moves). Punch/die
  tinted red for `punch` / `die` collisions.
- `<SectionView part program machine library setup? frame? sectionZ? t? className? style?>`:
  `<canvas>` of the machine XY plane, −X (operator) on the LEFT, +X (backgauge) on the RIGHT, +Y
  up. `frame` defaults to the store's current frame (idle preview without keyframes), `sectionZ`
  to the active station's centre (idle: the first station's centre as the viewport frames it,
  else the bed centre). Draws `machineObstacles(...)` at the
  frame's ramY/fingers (frames skipped; table/holder/ram/clamp grey, punch/die dark, fingers +
  beam blue) and `partSilhouette(foldGeometry(part, foldState), partTransform, t)` (flanges
  orange, zones darker orange, filled). Obstacles and pieces whose `zRange` does not contain
  `sectionZ` are drawn at 30 % alpha. Collisions: the kinds in the frame's reports are outlined
  red and each report's location gets a red (error) / amber (warning) cross; the part turns red.
  Labels: `sim.operator` / `sim.backgauge`, X/Y axes, `sim.ramY`, `sim.finger` per finger, the
  step + phase caption (or `sim.idle`); the die plane and the bend line are dashed. Auto-fit: the
  view fits die + fingers + part silhouette, always including `y ∈ [−holderHeight, 50 above the
  die]` and `x ∈ [−80, 80]`, expanded 8 %, and keeps its window until the required box leaves it
  or shrinks below 55 % of its area (hysteresis: no jitter while the ram moves; reset when the
  part/program change). Resizes with one `ResizeObserver`, honours `devicePixelRatio`.
- `<TransportBar t program className? style? hideSteps?>`: ◀ / play-pause / ▶ (`stepPhase`,
  `toggle`), time scrubber (`<input type="range">` over the duration, 10 ms steps → `seekTime`),
  readout `m:ss.s / m:ss.s` (`formatTime`, rounded to tenths so 59.96 s reads `1:00.0`), speed
  select (`SIM_SPEEDS` 0.25 0.5 1 2 4, plus the current speed when it is not one of them),
  continue-on-collision checkbox, section toggle, camera preset buttons, a status line (current
  step + phase, `sim.pausedOnCollision`), and the step list (`sim.step`, kind, punch/die names,
  included angle, turn, error ✖ / warning ⚠ counts; the current step highlighted; click =
  `seekStep`; `hideSteps` when the ui shows its own sequence panel). Controls are disabled
  without keyframes. Styles in `sim.css` (`pbsim-*` classes, light/dark).

## 5. Rendering conventions

- Machine frame = scene frame (mm): +X toward the backgauge, +Y up, +Z along the bed. Bend line
  at X = 0 on the die plane Y = 0. `partTransform` is used verbatim (no re-composition beyond the
  interpolation of §2).
- Punch tip at `ramY − punch.height`; dies at the origin; fingers at `(x, r, z)`; all of these
  match `machineObstacles`.
- Nothing in `src/sim` mutates a PartModel, program or keyframe.
- Performance (headless SwiftShader, 2-CPU box): per-frame work = `foldGeometry` (≤ 0.1 ms) +
  matrix updates + at most one 104-vertex zone refill per moving bend; the section view recomputes
  `machineObstacles` + `partSilhouette` per frame (≤ 0.2 ms). The L-bracket timeline (150
  keyframes, 4.4 s) plays in real time at 4× even under software GL.

## 6. i18n keys (`sim.*`; the ui adds en/th, `simLabelsEn` holds the English defaults)

`sim.play`, `sim.pause`, `sim.stepBack`, `sim.stepForward`, `sim.speed`,
`sim.continueOnCollision`, `sim.section`, `sim.camera`, `sim.camera.iso`, `sim.camera.front`,
`sim.camera.side`, `sim.camera.top`, `sim.phase.position`, `sim.phase.gauge`,
`sim.phase.approach`, `sim.phase.bend`, `sim.phase.release`, `sim.phase.retract`,
`sim.phase.reposition`, `sim.steps`, `sim.step {index, bendId}`, `sim.stepKind.bend`,
`sim.stepKind.hem-flatten`, `sim.turn.none`, `sim.turn.rotate180`, `sim.turn.flip-front-back`,
`sim.turn.flip-end-for-end`, `sim.noProgram`, `sim.pausedOnCollision`, `sim.collisions`,
`sim.time`, `sim.operator`, `sim.backgauge`, `sim.ramY {y}`, `sim.finger {index, x, r, z}`,
`sim.legend.sheet`, `sim.legend.gauged`, `sim.legend.collision`, `sim.idle`, `sim.warnings`.
The collision badge uses the planner's `collisions.<kind>` messages. `withFallback(t)` wraps
the ui's translator: when it returns the key itself (or ''), the English default is used, so the
components render sensibly before the ui adds the strings; `defaultT` is the English-only
translator (interpolates `{param}`).

## 7. Tests and smoke checks

`npx vitest run src/sim` (55 tests): `partGeometry.test.ts` (§3, plus: every sample × fractions
0 / 0.004 / 0.02 / 0.5 / 1 / 1.1 — up, down and 135° bends — winding, radii, inner/outer normals,
the φ = 0 seam on the parent's start edge and the φ = θf seam on the child's transformed
zone-end edge within 1e-3 mm; `zoneIndices(−1)` = reversed `zoneIndices(1)`; a 180° hem zone
and a negative inner radius clamped to the axis; degenerate zero-length edges stay finite;
loose bends carried by their flange; flange top-face area = region − holes for every sample
with the hole centroid uncovered; a synthetic region with a duplicated closing point, CW
outline and CCW hole), `interpolate.test.ts` (keyframe identity incl. boundary times, midpoint
lerp of ramY/fold/position with the transform rebuilt from the pose, collisions from the nearer
keyframe, slerp shortest arc and 180° turns, fold-state union, finger lerp rules, phase
segments, single-keyframe timelines, shared start times, reposition phases of the hat-channel
rigid with a fixed fold state, a 60 Hz sweep of every sample timeline — finite, rigid, fold
range, handling/ram speed continuity — and distinct-error detection), `store.test.ts`
(setKeyframes/play/pause/toggle, seekTime clamping, seekKeyframe/seekStep incl. a
reposition-first step, stepPhase forward and back incl. the ends and single segments, tick
speed / end-of-timeline / collision pause and resume / a second distinct error / no overshoot /
continueOnCollision, invalid inputs, speed clamping, memoised currentFrame, camera nonce) and
`scene.test.ts` (idle frame of every sample: on the plane, centred, rigid, top face up, longest
bend along Z; tool stack defaults; punchPieces conventions; formatTime; collisionKinds; labels
and the English defaults of every key). The timelines come from `planProgram` +
`buildTimeline` on the samples via the planner's `test-helpers.ts`. `scratch/sim-smoke/` (run.mjs / zoom.mjs + a Vite page) renders the real
components in headless Chromium: L-bracket, box and hat-channel programs, seeking, 4× playback,
camera presets, the section inset, and the automatic pause on the hat-channel's die collision
(badge "die (3.7 mm)"), with zero page errors in the dev (StrictMode) and production builds.
