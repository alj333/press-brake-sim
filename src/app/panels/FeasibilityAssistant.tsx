/** Infeasible-program assistant: full-planner setup search, evidence, and tool-profile graphics. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BendProgram, CollisionReport } from '../../core/types';
import { recommendSetups } from '../../core/planner';
import type { FeasibilityProgress, FeasibilityRecommendation, FeasibilityReport, PlannerInput } from '../../core/planner';
import { useI18n } from '../../i18n';
import { Dialog } from '../components/Dialog';
import { ToolChangeGraphic } from '../components/ToolChangeGraphic';
import { fmt } from '../format';
import { selectMachine, selectMaterial, useProjectStore } from '../store';
import type { FeasibilityWorkerResponse } from '../feasibility.worker';

type AnalysisState = 'idle' | 'analysing' | 'ready' | 'error';

interface AnalysisSource {
  program: BendProgram;
  part: object;
  setup: object;
  machine: object;
  plannerOptions: object;
  simLibrary: object;
}

function recommendationTitleKey(recommendation: FeasibilityRecommendation): string {
  if (recommendation.variant === 'angle-margin') return 'feasibility.option.angleMargin';
  if (recommendation.variant === 'minimal-change') return 'feasibility.option.minimalChange';
  if (recommendation.variant === 'partial-improvement') return 'feasibility.option.partial';
  return 'feasibility.option.stocked';
}

function hardCollisions(program: BendProgram): Array<{ bendId: string; collision: CollisionReport; stepIndex: number }> {
  return program.steps.flatMap(step => step.collisions
    .filter(collision => collision.severity === 'error')
    .map(collision => ({ bendId: step.bendId, collision, stepIndex: step.index })));
}

function RecommendationGraphic({ recommendation, expanded = false }: { recommendation: FeasibilityRecommendation; expanded?: boolean }) {
  const { t } = useI18n();
  if (!recommendation.geometry) return null;
  const geometry = recommendation.geometry;
  const removedPerSide = (geometry.current.bodyWidth - geometry.proposed.bodyWidth) / 2;
  return (
    <div className={expanded ? 'guidance-graphic-expanded' : ''}>
      <ToolChangeGraphic
        geometry={geometry}
        title={t('feasibility.graphic.title')}
        description={t('feasibility.graphic.description', {
          current: fmt(geometry.current.bodyWidth, 1), proposed: fmt(geometry.proposed.bodyWidth, 1), side: fmt(removedPerSide, 1),
        })}
        currentLabel={t('feasibility.graphic.current')}
        proposedLabel={t('feasibility.graphic.concept')}
        collisionLabel={t('feasibility.graphic.collision')}
        removedLabel={t('feasibility.graphic.relief')}
      />
      <p className="small guidance-geometry-caption">
        {t('feasibility.geometry.spec', {
          v: fmt(geometry.proposed.vWidth, 1), angle: fmt(geometry.proposed.vAngle, 1), radius: fmt(geometry.proposed.shoulderRadius, 1),
          height: fmt(geometry.proposed.height, 1), body: fmt(geometry.proposed.bodyWidth, 1), boundary: fmt(geometry.firstModelPassingBodyWidth, 1),
        })}
      </p>
    </div>
  );
}

function RecommendationCard({ recommendation, onCompare, onApply, onOpenTools }: {
  recommendation: FeasibilityRecommendation;
  onCompare: () => void;
  onApply: () => void;
  onOpenTools: () => void;
}) {
  const { t, tm } = useI18n();
  const outcome = recommendation.outcome;
  return (
    <article
      className={`card feasibility-recommendation recommendation-${outcome}`}
      data-testid={`recommendation-card-${recommendation.id}`}
      data-outcome={outcome}
      data-tested={recommendation.simulationTested ? 'true' : 'false'}
    >
      <div className="row row-between row-wrap">
        <strong>{t(recommendationTitleKey(recommendation))}</strong>
        <span className={outcome === 'feasible' ? 'badge badge-ok' : outcome === 'improved' ? 'badge badge-warn' : 'badge badge-user'}>
          {t(`feasibility.outcome.${outcome}`)}
        </span>
      </div>
      <div className="guidance-change-list">
        {recommendation.changes.map((change, index) => (
          <div className="small" key={`${change.stationId}-${change.kind}-${change.toId}`} data-testid={`recommendation-change-${recommendation.id}-${index}`}>
            <span className="badge">{change.stationId}</span>{' '}
            <strong>{t(`common.${change.kind}`)}</strong>: {change.fromName} <span aria-hidden="true">→</span> {change.toName}
          </div>
        ))}
      </div>
      {recommendation.geometry && <RecommendationGraphic recommendation={recommendation} />}
      <dl className="guidance-metrics small">
        <div><dt>{t('feasibility.metric.errors')}</dt><dd>{recommendation.errorsBefore} → <strong>{recommendation.errorsAfter}</strong></dd></div>
        <div><dt>{t('feasibility.metric.force')}</dt><dd>{fmt(recommendation.maxForce, 1)} kN</dd></div>
        <div><dt>{t('feasibility.metric.requiredRating')}</dt><dd>≥ {fmt(recommendation.requiredLoadPerMeter, 1)} kN/m</dd></div>
        <div><dt>{t('feasibility.metric.warnings')}</dt><dd>{recommendation.warningsAfter}</dd></div>
      </dl>
      {recommendation.bottomingSteps > 0 && <p className="msg msg-warning small">⚠ {t('feasibility.bottoming', { count: recommendation.bottomingSteps })}</p>}
      {recommendation.suggestedBackgaugeRetract !== undefined && (
        <p className="msg msg-warning small" data-testid="feasibility-retract-suggestion">
          ⚠ {t('feasibility.retract', { amount: fmt(recommendation.suggestedBackgaugeRetract, 1) })}
        </p>
      )}
      {recommendation.residualWarnings.length > 0 && (
        <details className="details guidance-warnings">
          <summary>{t('feasibility.residualWarnings')} ({recommendation.residualWarnings.length})</summary>
          <ul className="messages">
            {recommendation.residualWarnings.map((message, index) => <li key={`${message.key}-${index}`} className="msg msg-warning small">{tm(message)}</li>)}
          </ul>
        </details>
      )}
      <div className="row row-wrap guidance-actions">
        {recommendation.geometry && <button type="button" className="btn btn-small" data-testid={`recommendation-compare-${recommendation.id}`} onClick={onCompare}>{t('feasibility.compare')}</button>}
        {recommendation.candidateSetup && recommendation.outcome === 'feasible' && (
          <button type="button" className="btn btn-primary btn-small" data-testid={`recommendation-apply-${recommendation.id}`} onClick={onApply}>{t('feasibility.applyReplan')}</button>
        )}
        {recommendation.source === 'geometry-hypothesis' && (
          <button type="button" className="btn btn-primary btn-small" data-testid="feasibility-open-tools" onClick={onOpenTools}>{t('feasibility.openTools')}</button>
        )}
      </div>
      <p className="small muted guidance-proof">
        {recommendation.source === 'geometry-hypothesis' ? t('feasibility.hypothesisProof') : t('feasibility.libraryProof')}
      </p>
    </article>
  );
}

export function FeasibilityAssistant({ program }: { program: BendProgram }) {
  const { t, tm } = useI18n();
  const project = useProjectStore(state => state.project);
  const simLibrary = useProjectStore(state => state.simLibrary);
  const machine = useProjectStore(selectMachine);
  const material = useProjectStore(selectMaterial);
  const actions = useProjectStore.getState();
  const [state, setState] = useState<AnalysisState>('idle');
  const [progress, setProgress] = useState<FeasibilityProgress | null>(null);
  const [report, setReport] = useState<FeasibilityReport | null>(null);
  const [error, setError] = useState('');
  const [comparison, setComparison] = useState<FeasibilityRecommendation | null>(null);
  const [source, setSource] = useState<AnalysisSource | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const collisions = useMemo(() => hardCollisions(program), [program]);

  const stop = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  useEffect(() => stop, [project.part, project.setup, machine, project.plannerOptions, simLibrary, program, stop]);

  const sourceIsCurrent = source?.program === program && source.part === project.part && source.setup === project.setup
    && source.machine === machine && source.plannerOptions === project.plannerOptions && source.simLibrary === simLibrary;
  const visibleState: AnalysisState = sourceIsCurrent ? state : 'idle';
  const visibleReport = sourceIsCurrent ? report : null;

  const analyse = async (): Promise<void> => {
    if (!project.part || !material || project.setup.stations.length === 0) return;
    stop();
    setState('analysing');
    setProgress(null);
    setReport(null);
    setError('');
    setComparison(null);
    setSource({ program, part: project.part, setup: project.setup, machine, plannerOptions: project.plannerOptions, simLibrary });
    const input: PlannerInput = { part: project.part, material, machine, setup: project.setup, library: simLibrary, options: project.plannerOptions };
    if (typeof Worker !== 'function') {
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        const next = recommendSetups(input, program, undefined, setProgress);
        setReport(next); setState('ready'); setProgress(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught)); setState('error'); setProgress(null);
      }
      return;
    }
    const worker = new Worker(new URL('../feasibility.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<FeasibilityWorkerResponse>): void => {
      if (workerRef.current !== worker) return;
      if (event.data.type === 'progress') { setProgress(event.data.progress); return; }
      worker.terminate(); workerRef.current = null; setProgress(null);
      if (event.data.type === 'done') { setReport(event.data.report); setState('ready'); }
      else { setError(event.data.message); setState('error'); }
    };
    worker.onerror = event => {
      if (workerRef.current !== worker) return;
      worker.terminate(); workerRef.current = null; setProgress(null); setError(event.message || 'worker error'); setState('error');
    };
    worker.postMessage({ type: 'analyse', input, baseline: program });
  };

  const cancel = (): void => {
    stop(); setState('idle'); setProgress(null); setError('');
  };
  const apply = (recommendation: FeasibilityRecommendation): void => {
    if (!recommendation.candidateSetup) return;
    actions.setSetup(recommendation.candidateSetup);
    void actions.plan();
  };
  const openTools = (): void => actions.setLeftTab('tools');
  const progressLabel = progress ? t(`feasibility.phase.${progress.phase}`, { done: progress.done, total: progress.total }) : t('common.working');

  return (
    <section className="panel-section feasibility-assistant" data-testid="feasibility-assistant" data-state={visibleState === 'ready' && visibleReport?.state === 'no-solution' ? 'no-solution' : visibleState}>
      <div className="row row-between row-wrap">
        <h3 className="section-title">{t('feasibility.title')}</h3>
        <span className="badge badge-error">{t('feasibility.blockingCount', { count: collisions.length })}</span>
      </div>
      <p className="small">{t('feasibility.intro')}</p>
      {collisions.length > 0 && (
        <details className="details" open data-testid="feasibility-blockers">
          <summary>{t('feasibility.why')}</summary>
          <ul className="messages">
            {collisions.map(({ bendId, collision, stepIndex }, index) => (
              <li key={`${bendId}-${collision.with}-${index}`} className="msg msg-error" data-testid={`feasibility-issue-${index}`} data-obstacle={collision.with}>
                <button type="button" className="msg-btn" onClick={() => actions.seekToCollision(program.steps[stepIndex]!, collision)}>
                  <span className="msg-icon msg-icon-error">✖</span>
                  <span className="msg-text"><strong>{bendId}</strong> · {tm(collision.message)}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="row row-wrap">
        <button type="button" className="btn btn-primary" disabled={visibleState === 'analysing'} data-testid="feasibility-analyse" onClick={() => { void analyse(); }}>
          {visibleState === 'ready' ? t('feasibility.analyseAgain') : t('feasibility.analyse')}
        </button>
        {visibleState === 'analysing' && <button type="button" className="btn" data-testid="feasibility-cancel" onClick={cancel}>{t('sequence.cancel')}</button>}
        {visibleState === 'analysing' && <span className="small muted busy" role="status" aria-live="polite" data-testid="feasibility-progress">{progressLabel}</span>}
      </div>
      {visibleState === 'error' && <p className="msg msg-error small">{t('feasibility.failed', { detail: error })}</p>}
      {visibleReport && (
        <div className="feasibility-results" data-testid="feasibility-recommendations">
          <p className="small muted">{t('feasibility.tested', { count: visibleReport.testedCandidates })}</p>
          {visibleReport.noLibrarySolution && (
            <div className="msg msg-warning guidance-no-library" data-testid="feasibility-no-solution">
              <strong>{t('feasibility.noLibraryTitle')}</strong><br />
              <span className="small">{t('feasibility.noLibraryBody')}</span>
            </div>
          )}
          {visibleReport.recommendations.length === 0 && <p className="msg msg-warning">{t('feasibility.noVerifiedChange')}</p>}
          {visibleReport.recommendations.map(recommendation => (
            <RecommendationCard
              key={recommendation.id}
              recommendation={recommendation}
              onCompare={() => setComparison(recommendation)}
              onApply={() => apply(recommendation)}
              onOpenTools={openTools}
            />
          ))}
          <div className="guidance-safety" role="note">
            <strong>{t('feasibility.safetyTitle')}</strong>
            <p className="small">{t('feasibility.safetyBody')}</p>
          </div>
        </div>
      )}
      {comparison?.geometry && (
        <Dialog title={t('feasibility.compareTitle')} onClose={() => setComparison(null)} testId="recommendation-dialog" wide footer={<button type="button" className="btn" onClick={() => setComparison(null)}>{t('common.close')}</button>}>
          <RecommendationGraphic recommendation={comparison} expanded />
          <div className="guidance-dialog-grid small">
            <div><strong>{t('feasibility.dialog.changed')}</strong><br />{comparison.changes.map(change => `${change.fromName} → ${change.toName}`).join(' · ')}</div>
            <div><strong>{t('feasibility.metric.requiredRating')}</strong><br />≥ {fmt(comparison.requiredLoadPerMeter, 1)} kN/m</div>
            <div><strong>{t('feasibility.dialog.validation')}</strong><br />{t('feasibility.dialog.fullPlan')}</div>
            <div><strong>{t('feasibility.dialog.next')}</strong><br />{t('feasibility.dialog.import')}</div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
