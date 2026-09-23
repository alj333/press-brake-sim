/**
 * sim-3d — playback controls: play/pause, step by phase, time scrubber, speed, continue-on-
 * collision, section toggle, camera presets, step list. Labels via the `t` prop (§6 of the spec).
 */
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { BendProgram } from '../core/types';
import { useSimStore, currentStepIndex, simDuration } from './store';
import type { CameraPreset } from './store';
import { keyframeIndexAt } from './interpolate';
import { formatTime, SIM_SPEEDS } from './scene';
import { withFallback } from './labels';
import type { TranslateFn } from './labels';
import './sim.css';

const PRESETS: CameraPreset[] = ['iso', 'front', 'side', 'top'];

export interface TransportBarProps {
  t: TranslateFn;
  program: BendProgram | null;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /** Hide the step list (e.g. when the ui shows its own sequence panel). */
  hideSteps?: boolean | undefined;
}

export function TransportBar({ t, program, className, style, hideSteps = false }: TransportBarProps) {
  const tt = useMemo(() => withFallback(t), [t]);
  const timeS = useSimStore(s => s.timeS);
  const playing = useSimStore(s => s.playing);
  const speed = useSimStore(s => s.speed);
  const continueOnCollision = useSimStore(s => s.continueOnCollision);
  const showSection = useSimStore(s => s.showSection);
  const cameraPreset = useSimStore(s => s.cameraPreset);
  const pausedAtCollision = useSimStore(s => s.pausedAtCollision);
  const keyframes = useSimStore(s => s.keyframes);
  const stepIndex = useSimStore(currentStepIndex);
  const duration = simDuration({ keyframes });
  const phase = useSimStore(s => {
    const i = keyframeIndexAt(s.keyframes, s.timeS);
    return i < 0 ? null : s.keyframes[i]!.phase;
  });
  const actions = useSimStore.getState();
  const hasTimeline = keyframes.length > 0;

  return (
    <div className={className ? `pbsim-transport ${className}` : 'pbsim-transport'} style={style}>
      <div className="pbsim-transport-row">
        <button type="button" className="pbsim-btn" onClick={() => actions.stepPhase(-1)} disabled={!hasTimeline} title={tt('sim.stepBack')} aria-label={tt('sim.stepBack')}>◀</button>
        <button type="button" className="pbsim-btn pbsim-btn-primary" onClick={() => actions.toggle()} disabled={!hasTimeline} aria-label={playing ? tt('sim.pause') : tt('sim.play')}>
          {playing ? '❚❚ ' + tt('sim.pause') : '▶ ' + tt('sim.play')}
        </button>
        <button type="button" className="pbsim-btn" onClick={() => actions.stepPhase(1)} disabled={!hasTimeline} title={tt('sim.stepForward')} aria-label={tt('sim.stepForward')}>▶</button>
        <input
          type="range"
          className="pbsim-scrubber"
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.01}
          value={Math.min(timeS, duration)}
          disabled={!hasTimeline}
          onChange={e => actions.seekTime(Number(e.target.value))}
          aria-label={tt('sim.time')}
        />
        <span className="pbsim-time">{formatTime(timeS)} / {formatTime(duration)}</span>
        <label className="pbsim-field">
          <span>{tt('sim.speed')}</span>
          <select value={speed} onChange={e => actions.setSpeed(Number(e.target.value))}>
            {(SIM_SPEEDS as readonly number[]).includes(speed) ? null : <option value={speed}>{speed}×</option>}
            {SIM_SPEEDS.map(v => <option key={v} value={v}>{v}×</option>)}
          </select>
        </label>
        <label className="pbsim-field">
          <input type="checkbox" checked={continueOnCollision} onChange={e => actions.setContinueOnCollision(e.target.checked)} />
          <span>{tt('sim.continueOnCollision')}</span>
        </label>
        <button type="button" className={showSection ? 'pbsim-btn pbsim-btn-on' : 'pbsim-btn'} onClick={() => actions.setShowSection(!showSection)} aria-pressed={showSection}>
          {tt('sim.section')}
        </button>
        <span className="pbsim-field">
          <span>{tt('sim.camera')}</span>
          {PRESETS.map(p => (
            <button key={p} type="button" className={cameraPreset === p ? 'pbsim-btn pbsim-btn-on' : 'pbsim-btn'} onClick={() => actions.setCameraPreset(p)} aria-pressed={cameraPreset === p}>
              {tt(`sim.camera.${p}`)}
            </button>
          ))}
        </span>
      </div>
      <div className="pbsim-transport-status">
        {!program && <span className="pbsim-muted">{tt('sim.noProgram')}</span>}
        {program && hasTimeline && stepIndex >= 0 && program.steps[stepIndex] && (
          <span>
            {tt('sim.step', { index: stepIndex + 1, bendId: program.steps[stepIndex]!.bendId })}
            {phase ? ` · ${tt(`sim.phase.${phase}`)}` : ''}
          </span>
        )}
        {pausedAtCollision !== null && <span className="pbsim-col-error"> — {tt('sim.pausedOnCollision')}</span>}
      </div>
      {program && !hideSteps && program.steps.length > 0 && (
        <ol className="pbsim-steps" aria-label={tt('sim.steps')}>
          {program.steps.map(s => {
            const errors = s.collisions.filter(c => c.severity === 'error').length;
            const warnings = s.warnings.filter(w => w.severity !== 'info').length + s.collisions.filter(c => c.severity === 'warning').length;
            const current = s.index === stepIndex;
            return (
              <li key={s.index} className={current ? 'pbsim-step pbsim-step-current' : 'pbsim-step'}>
                <button type="button" className="pbsim-step-btn" disabled={!hasTimeline} onClick={() => actions.seekStep(s.index)} aria-current={current ? 'step' : undefined}>
                  <span className="pbsim-step-title">{tt('sim.step', { index: s.index + 1, bendId: s.bendId })}</span>
                  <span className="pbsim-step-meta">
                    {tt(`sim.stepKind.${s.kind}`)} · {s.punchName} / {s.dieName} · {s.includedAngle.toFixed(1)}° · {tt(`sim.turn.${s.manipulation.turn}`)}
                  </span>
                  {(errors > 0 || warnings > 0) && (
                    <span className="pbsim-step-flags">
                      {errors > 0 && <span className="pbsim-col-error">✖ {errors}</span>}
                      {warnings > 0 && <span className="pbsim-col-warning">⚠ {warnings}</span>}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
