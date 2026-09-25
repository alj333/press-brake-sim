/**
 * Feasibility advisor — diagnoses a failed program, verifies bounded setup alternatives with the
 * canonical planner, and (only when stocked tools cannot solve it) produces clearly-labelled
 * geometry hypotheses. A hypothesis is never added to the library or mounted automatically.
 */
import type {
  BendProgram, Die, Message, ObstacleKind, Punch, ToolSetup, ToolStation, Vec3,
} from '../types';
import { segmentsForLength, vDie } from '../tools';
import { planProgram } from './program';
import type { PlannerInput } from './context';

export type RecommendationOutcome = 'feasible' | 'improved' | 'custom-required';
export type RecommendationSource = 'library-simulated' | 'geometry-hypothesis';

export interface FeasibilityIssueSummary {
  hardErrors: number;
  warningCount: number;
  bends: string[];
  obstacles: ObstacleKind[];
}

export interface RecommendationChange {
  stationId: string;
  kind: 'punch' | 'die';
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
}

export interface ToolGeometryComparison {
  kind: 'die';
  current: Die;
  proposed: Die;
  /** Actual collision reported by the baseline planner, in machine-section X/Y. */
  collision: Vec3 | null;
  firstModelPassingBodyWidth: number;
  conceptBodyWidth: number;
}

export interface FeasibilityRecommendation {
  id: string;
  outcome: RecommendationOutcome;
  source: RecommendationSource;
  /** True means this exact setup/profile was run through planProgram at the normal sweep. */
  simulationTested: boolean;
  /** Geometry hypotheses are never production-verified, even when the simulation passes. */
  productionVerified: boolean;
  variant: 'stocked-tool' | 'minimal-change' | 'angle-margin' | 'partial-improvement';
  changes: RecommendationChange[];
  candidateSetup?: ToolSetup;
  geometry?: ToolGeometryComparison;
  errorsBefore: number;
  errorsAfter: number;
  warningsAfter: number;
  maxForce: number;
  requiredLoadPerMeter: number;
  bottomingSteps: number;
  residualWarnings: Message[];
  suggestedBackgaugeRetract?: number;
}

export interface FeasibilityReport {
  state: 'already-feasible' | 'recommendations' | 'no-solution';
  issues: FeasibilityIssueSummary;
  testedCandidates: number;
  noLibrarySolution: boolean;
  recommendations: FeasibilityRecommendation[];
}

export interface FeasibilityProgress {
  phase: 'library' | 'geometry';
  done: number;
  total: number;
}

interface CandidateJob {
  id: string;
  setup: ToolSetup;
  changes: RecommendationChange[];
}

interface ProgramScore {
  hardErrors: number;
  warningCount: number;
  bottomingSteps: number;
  residualWarnings: Message[];
  requiredLoadPerMeter: number;
}

function cloneSetup(setup: ToolSetup): ToolSetup {
  return { ...setup, stations: setup.stations.map(station => ({ ...station, segments: [...station.segments] })) };
}

function uniqueMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages.filter(message => {
    const key = `${message.key}:${JSON.stringify(message.params ?? {})}:${message.severity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreProgram(program: BendProgram): ProgramScore {
  // `warnings.planner.infeasible` is a summary sentinel for the detailed step failures below;
  // counting it as another hard error would make two die collisions read as "3 errors".
  const programErrors = program.warnings.filter(message => message.severity === 'error' && message.key !== 'warnings.planner.infeasible');
  const stepErrors = program.steps.flatMap(step => step.warnings.filter(message => message.severity === 'error'));
  const collisionErrors = program.steps.flatMap(step => step.collisions.filter(collision => collision.severity === 'error'));
  const residualWarnings = uniqueMessages([
    ...program.warnings.filter(message => message.severity !== 'error'),
    ...program.steps.flatMap(step => step.warnings.filter(message => message.severity !== 'error')),
    ...program.steps.flatMap(step => step.collisions.filter(collision => collision.severity !== 'error').map(collision => collision.message)),
  ]);
  return {
    hardErrors: programErrors.length + stepErrors.length + collisionErrors.length || (program.feasible ? 0 : 1),
    warningCount: residualWarnings.length,
    bottomingSteps: program.steps.filter(step => step.bottoming).length,
    residualWarnings,
    requiredLoadPerMeter: Math.max(0, ...program.steps.map(step => step.forcePerMeter)),
  };
}

function issueSummary(program: BendProgram): FeasibilityIssueSummary {
  const score = scoreProgram(program);
  const errors = program.steps.flatMap(step => step.collisions.filter(collision => collision.severity === 'error'));
  return {
    hardErrors: score.hardErrors,
    warningCount: score.warningCount,
    bends: [...new Set(program.steps.filter(step =>
      step.collisions.some(collision => collision.severity === 'error') || step.warnings.some(message => message.severity === 'error'),
    ).map(step => step.bendId))].sort(),
    obstacles: [...new Set(errors.map(error => error.with))].sort(),
  };
}

function stationWithPunch(station: ToolStation, punch: Punch): ToolStation | null {
  const length = Math.abs(station.zEnd - station.zStart);
  const pieces = punch.segmentLengths.filter(piece => piece > 0 && piece <= 835);
  const available = pieces.length > 0 ? pieces : punch.segmentLengths.filter(piece => piece > 0);
  const segments = available.length > 0 ? segmentsForLength(length, available) : [];
  const sum = segments.reduce((total, piece) => total + piece, 0);
  if (segments.length > 0 && Math.abs(sum - length) > 0.5) return null;
  return { ...station, punchId: punch.id, segments };
}

function replaceStation(setup: ToolSetup, stationId: string, replacement: ToolStation): ToolSetup {
  return { ...setup, stations: setup.stations.map(station => station.id === stationId ? replacement : { ...station, segments: [...station.segments] }) };
}

function buildLibraryJobs(input: PlannerInput, baseline: BendProgram): CandidateJob[] {
  const hardCollisionSteps = baseline.steps.filter(step => step.collisions.some(collision => collision.severity === 'error'));
  const affected = new Set((hardCollisionSteps.length > 0 ? hardCollisionSteps : baseline.steps).map(step => step.stationId));
  const obstacles = new Set(hardCollisionSteps.flatMap(step => step.collisions.filter(collision => collision.severity === 'error').map(collision => collision.with)));
  const angleError = baseline.steps.some(step => step.warnings.some(message => message.severity === 'error' && message.key === 'warnings.tool.angle'));
  const scanDies = obstacles.size === 0 || obstacles.has('die') || angleError;
  const scanPunches = obstacles.size === 0 || ['punch', 'ram', 'clamp', 'holder'].some(kind => obstacles.has(kind as ObstacleKind)) || angleError;
  const jobs: CandidateJob[] = [];
  const seen = new Set<string>();
  const add = (job: CandidateJob): void => {
    const key = JSON.stringify(job.setup.stations.map(station => [station.id, station.punchId, station.dieId, station.punchFlipped, station.dieFlipped, station.segments]));
    if (!seen.has(key)) { seen.add(key); jobs.push(job); }
  };

  for (const station of [...input.setup.stations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!affected.has(station.id)) continue;
    const currentPunch = input.library.punches.find(punch => punch.id === station.punchId);
    const currentDie = input.library.dies.find(die => die.id === station.dieId);
    if (!currentPunch || !currentDie) continue;
    if (scanDies) {
      for (const die of [...input.library.dies].sort((a, b) => a.id.localeCompare(b.id))) {
        if (die.id === currentDie.id || die.family === 'hemming' || !(die.vWidth > 0)) continue;
        add({
          id: `die:${station.id}:${die.id}`,
          setup: replaceStation(input.setup, station.id, { ...station, dieId: die.id, segments: [...station.segments] }),
          changes: [{ stationId: station.id, kind: 'die', fromId: currentDie.id, fromName: currentDie.name, toId: die.id, toName: die.name }],
        });
      }
    }
    if (scanPunches) {
      for (const punch of [...input.library.punches].sort((a, b) => a.id.localeCompare(b.id))) {
        if (punch.id === currentPunch.id || punch.family === 'hemming' || !(punch.tipAngle < 180)) continue;
        const next = stationWithPunch(station, punch);
        if (!next) continue;
        add({
          id: `punch:${station.id}:${punch.id}`,
          setup: replaceStation(input.setup, station.id, next),
          changes: [{ stationId: station.id, kind: 'punch', fromId: currentPunch.id, fromName: currentPunch.name, toId: punch.id, toName: punch.name }],
        });
      }
    }
    if (angleError) {
      const loadedLimit = Math.min(...baseline.steps.filter(step => step.stationId === station.id).map(step => step.loadedIncludedAngle));
      const punches = input.library.punches.filter(punch => punch.family !== 'hemming' && punch.tipAngle < loadedLimit - 0.25).sort((a, b) => b.tipAngle - a.tipAngle || a.id.localeCompare(b.id)).slice(0, 4);
      const dies = input.library.dies.filter(die => die.family !== 'hemming' && die.vWidth > 0 && die.vAngle < loadedLimit - 0.25).sort((a, b) => Math.abs(a.vWidth - currentDie.vWidth) - Math.abs(b.vWidth - currentDie.vWidth) || b.vAngle - a.vAngle || a.id.localeCompare(b.id)).slice(0, 6);
      for (const punch of punches) for (const die of dies) {
        const next = stationWithPunch({ ...station, dieId: die.id }, punch);
        if (!next) continue;
        add({
          id: `pair:${station.id}:${punch.id}:${die.id}`,
          setup: replaceStation(input.setup, station.id, next),
          changes: [
            { stationId: station.id, kind: 'punch', fromId: currentPunch.id, fromName: currentPunch.name, toId: punch.id, toName: punch.name },
            { stationId: station.id, kind: 'die', fromId: currentDie.id, fromName: currentDie.name, toId: die.id, toName: die.name },
          ],
        });
      }
    }
  }
  return jobs;
}

function toLibraryRecommendation(job: CandidateJob, baselineScore: ProgramScore, program: BendProgram, score: ProgramScore): FeasibilityRecommendation {
  const safe = program.feasible && score.hardErrors === 0;
  return {
    id: job.id.replace(/[^a-zA-Z0-9_-]+/g, '-'),
    outcome: safe ? 'feasible' : 'improved',
    source: 'library-simulated',
    simulationTested: true,
    productionVerified: false,
    variant: safe ? 'stocked-tool' : 'partial-improvement',
    changes: job.changes,
    candidateSetup: cloneSetup(job.setup),
    errorsBefore: baselineScore.hardErrors,
    errorsAfter: score.hardErrors,
    warningsAfter: score.warningCount,
    maxForce: program.maxForce,
    requiredLoadPerMeter: score.requiredLoadPerMeter,
    bottomingSteps: score.bottomingSteps,
    residualWarnings: score.residualWarnings,
  };
}

function runGeometryCandidate(
  input: PlannerInput,
  station: ToolStation,
  die: Die,
  punch: Punch,
  signal?: AbortSignal,
): { program: BendProgram; setup: ToolSetup; score: ProgramScore } | null {
  const mounted = stationWithPunch({ ...station, dieId: die.id }, punch);
  if (!mounted) return null;
  const setup = replaceStation(input.setup, station.id, mounted);
  const library = {
    ...input.library,
    punches: input.library.punches.some(item => item.id === punch.id) ? input.library.punches : [...input.library.punches, punch],
    dies: [...input.library.dies.filter(item => item.id !== die.id), die],
  };
  const program = planProgram({ ...input, setup, library }, signal);
  return { program, setup, score: scoreProgram(program) };
}

function hypothesis(
  input: PlannerInput,
  baseline: BendProgram,
  baselineScore: ProgramScore,
  station: ToolStation,
  currentDie: Die,
  punch: Punch,
  proposedDie: Die,
  firstPassing: number,
  variant: 'minimal-change' | 'angle-margin',
  run: { program: BendProgram; setup: ToolSetup; score: ProgramScore },
): FeasibilityRecommendation {
  const collision = baseline.steps
    .filter(step => step.stationId === station.id)
    .flatMap(step => step.collisions)
    .find(report => report.severity === 'error' && report.with === 'die')?.location ?? null;
  const changes: RecommendationChange[] = [];
  const currentPunch = input.library.punches.find(item => item.id === station.punchId);
  if (currentPunch && currentPunch.id !== punch.id) changes.push({ stationId: station.id, kind: 'punch', fromId: currentPunch.id, fromName: currentPunch.name, toId: punch.id, toName: punch.name });
  changes.push({ stationId: station.id, kind: 'die', fromId: currentDie.id, fromName: currentDie.name, toId: proposedDie.id, toName: proposedDie.name });
  const retractSuggested = run.score.residualWarnings.some(message => message.key === 'warnings.gauge.retractSuggested');
  return {
    id: `custom-${variant}-${station.id}`,
    outcome: 'custom-required',
    source: 'geometry-hypothesis',
    simulationTested: true,
    productionVerified: false,
    variant,
    changes,
    geometry: {
      kind: 'die', current: currentDie, proposed: proposedDie, collision,
      firstModelPassingBodyWidth: firstPassing, conceptBodyWidth: proposedDie.bodyWidth,
    },
    errorsBefore: baselineScore.hardErrors,
    errorsAfter: run.score.hardErrors,
    warningsAfter: run.score.warningCount,
    maxForce: run.program.maxForce,
    requiredLoadPerMeter: run.score.requiredLoadPerMeter,
    bottomingSteps: run.score.bottomingSteps,
    residualWarnings: run.score.residualWarnings,
    ...(retractSuggested ? { suggestedBackgaugeRetract: Math.max(5, input.machine.backgauge.retractAtPinch) } : {}),
  };
}

/**
 * Run the bounded recommendation graph. Every applicable result is independently rebuilt with
 * planProgram. Geometry hypotheses deliberately omit candidateSetup so the UI cannot mount them.
 */
export function recommendSetups(
  input: PlannerInput,
  baseline: BendProgram,
  signal?: AbortSignal,
  onProgress?: (progress: FeasibilityProgress) => void,
): FeasibilityReport {
  const issues = issueSummary(baseline);
  const baselineScore = scoreProgram(baseline);
  if (baseline.feasible && baselineScore.hardErrors === 0) {
    return { state: 'already-feasible', issues, testedCandidates: 0, noLibrarySolution: false, recommendations: [] };
  }

  const jobs = buildLibraryJobs(input, baseline);
  const results: FeasibilityRecommendation[] = [];
  let tested = 0;
  onProgress?.({ phase: 'library', done: 0, total: jobs.length });
  for (const job of jobs) {
    if (signal?.aborted) { const error = new Error('feasibility analysis cancelled'); error.name = 'AbortError'; throw error; }
    const program = planProgram({ ...input, setup: job.setup }, signal);
    const score = scoreProgram(program);
    tested += 1;
    if ((program.feasible && score.hardErrors === 0) || score.hardErrors < baselineScore.hardErrors) {
      results.push(toLibraryRecommendation(job, baselineScore, program, score));
    }
    onProgress?.({ phase: 'library', done: tested, total: jobs.length });
  }
  const verified = results.filter(result => result.outcome === 'feasible').sort((a, b) =>
    a.changes.length - b.changes.length || a.warningsAfter - b.warningsAfter || a.maxForce - b.maxForce || a.id.localeCompare(b.id),
  );
  if (verified.length > 0) {
    return { state: 'recommendations', issues, testedCandidates: tested, noLibrarySolution: false, recommendations: verified.slice(0, 3) };
  }

  const geometryResults: FeasibilityRecommendation[] = [];
  const dieStations = [...new Set(baseline.steps.filter(step => step.collisions.some(collision => collision.severity === 'error' && collision.with === 'die')).map(step => step.stationId))];
  onProgress?.({ phase: 'geometry', done: 0, total: dieStations.length });
  let geometryDone = 0;
  for (const stationId of dieStations) {
    const station = input.setup.stations.find(item => item.id === stationId);
    const currentDie = station ? input.library.dies.find(item => item.id === station.dieId) : undefined;
    const currentPunch = station ? input.library.punches.find(item => item.id === station.punchId) : undefined;
    if (!station || !currentDie || !currentPunch || currentDie.family !== 'v' || !(currentDie.vWidth > 0)) { geometryDone += 1; continue; }

    let firstPassing: { width: number; run: ReturnType<typeof runGeometryCandidate>; die: Die } | null = null;
    const floor = Math.max(currentDie.vWidth + 4, 20);
    for (let width = Math.floor(currentDie.bodyWidth - 2); width >= floor; width -= 2) {
      const die = vDie({ vWidth: currentDie.vWidth, vAngle: currentDie.vAngle, shoulderRadius: currentDie.shoulderRadius, height: currentDie.height, bodyWidth: width }, {
        id: `advice:die-${station.id}-${width}`, name: `Concept V${currentDie.vWidth} ${currentDie.vAngle}° narrow body ${width} mm`, source: 'custom', maxLoadPerMeter: currentDie.maxLoadPerMeter,
      });
      const run = runGeometryCandidate(input, station, die, currentPunch, signal);
      tested += 1;
      if (run && run.program.feasible && run.score.hardErrors === 0) { firstPassing = { width: die.bodyWidth, run, die }; break; }
    }
    if (firstPassing?.run) {
      const conceptWidth = Math.max(floor, firstPassing.width - 2);
      const conceptDie = vDie({ vWidth: currentDie.vWidth, vAngle: currentDie.vAngle, shoulderRadius: currentDie.shoulderRadius, height: currentDie.height, bodyWidth: conceptWidth }, {
        id: `advice:die-${station.id}-concept`, name: `Concept V${currentDie.vWidth} ${currentDie.vAngle}° narrow body ${conceptWidth} mm`, source: 'custom', maxLoadPerMeter: currentDie.maxLoadPerMeter,
      });
      const conceptRun = runGeometryCandidate(input, station, conceptDie, currentPunch, signal);
      tested += 1;
      if (conceptRun && conceptRun.program.feasible && conceptRun.score.hardErrors === 0) {
        geometryResults.push(hypothesis(input, baseline, baselineScore, station, currentDie, currentPunch, conceptDie, firstPassing.width, 'minimal-change', conceptRun));
      }

      if (baseline.steps.some(step => step.stationId === station.id && step.bottoming)) {
        const marginPunch = [...input.library.punches]
          .filter(punch => punch.family !== 'hemming' && punch.tipAngle < currentPunch.tipAngle && punch.tipAngle >= 80)
          .sort((a, b) => b.tipAngle - a.tipAngle || a.id.localeCompare(b.id))[0];
        if (marginPunch) {
          const marginDie = vDie({ vWidth: currentDie.vWidth, vAngle: marginPunch.tipAngle, shoulderRadius: currentDie.shoulderRadius, height: currentDie.height, bodyWidth: conceptWidth }, {
            id: `advice:die-${station.id}-angle-margin`, name: `Concept V${currentDie.vWidth} ${marginPunch.tipAngle}° narrow body ${conceptWidth} mm`, source: 'custom', maxLoadPerMeter: currentDie.maxLoadPerMeter,
          });
          const marginRun = runGeometryCandidate(input, station, marginDie, marginPunch, signal);
          tested += 1;
          if (marginRun && marginRun.program.feasible && marginRun.score.hardErrors === 0) {
            geometryResults.push(hypothesis(input, baseline, baselineScore, station, currentDie, marginPunch, marginDie, firstPassing.width, 'angle-margin', marginRun));
          }
        }
      }
    }
    geometryDone += 1;
    onProgress?.({ phase: 'geometry', done: geometryDone, total: dieStations.length });
  }

  geometryResults.sort((a, b) => a.bottomingSteps - b.bottomingSteps || a.warningsAfter - b.warningsAfter || a.changes.length - b.changes.length || a.id.localeCompare(b.id));
  if (geometryResults.length > 0) {
    return { state: 'recommendations', issues, testedCandidates: tested, noLibrarySolution: true, recommendations: geometryResults.slice(0, 3) };
  }
  const improved = results.filter(result => result.outcome === 'improved').sort((a, b) => a.errorsAfter - b.errorsAfter || a.warningsAfter - b.warningsAfter || a.id.localeCompare(b.id)).slice(0, 2);
  return { state: 'no-solution', issues, testedCandidates: tested, noLibrarySolution: true, recommendations: improved };
}
