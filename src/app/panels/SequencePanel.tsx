/**
 * ui — Sequence panel: Plan button + options, program summary, and one draggable card per
 * step (tools, angles, backgauge, ram depth, force, turn, gauge contact, bottoming, messages
 * and collisions that seek the simulation). Dragging a card onto another fixes the order.
 */
import { useState } from 'react';
import type { DragEvent } from 'react';
import type { BendStep, Turn } from '../../core/types';
import { useI18n } from '../../i18n';
import { useProjectStore, selectMachine } from '../store';
import { MessageList } from '../components/MessageList';
import { NumberField } from '../components/NumberField';
import { fmt, kNToTonnes } from '../format';

const TURN_ICON: Record<Turn, string> = { none: '→', rotate180: '↻', 'flip-front-back': '⇅', 'flip-end-for-end': '⇄' };

function StepCard({ step, selected, dragging, onSelect, onDragStart, onDragOver, onDrop }: {
  step: BendStep; selected: boolean; dragging: boolean; onSelect: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void; onDragOver: (e: DragEvent<HTMLDivElement>) => void; onDrop: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const { t, tm } = useI18n();
  const seekToCollision = useProjectStore(s => s.seekToCollision);
  const errors = step.collisions.filter(c => c.severity === 'error').length;
  const warnings = step.warnings.filter(w => w.severity !== 'info').length + step.collisions.filter(c => c.severity === 'warning').length;
  const cls = ['card', 'step-card', selected ? 'card-active' : '', dragging ? 'card-dragging' : '', errors ? 'card-error' : warnings ? 'card-warning' : ''].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      data-testid={`step-${step.index}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onSelect}
      role="listitem"
    >
      <div className="row row-between step-head">
        <span className="drag-handle" title={t('sequence.dragHint')} aria-hidden="true">⋮⋮</span>
        <strong>{t('sequence.step', { index: step.index + 1 })} · {step.bendId}</strong>
        <span className="badge">{t(`sequence.kind.${step.kind}`)}</span>
        <span className="row-grow" />
        <span className="turn" title={t(`turn.${step.manipulation.turn}`)}>
          <span className="turn-icon" aria-hidden="true">{TURN_ICON[step.manipulation.turn]}</span> {t(`turn.${step.manipulation.turn}`)}
          {step.manipulation.stationChange && <> · {t('sequence.stationChange')}</>}
        </span>
      </div>
      <div className="step-grid small">
        <span className="k">{t('sequence.station')}</span><span>{step.stationId} · {step.punchName} / {step.dieName}</span>
        <span className="k">{t('sequence.angle')}</span>
        <span>
          <strong>{fmt(step.includedAngle, 1)}°</strong> → {fmt(step.loadedIncludedAngle, 2)}° {t('sequence.loadedAngle')}
          <span className="muted"> · {t('sequence.springback', { springback: fmt(step.springback, 2), overbend: fmt(step.overbendAngle, 2) })}</span>
          {step.bottoming && <span className="badge badge-warn"> {t('sequence.bottoming')}</span>}
        </span>
        <span className="k">{t('sequence.outside')}</span>
        <span><strong>{fmt(step.gaugedFlangeOutside, 2)}</strong> mm ({t(`ref.${step.dimensionRef}`)}) · BD {fmt(step.bendDeduction, 2)} mm · <span className="muted">{t('sequence.actualRadius', { radius: fmt(step.actualInnerRadius, 2) })}</span></span>
        <span className="k">{t('sequence.backgauge')}</span>
        <span>
          {step.backgauge.length === 0 && <span className="muted">{t('sequence.noBackgauge')}</span>}
          {step.backgauge.map((f, i) => (
            <span key={i} className="finger-chip">{t('sequence.finger', { index: i + 1 })}: {t('sequence.fingerValues', { x: fmt(f.x, 2), r: fmt(f.r, 1), z: fmt(f.z, 1) })}</span>
          ))}
          <span className="muted"> · {t('sequence.gaugeContact')}: {t(`contact.${step.gaugeContact}`)}</span>
        </span>
        <span className="k">{t('sequence.ramDepth')}</span>
        <span><strong>{fmt(step.ramDepth, 2)}</strong> mm · {t('sequence.punchLength')} {fmt(step.punchLength, 0)} mm ({step.segments.join('+') || '–'}) · {t('sequence.partZOffset')} {fmt(step.partZOffset, 1)} mm</span>
        <span className="k">{t('sequence.force')}</span>
        <span>
          <strong>{fmt(step.force, 1)} kN</strong> ({fmt(kNToTonnes(step.force), 2)} t) · {fmt(step.forcePerMeter, 0)} kN/m ·{' '}
          <span className={step.loadPercentOfTool > 100 ? 'text-error' : step.loadPercentOfTool > 90 ? 'text-warn' : ''}>{fmt(step.loadPercentOfTool, 0)} % {t('sequence.ofTool')}</span>
          {' · '}{t('sequence.orientation')}: {t(`faceUp.${step.orientation.faceUp}`)} / {step.orientation.backFlangeId}
        </span>
      </div>
      {step.collisions.length > 0 && (
        <ul className="messages" data-testid={`step-collisions-${step.index}`}>
          {step.collisions.map((c, i) => (
            <li key={i} className={`msg msg-${c.severity} msg-clickable`}>
              <button type="button" className="msg-btn" title={t('sequence.seek')} onClick={e => { e.stopPropagation(); seekToCollision(step, c); }}>
                <span className={`msg-icon msg-icon-${c.severity}`}>{c.severity === 'error' ? '✖' : '⚠'}</span>
                <span className="msg-text">{tm(c.message)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {step.warnings.length > 0 && <MessageList messages={step.warnings} onClick={() => onSelect()} testId={`step-warnings-${step.index}`} />}
    </div>
  );
}

export function SequencePanel() {
  const { t } = useI18n();
  const project = useProjectStore(s => s.project);
  const planning = useProjectStore(s => s.planning);
  const progress = useProjectStore(s => s.planProgress);
  const planError = useProjectStore(s => s.planError);
  const programStale = useProjectStore(s => s.programStale);
  const fixedOrder = useProjectStore(s => s.fixedOrder);
  const selectedStepIndex = useProjectStore(s => s.selectedStepIndex);
  const machine = useProjectStore(selectMachine);
  const actions = useProjectStore.getState();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const program = project.program;
  const opts = project.plannerOptions;
  const canPlan = !!project.part && project.setup.stations.length > 0 && !planning;

  const reorder = (from: number, to: number): void => {
    if (!program || from === to) return;
    const ids = program.steps.filter(s => s.kind === 'bend').map(s => s.bendId);
    const uniq = ids.filter((id, i) => ids.indexOf(id) === i);
    const fromId = program.steps[from]?.bendId, toId = program.steps[to]?.bendId;
    if (!fromId || !toId || fromId === toId) return;
    const a = uniq.indexOf(fromId), b = uniq.indexOf(toId);
    if (a < 0 || b < 0) return;
    const next = [...uniq];
    next.splice(a, 1);
    next.splice(b, 0, fromId);
    actions.setFixedOrder(next);
    void actions.plan();
  };

  return (
    <div className="panel sequence-panel">
      <section className="panel-section">
        <div className="row row-wrap">
          <button type="button" className="btn btn-primary" disabled={!canPlan} onClick={() => { void actions.plan(); }} data-testid="plan-button">
            {program ? t('sequence.replan') : t('sequence.plan')}
          </button>
          {planning && <button type="button" className="btn" onClick={() => actions.cancelPlan()} data-testid="cancel-plan">{t('sequence.cancel')}</button>}
          {planning && (
            <span className="muted small busy" data-testid="plan-progress">
              {t('sequence.planning', { phase: progress ? t(`sequence.phase.${progress.phase}`) : '…', done: progress?.done ?? 0, total: progress?.total ?? 0 })}
            </span>
          )}
          <span className="row-grow" />
          <span className="small">
            {t('sequence.order')}:{' '}
            {fixedOrder
              ? <><span className="badge badge-user">{fixedOrder.join(' → ')}</span> <button type="button" className="btn btn-small" data-testid="order-auto" onClick={() => { actions.setFixedOrder(null); void actions.plan(); }}>{t('sequence.orderAuto')}</button></>
              : <span className="badge">{t('sequence.orderAuto')}</span>}
          </span>
        </div>
        {!project.part && <p className="muted small">{t('sequence.noPart')}</p>}
        {project.part && project.setup.stations.length === 0 && <p className="text-error small">{t('sequence.noStations')}</p>}
        {planError && <MessageList messages={[planError]} testId="plan-error" />}
        <details className="details">
          <summary>{t('sequence.options')}</summary>
          <div className="form-grid">
            <NumberField label={t('sequence.sweepStep')} value={opts.sweepStepDeg} min={1} max={30} step={1} digits={1} onCommit={v => actions.setPlannerOptions({ sweepStepDeg: v })} testId="opt-sweep" />
            <NumberField label={t('sequence.maxSequences')} value={opts.maxSequences} min={100} max={1e6} step={100} digits={0} onCommit={v => actions.setPlannerOptions({ maxSequences: Math.round(v) })} testId="opt-max" />
            <NumberField label={t('sequence.minFlangeWarnFactor')} value={opts.minFlangeWarnFactor} min={1} max={3} step={0.05} digits={2} onCommit={v => actions.setPlannerOptions({ minFlangeWarnFactor: v })} testId="opt-minleg" />
            {(['flip', 'rotate', 'stationChange', 'shortFlange', 'collisionWarning'] as const).map(w => (
              <NumberField key={w} label={`${t('sequence.weights')}: ${t(`sequence.weight.${w}`)}`} value={opts.weights[w]} min={0} max={1000} step={1} digits={1} onCommit={v => actions.setPlannerOptions({ weights: { ...opts.weights, [w]: v } })} testId={`opt-weight-${w}`} />
            ))}
          </div>
        </details>
      </section>

      {program && (
        <section className="panel-section">
          <div className="row row-wrap">
            <span className={program.feasible ? 'badge badge-ok' : 'badge badge-error'} data-testid="program-feasible">{program.feasible ? t('sequence.feasible') : t('sequence.infeasible')}</span>
            {programStale && <span className="badge badge-warn" data-testid="program-stale">{t('sequence.replan')}</span>}
            <span className="small">{t('sequence.maxForce', { force: fmt(program.maxForce, 1), tonnes: fmt(kNToTonnes(program.maxForce), 2), capacity: fmt(machine.capacity, 0), percent: fmt((100 * program.maxForce) / machine.capacity, 0) })}</span>
            <span className="small muted">{t('sequence.stats', { sequences: program.stats.sequencesEvaluated, ms: fmt(program.stats.timeMs, 0) })}</span>
          </div>
          {program.warnings.length > 0 && (
            <details className="details" open>
              <summary>{t('sequence.programWarnings')} ({program.warnings.length})</summary>
              <MessageList messages={program.warnings} testId="program-warnings" />
            </details>
          )}
        </section>
      )}

      <section className="panel-section">
        {!program && project.part && <p className="muted">{t('sequence.noProgram')}</p>}
        {program && program.steps.length > 0 && (
          <>
            <p className="small muted">{fixedOrder ? t('sequence.orderFixed') : t('sequence.legend')}</p>
            <div className="steps" role="list" data-testid="steps">
              {program.steps.map(step => (
                <StepCard
                  key={step.index}
                  step={step}
                  selected={step.index === selectedStepIndex}
                  dragging={dragIndex === step.index}
                  onSelect={() => actions.selectStep(step.index)}
                  onDragStart={e => { setDragIndex(step.index); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(step.index)); }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDrop={e => {
                    e.preventDefault();
                    const from = dragIndex ?? Number(e.dataTransfer.getData('text/plain'));
                    setDragIndex(null);
                    if (Number.isFinite(from)) reorder(from, step.index);
                  }}
                />
              ))}
            </div>
          </>
        )}
        {program && program.steps.length === 0 && <MessageList messages={[{ key: 'warnings.planner.infeasible', severity: 'error' }]} />}
      </section>
    </div>
  );
}
