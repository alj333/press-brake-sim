# planner — `src/core/planner`

The bend-sequence planner (ARCHITECTURE "Bend-sequence planner", all 7 sub-sections). Pure
TypeScript (no DOM, no three.js). Units: mm, degrees at every API boundary, kN, seconds. Types
from `src/core/types.ts`; depends on `geom`, `bend`, `part`, `tools`, `machine`.

Barrel `src/core/planner/index.ts` (exact public names):

| export | signature |
|---|---|
| `planProgram(input, signal?, onProgress?)` | `(input: PlannerInput, signal?: AbortSignal, onProgress?: (p: PlannerProgress) => void) => BendProgram` (synchronous) |
| `defaultPlannerOptions()` | `() => PlannerOptions` — sweepStepDeg 5, maxSequences 20000, weights `{ flip: 10, rotate: 4, stationChange: 6, shortFlange: 3, collisionWarning: 5 }`, minFlangeWarnFactor 1.15 |
| `computePlacement(part, folded, bendId, gaugedFlangeId, station, t)` | `Placement` (§2); `computePlacementDetails` returns the placement plus rotation, bend Z extents and bounds |
| `buildTimeline(program, part, material, machine, library)` | `SimKeyframe[]` (§7) |
| `classifyTurn(prev, next)` | `Turn` from two placement transforms (§2) |
| internals, re-exported for tests and the UI | `createContext`, `createEvaluator`, `searchSequence`, `sequenceCost`, `manipulationCost`, `analyseStation`, `bendStationMaths`, `flatMaterialLimits`, `bestSegmentsWithin`, `centrePunchInStation`, `shiftPlacementDetails`, `planBackgauge`, `maxXInBand`, `sweepCollisions`, `obstaclesAt`, `cutBox`, `overlapLocation`, `poseAtFraction`, `buildBendStep`, `buildHemFlattenStep`, constants `HEM_PREBEND`, `HEM_PREBEND_MIN`, `MAX_BENDS` (31), `TURN_NONE_MAX_DEG` (45), `PUNCH_CLEARANCE`, `COLLISION_THRESHOLD`, `MAX_SWEEP_STEPS`, `HARD_ERROR_COST`, `GAUGE_WARNING_COST`, `FINGER_OVER_DIE_COST`, `SINGLE_FINGER_COST`, `BEAM_WIDTH`, `EXHAUSTIVE_MAX_BENDS`, `RETRACT_MARGIN`, `KEYFRAMES_PER_PHASE`, `PARK_OFFSET`, `HANDLING_SPEED`, `TURN_TIME_S`, `GAUGE_APPROACH`, `RELEASE_RISE` |

```ts
interface PlannerInput {
  part: PartModel; material: Material; machine: Machine; setup: ToolSetup;
  library: Pick<ToolLibrary, 'punches' | 'dies' | 'fingers'>; options?: Partial<PlannerOptions>;
}
interface PlannerProgress { phase: 'evaluate' | 'search' | 'assemble'; done: number; total: number; sequencesEvaluated: number }
```

The `AbortSignal` is polled before every step evaluation; a set signal throws a
`DOMException('AbortError')` (an `Error` named `AbortError` without `DOMException`). `onProgress`
is called every 25 evaluations ('evaluate'), every 50 explored sequences ('search') and per
assembled step ('assemble').

Bendable bends = `part.links` (unlinked bends — `bendNoMaterial`, `bendCycle`, … — and bends
below the fold model's straight-zone threshold (`angle < 0.01°`) are skipped with
`warnings.planner.bendSkipped {bendId}`); `part.warnings` and the `validateSetup` messages are
copied into `BendProgram.warnings` (duplicates of the context's own setup warnings are dropped).
Bend index i (link order) is bit i of the 32-bit "done mask": more than `MAX_BENDS = 31`
bendable bends make `planProgram` throw a `RangeError` (the UI must catch it like the AbortError).

---

## 1. Stations (`stations.ts`)

Stations of the `ToolSetup` are resolved against the library (missing tools ⇒ the station is
skipped; `validateSetup` reports it). A station is a **hemming** station when
`die.family === 'hemming'`, `punch.tipAngle ≥ 180` or `vWidth ≤ 0`; it is never used for air bends.

`bendStationMaths(ctx, bend, station)` (per bend × station, memoised): `riActual =
actualInnerRadius(V, material, t, punch.tipRadius)`, `overbend(material, riActual, t, formAngle,
angleCorrection)`, `ramDepth(V, t, riActual, loadedIncludedAngle, rs, vAngle) + yCorrection`,
`airBendForce(Rm, L, t, V)` (`hemFlattenForce` on hemming stations), `toolLoadCheck`, `minLeg(V,
loaded, rs)`, `vPreference = |V − recommendedV(t)| / recommendedV(t)` and two angle flags:
- `angleFits` — the tools physically fit inside the loaded angle (`tipAngle ≤ loaded && vAngle ≤
  loaded`, no margin). False ⇒ `warnings.tool.angle` (error) and the step is infeasible;
- `angleOk` — ARCHITECTURE's `toolAngleFeasible` with the 1° margin. False but fitting ⇒
  `bottoming = true` + `warnings.tool.bottoming` (info) + a small cost (`BOTTOMING_COST` 0.5) so a
  margin-safe station is preferred when mounted.

  (With the margin as a hard rule every 90° mild-steel bend on the standard 88° tools — the
  samples' own default setup — would be infeasible: loaded angle 88.29° < 89°. Reported as a
  contract issue; the physical fit is the hard rule here.)

`analyseStation(ctx, bend, station, maths, placementDetails, pieces)`:
- **length**: `punchLength ≥ bendLength − 2·(ri + t)` ("required") else `warnings.tool.tooShort
  {bendId, stationId, stationLength, required}` (error).
- **Z-clearance**: usable punch interval = intersection of
  1. the *flat-material* limit (`flatMaterialLimits`): material of the flat pattern (outline
     minus holes, sampled every 0.5 mm along the line at 5 offsets across `|d| ≤ V/2 + 1`) lying
     beyond the bend line's ends would be crushed by the punch tip (relief strips beside a tab,
     the flat neighbours of a box corner, walls already standing). The first such sample on each
     side bounds the interval; flanges already bent away still count (conservative). This is the
     only protection for material of the current bend's own flanges beyond the line ends: the
     fold model keeps a flange rigid, so such strips follow the leg into the V in the sweep.
  2. the *standing-feature* limit: silhouette pieces at the placement (f = 0) with `max y >
     t + 0.5`, X extent overlapping the punch profile ± 2 and Z range outside the bend line's
     extent bound the interval on their side (the arc of a standing wall starts at the line end).
  `PUNCH_CLEARANCE = 1 mm` is kept on each side. The usable interval is **symmetric about the
  bend line** (the piece extends equally on both sides as far as the NEARER limit allows, up to
  the station): a one-sided obstacle (corner tab, wall at one end) does not send the piece far
  over the free side; with no limit the interval is the station (the placement centres the bend
  line in it).
- **punchLength / segments**: interval ≥ station ⇒ the whole station (`station.segments`).
  Otherwise `bestSegmentsWithin(usable, station.segments, false)` (each mounted piece at most
  once, 0.5 mm DP) and, when that is below the required length, `bestSegmentsWithin(usable,
  punch.segmentLengths, true)` (unlimited repeats, fewest pieces, largest first: 190 → 100+50+40,
  28 → 15+10); the better sum wins. A tool without pieces is a single full-length piece.
- **punch piece position — program convention**: the piece of length `punchLength` is mounted
  **centred in the station** (`(zStart + zEnd)/2 ± punchLength/2`, reconstructible from the
  BendStep + setup) and the part is placed relative to it: `centrePunchInStation` translates the
  placement, the silhouette and the analysis together when the analysis put the piece off the
  station centre (never with the symmetric interval above, kept as the safety net). `punchZ`
  replaces the station's punch obstacle Z range in the sweep (the clamp keeps the station's range).
- **partZOffset**: `zMin(part) − zStart` after that translation (the bend line is centred in the
  station whenever the piece is centred on it).

## 2. Placements (`placement.ts`)

`computePlacement(part, folded, bendId, gaugedFlangeId, station, t)` — `folded` must be
`foldGeometry(part, { previous bends: 1, [bendId]: 0 })` (the zone must be straight; otherwise it
throws, as does a flange that is not the bend's parent or child). With `S0, S1` = zone start
edge, `d̂` = zone tangent (toward the child), `w` = the parent's current normal (`toCentre` of
the straight zone) and `σ = ±1` for up/down:
- `ey = σ·w` (concave side up), `ex = +d̂` when the child is gauged, `−d̂` when the parent is
  gauged, `ez = ex × ey` (∥ the bend line). The rotation matrix has rows `ex, ey, ez`.
- The bend-line centre material point `m = mid(S0,S1) + d̂·BA/2` maps to `(0, t/2, zc)` with the
  bend line centred in the station; `partZOffset = zMin − station.zStart`.
- `flipped = (R·rootNormal).y < 0`; `frontFlangeId` = the other flange.
`bendPose(placement.transform, folded, bendId, 0, punchTipY(0), t)` equals the placement.

`classifyTurn(prev, next)`: `R = next · prev⁻¹` (root-flange motion). Rotation angle ≤
`TURN_NONE_MAX_DEG = 45°` ⇒ `'none'` (a translation, or the re-tilt in the hands after a shallow
bend — not a flip); rotation axis ∥ Y (|axis.y| > 0.9, any yaw incl. 90°) ⇒ `'rotate180'`;
otherwise the closer of `Rz(180)` (`'flip-front-back'`), `Rx(180)` (`'flip-end-for-end'`) and
`Ry(180)` by residual angle (ties → front-back).

## 3. Collision model (`collision.ts`)

`sweepCollisions(ctx, { bend, station, details, doneMask, fingers, stopAtError?, stepFactor? })`:
- Samples φ = 0 … 1 of the formed angle in `sweepStepDeg · stepFactor` steps, at most 18 steps
  (19 samples), plus one at `overbendAngle/formAngle` (the deepest ram position). While
  searching parts with more than 7 bends `stepFactor = 2`; the final program is always swept at
  `sweepStepDeg`. Hem-flatten sweeps start at `startFraction` (the pre-bend's actual fold
  fraction, 6 samples to 1).
- Per sample: `folded = foldGeometry(part, {…done: 1, [bendId]: φ·formAngle/angle})` (cached
  per fold state in the context), `tipY = punchTipY(V, t, riActual, φ·formAngle, rs, vAngle)`,
  `pose = poseAtFraction(placement, folded, bendId, f, tipY, t)` (= `bendPose`, or the placement
  while the zone is still straight — θf < 0.01° at the first samples of a very shallow bend),
  `ramY = tipY + punch.height`, `pieces = partSilhouette(folded, pose, t)`.
- Obstacles: `machineObstacles(machine, setup, library, ramY, fingers)`; the station's punch
  obstacle gets the punch piece's Z range; fingers sit at the gauge position for φ = 0 and at
  `x + retractAtPinch` for φ > 0 when `machine.backgauge.retractAtPinch > 0`.
- **Intended contacts are cut out of the obstacle polygons** (`cutBox`: half-plane clips, the
  pieces stay simple polygons; computed once per station in the tool's local frame): punch −
  `{ |x| ≤ V/2, y ≥ tipY − 0.5 }` (punch body half-width for hemming punches) — ONLY over the
  bend line's Z extent; beyond the line ends the whole punch counts; die − `{ |x| ≤
  shoulderTangentX + 2, y ≥ −(rs + 2) }`; finger − a 0.5 mm strip behind the stop face.
- **Z slicing**: pieces and obstacles carry Z ranges ('full' = everything); a pair is tested only
  when the ranges overlap. Flat regions, walls ∥ or ⊥ to the bed and zones with axis ∥ Z project
  exactly at every Z of their range; an oblique piece that reports a hit is re-checked with
  `partSilhouette(…, overlapBand)` before it counts (never over-reporting).
- A hit is `penetrationDepth > COLLISION_THRESHOLD (0.2)`. The first hit per obstacle kind gives
  a `CollisionReport { with, atFraction (of the formed angle), location, depth, severity,
  message }` — `location` = `overlapLocation` (mean of boundary crossings / contained vertices,
  z = the overlap band centre); severity `'warning'` for fingers (the step also gets
  `warnings.gauge.retractSuggested`), `'error'` otherwise; message key `collisions.<kind>` with
  `{bendId, atFraction, depth, x, y, z}`. `stopAtError` (search mode) stops after the first error;
  the chosen steps are re-swept fully for the program. `partHeight` = max Y over the sweep.
- Not modelled: part self-collision (`'self'`).

## 4. Backgauge (`backgauge.ts`)

`planBackgauge(ctx, { bend, station, details, folded, pieces })` on the FOLDED silhouette at the
placement (f = 0):
- The gauged edge = pieces reaching the global max X within 0.05 mm; the contact piece prefers
  flanges over zones, then the largest Y extent at the max X. `gaugeContact`: zone ⇒ `'radius'`
  (+ `warnings.gauge.radiusContact`); flange with contact extent ≤ t + 0.5 ⇒ `'cut-edge'`; taller
  ⇒ `'flange-face'`; no piece ⇒ `'none'` (`warnings.gauge.noContact`).
- R (rounded to 0.5 mm): cut-edge / radius ⇒ the stop face centred on the contact extent (flat
  sheet: `−(stopHeight − t)/2`); flange-face ⇒ `faceBottom + 2` for a standing wall (= `ri + t +
  2`), `faceTop − 2 − stopHeight` for a hanging wall; clamped to `[rMin, rMax]`
  (`warnings.gauge.rOutOfRange`, error, when the stop face then misses the contact by more than
  3 mm of overlap). The finger body is checked against the die profile (mirrored when
  `dieFlipped`) and the holder when `X < die.bodyWidth/2 + bodyDepth`: a hit raises R to 0 (the
  finger skims the die top to reach a short leg — `warnings.gauge.fingerOverDie {finger, x, r}`,
  info, costed) when that still contacts, else `warnings.gauge.fingerHitsDie` (error).
- X = the contact X (rounded to 0.01; the edge/face touches the stop face exactly, a 0-depth
  contact in the sweep). Outside `[xMin, xMax]` ⇒ `warnings.gauge.outOfRange {x, xMin, xMax}`
  (error).
- Finger Z: nominal positions at ¼ / ¾ of the gauged edge's Z extent (evenly for other finger
  counts; one centred finger when the extent < 2·width). A position is valid when the finger
  lies inside the edge extent (unless the edge is narrower), the contact across the finger width
  is straight (max − min of the per-sub-interval max X within the stop band ≤ 0.05) and
  continuous, the sheet is solid behind the stop face (samples every 2 mm in depth × 2.5 mm
  across over `x ∈ [X − stopHeight, X]` — flat edges — or the stop band — faces — must lie in
  some flange region outside its holes or in a zone piece: a hole, notch or relief rejects the
  position, so the tabbed plate's hole at v = 60 pushes the ¾ finger away), and the finger
  polygon does not penetrate the silhouette in its band. The nominal pair is tried first;
  otherwise candidates are searched outward in 2.5 mm steps (≥ `width` apart, minimum total
  displacement; `warnings.gauge.fingerMoved {finger, from, to}`), then one finger nearest the
  edge centre (`warnings.gauge.singleFinger`), else the nominal positions with
  `warnings.gauge.contactNotStraight`. Fingers beyond `[zMin, zMax]` ⇒ `warnings.gauge.zOutOfRange`
  (error).
- All fingers of a step share X and R (they gauge the same edge), so `independentX/R` never
  matters here; the backgauge beam is an obstacle of the sweep (`collisions.backgauge-beam`).
- The leg check uses `flangeExtentFromBend(part, flangeId, bendId).max + OSSB.value − BA/2` per
  flange (the flat material on the die side); the printed `gaugedFlangeOutside` is the check
  dimension to the gauge contact (§6); `dimensionRef = OSSB.ref`. Finger `z` is absolute machine Z.

## 5. Search (`evaluate.ts`, `search.ts`)

`evaluate(bendIndex, doneMask, gaugedSide, stationIndex, full?)` is memoised: placement → station
analysis → backgauge → sweep → legs (`legCheck` on BOTH legs: outside dimensions vs `minLeg`,
`warnings.bend.legTooShort` error / `warnings.bend.legShort` warning `{bendId, flangeId, outside,
minLeg}`) → force vs capacity (`warnings.machine.capacity {force, capacity, percent}`: error
> 100 %, warning > 90 %) and tool ratings (`toolLoadCheck` messages). Order-independent cost:

`cost = shortFlange·(legWarnings + 2·legErrors) + collisionWarning·(warning collisions) +
vPreference + 0.5·bottoming + gaugeQuality + 0.05·(1 − gaugedArea/partArea) + 0.2·(flanges
already bent that point below the die plane) + 1e6·hardErrors`, with `gaugeQuality` =
`GAUGE_WARNING_COST` (1) per radius / not-straight / no-contact gauge, `FINGER_OVER_DIE_COST`
(0.75) for a finger skimming the die top and `SINGLE_FINGER_COST` (0.5) for a single-finger gauge
— a clean two-finger cut-edge or wall-face contact wins when everything else is equal.

Hard errors: error collisions, angle not fitting, station too short, a leg below `minLeg` (it
slips off the shoulder before the loaded angle — the search then moves to a narrower mounted V),
gauge out of range / finger hits die / Z out of range, force > capacity, load > tool rating.
They never make a feasible step lose to an infeasible one, yet a program is always produced.

Order search: a step's total = evaluation cost + `manipulationCost` (`flip` for both flips,
`rotate` for rotate180, `stationChange`) from `classifyTurn` of consecutive placements +
tie-breakers `1e-3·(n − p)/n·minLeg` (shorter legs first) and `1e-2·(n − p)/n·(maxDepth −
depth)` (leaf bends before root bends; depth = the child flange's depth). Exhaustive DFS with
branch-and-bound (children cheapest first, `partial ≥ best ⇒ prune`) for ≤ 7 bends — verified
against brute force on the box and a 4-bend corrugation — switching to a beam search of width
40 when more than `maxSequences` partial sequences were explored or n > 7. `fixedOrder` keeps the
given order (unknown ids ignored, missing bends appended) and picks side/station greedily.
`stats.sequencesEvaluated` counts explored partial + complete sequences (beam: states).

## 6. Program assembly (`program.ts`)

The chosen steps are re-evaluated with a full sweep and turned into `BendStep`s: `targetAngle`
(the formed angle: the bend angle, or the hem pre-bend angle), `includedAngle = 180 −
targetAngle`, `springback / overbendAngle / loadedIncludedAngle`, `actualInnerRadius`, `ramDepth`
(incl. `yCorrection`), `pinchY = punch.height + t`, `ramUpperLimit = max(pinchY + 5,
min(tdcClampY, max(insertionHeight, finishedHeight) + 20 + punch.height))` with `tdcClampY =
machineLevels(machine, die.height, punch.height).tdcClampY` (= daylight − holderHeight −
die.height above the die shoulder plane), `insertionHeight` = the part's max Y at the placement
and `finishedHeight` = its max Y over the sweep; `force / forcePerMeter / loadPercentOfTool`;
`bendLength`, `punchLength / segments / partZOffset`; `backgauge / gaugeContact`;
`gaugedFlangeOutside` = the caliper check dimension `X − BA/2 + OSSB` from this bend's virtual
sharp / tangent to what the fingers touch (the cut edge, a standing wall's outer face — e.g. 80
for the U-channel base gauged against its first wall — or the radius extreme; the gauged
flange's own extent when nothing is gauged) / `bendDeduction (drawing ri) / dimensionRef`;
`orientation = { faceUp:
flipped ? 'bottom' : 'top', backFlangeId: gaugedFlangeId }`; `manipulation`; `bottoming`;
`collisions`; `warnings` = evaluation warnings + `warnings.bend.radiusMismatch {bendId, drawing,
actual, flangeError = ΔBA/2}` when `|riActual − ri| > max(0.25·t, 0.2·ri)` +
`warnings.machine.daylight` (error for the insertion height — hard; warning when only the
finished part exceeds the daylight: it must be tilted out) + `warnings.machine.stroke` (error).
Numbers are rounded to 0.01.

`feasible` = no error collision, no hard error in any step (angle, force, ratings, gauge, legs,
daylight, stroke, station length), every bendable bend planned (`warnings.planner.noStation
{bendId}` otherwise; `warnings.planner.infeasible` on the program when false). `maxForce` = max
step force. `stats = { sequencesEvaluated, timeMs }`.

**Hems** (`angle = 180`): the search treats the hem as one entry with the pre-bend geometry
(`HEM_PREBEND = 150°` from flat, lowered to `179 − max(tipAngle, vAngle) − springback` on the
chosen station; a station that cannot reach `HEM_PREBEND_MIN = 135°` does not fit ⇒
`warnings.tool.angle`). The program then holds the pre-bend step (kind 'bend', `targetAngle` =
the pre-bend angle) immediately followed by a `hem-flatten` step on the station with
`die.family === 'hemming'` (none ⇒ `warnings.tool.noHemmingStation`, infeasible; the step then
carries the pre-bend's tools): same orientation re-centred in the hemming station (turn 'none',
`stationChange`), no backgauge (`gaugeContact 'none'`), `force = hemFlattenForce`, `ramDepth =
−(2t + hemGap)` (+ yCorrection), `pinchY = punch.height + hem height`, `targetAngle 180`,
`loadedIncludedAngle 0`, collisions from a 6-sample closing sweep.

## 7. Timeline (`timeline.ts`)

`buildTimeline(program, part, material, machine, library)` → `SimKeyframe[]`, 25 keyframes per
phase (`t` 0…1 inclusive), `timeS` monotonic, `ramY` and `partTransform` continuous at every
phase boundary within a step. Per step, in order:
1. `reposition` (only when `manipulation.turn ≠ 'none'`): the part rotates about its centre
   from the previous step's finished pose to the parked orientation while the centre glides to
   the parked position; `TURN_TIME_S = 1.5`.
2. `position`: from the previous finished pose (or the parked pose after a turn) via the parked
   pose (`PARK_OFFSET = (−300, +200, 0)` from the placement) to `GAUGE_APPROACH = 20 mm` in front
   of the placement; `HANDLING_SPEED = 300 mm/s`.
3. `gauge`: fingers move from the previous setting to the step's setting (`backgauge.speed`)
   while the part slides +X the last 20 mm; the placement collisions appear at the end. A step
   without gauging (hem-flatten) keeps the previous finger positions (and never retracts them).
4. `approach`: ramY from the previous step's `ramUpperLimit` (TDC for the first step) to
   `punchTipY(fStart) + punch.height` (= `pinchY` before rounding) at `speeds.approach`.
5. `bend`: f 0 → `overbendAngle/angle`; `partTransform = bendPose(placement, folded_f, bendId, f,
   punchTipY(f), t)`, `ramY = punchTipY(f) + punch.height`; fingers move +X by `retractAtPinch`
   over the first 10 % when > 0; time = ram travel ÷ `speeds.bend` (≥ 0.5 s); collisions whose
   `atFraction ≤` the current fraction of the formed angle are active (hem-flatten reports carry
   the fold fraction itself).
6. `release`: f relaxes to `targetAngle/angle` while ramY rises `RELEASE_RISE = 5` mm.
7. `retract`: ramY → `ramUpperLimit`; the part keeps the pose at f = 1.
Hem-flatten steps: no rotation, f from the pre-bend fraction to 1 with the punch face on the hem
(`ramY = hem top + punch.height`; the modelled hem top is `2t + 2·ri` for the drawn radius while
the programmed `ramDepth` is the shop number `−(2t + gap)`). `foldState` = previous bends 1, current bend f, others 0;
`pose = mat4.decompose(partTransform)` (round-trips through `compose`).

## 8. i18n keys introduced (ui adds en/th)

`warnings.planner.bendSkipped {bendId}`, `warnings.planner.noStation {bendId}`,
`warnings.planner.infeasible`,
`warnings.tool.angle {bendId, stationId, punchAngle, vAngle, loadedAngle}` (error),
`warnings.tool.bottoming {…same}` (info), `warnings.tool.tooShort {bendId, stationId,
stationLength, required}`, `warnings.tool.noHemmingStation {bendId}`,
`warnings.bend.legTooShort {bendId, flangeId, outside, minLeg}`, `warnings.bend.legShort {…}`,
`warnings.bend.radiusMismatch {bendId, drawing, actual, flangeError}`,
`warnings.machine.capacity {force, capacity, percent}`,
`warnings.gauge.outOfRange {x, xMin, xMax}`, `warnings.gauge.rOutOfRange {r, rMin, rMax}`,
`warnings.gauge.zOutOfRange {z, zMin, zMax}`, `warnings.gauge.noContact`,
`warnings.gauge.radiusContact {bendId}`, `warnings.gauge.singleFinger {bendId}`,
`warnings.gauge.contactNotStraight {bendId}`, `warnings.gauge.fingerMoved {finger, from, to}`
(info), `warnings.gauge.fingerOverDie {finger, x, r}` (info), `warnings.gauge.fingerHitsDie
{finger}`, `warnings.gauge.retractSuggested {bendId}`,
`collisions.punch / clamp / ram / die / holder / table / finger / backgauge-beam / frame
{bendId, atFraction, depth, x, y, z}` (finger: warning, others error).
Reused: `warnings.tool.overload`, `warnings.tool.loadNearLimit`, `warnings.machine.daylight`,
`warnings.machine.stroke`, `warnings.setup.*`, `warnings.part.*`.

## 9. Tests and performance

`npx vitest run src/core/planner` (78 tests): placement, stations (goldens, Z-clearance,
segment DP), backgauge, collision sweeps (box walls, 400 mm box vs clamp/ram, tabbed plate),
search (beam fallback, brute-force optimality, 5/8-bend corrugations), hems, retract, all
sample programs and timelines, plus the reviewer's `review.test.ts`: sub-threshold and > 31
bends, 10°/45°/120° bends, 1/16 in thickness, angle corrections, empty inputs, turn
classification, leg hard errors moving to a narrower V, check dimensions, gauge costs, gooseneck
relief (normal / flipped), reversed-line / mirrored-flat / reversed-tool invariances, hanging
walls, finger counts, the corner-tab punch piece, the station-centred piece invariant and the
hem timeline. Sample outcomes with the standard library, default machine and
one station of `expected.defaultSetup` over the bed: L-bracket feasible (long leg gauged,
X = 58.26, R = −9, cut-edge, ramDepth 4.26, force 11.93 kN); U-channel 2 steps, 0 flips;
Z-bracket 1 flip; box 4 steps, punches 190 / 140 mm; tabbed plate 1 step, punch 25 mm, one
finger; acute bracket infeasible on 88° tools, feasible on `std:punch-acute-30-r0.8` +
`std:die-v12-30`; **hat-channel: infeasible on the 60 mm wide standard V16 die** (the brim /
crown hanging beside the wall lands 26–28 mm from the bend line, inside the die body: a
physical `collisions.die` error whichever order is used); feasible with 1 flip on a 50 mm wide
V16 body (`vDie({ vWidth: 16, bodyWidth: 50 })`).
Timing on the 2-CPU box (tsx): L 45 ms, box 0.45 s, hat 0.35 s, 7-bend corrugation 1.7 s
(exhaustive), 8-bend 1.3 s (beam). The box is planned in < 2 s under vitest as well.
