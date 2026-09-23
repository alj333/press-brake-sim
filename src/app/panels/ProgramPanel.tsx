/**
 * ui — Program panel: the printable bend program with every header in both languages (EN / TH),
 * a part / machine / material / thickness header block, one row per step, the max-force footer,
 * Print (window.print with the print stylesheet) and JSON / CSV export.
 */
import type { ReactNode } from 'react';
import type { BendStep } from '../../core/types';
import { translate, useI18n } from '../../i18n';
import { useProjectStore, selectMachine, selectMaterial } from '../store';
import { downloadText, programToCsv, programToJson, safeFileName } from '../project';
import { fmt, fmtDate, kNToTonnes } from '../format';

/** Header cell with the English and Thai labels stacked. */
function Th({ k, children }: { k: string; children?: ReactNode }) {
  return (
    <th>
      <span className="th-en">{translate('en', k)}</span>
      <span className="th-th">{translate('th', k)}</span>
      {children}
    </th>
  );
}

function Both({ k, params }: { k: string; params?: Record<string, string | number> }) {
  return <>{translate('en', k, params)} / {translate('th', k, params)}</>;
}

const COLUMNS = [
  'program.col.step', 'program.col.bend', 'program.col.tools', 'program.col.segments', 'program.col.includedAngle', 'program.col.loadedAngle',
  'program.col.outside', 'program.col.deduction', 'program.col.backgauge', 'program.col.partZOffset', 'program.col.ramDepth', 'program.col.force',
  'program.col.ofTool', 'program.col.turn', 'program.col.orientation', 'program.col.notes',
];

function StepRow({ step }: { step: BendStep }) {
  const { tm } = useI18n();
  const notes: string[] = [];
  if (step.bottoming) notes.push(`${translate('en', 'program.bottomingNote')} / ${translate('th', 'program.bottomingNote')}`);
  for (const w of step.warnings) if (w.severity !== 'info') notes.push(tm(w));
  for (const c of step.collisions) notes.push(tm(c.message));
  return (
    <tr data-testid={`program-row-${step.index}`} className={step.collisions.some(c => c.severity === 'error') ? 'row-error' : undefined}>
      <td className="num-cell"><strong>{step.index + 1}</strong></td>
      <td>{step.bendId}{step.kind === 'hem-flatten' && <div className="small muted"><Both k="program.hemNote" /></div>}</td>
      <td>{step.stationId}<div className="small">{step.punchName} / {step.dieName}</div></td>
      <td className="num-cell">{fmt(step.punchLength, 0)}<div className="small muted">{step.segments.join(' + ') || '–'}</div></td>
      <td className="num-cell"><strong>{fmt(step.includedAngle, 1)}°</strong></td>
      <td className="num-cell">{fmt(step.loadedIncludedAngle, 2)}°<div className="small muted">SB {fmt(step.springback, 2)}°</div></td>
      <td className="num-cell"><strong>{fmt(step.gaugedFlangeOutside, 2)}</strong><div className="small muted"><Both k={`ref.${step.dimensionRef}`} /></div></td>
      <td className="num-cell">{fmt(step.bendDeduction, 2)}</td>
      <td className="num-cell">
        {step.backgauge.length === 0 && '–'}
        {step.backgauge.map((f, i) => <div key={i}>F{i + 1}: X <strong>{fmt(f.x, 2)}</strong> · R {fmt(f.r, 1)} · Z {fmt(f.z, 1)}</div>)}
        <div className="small muted"><Both k={`contact.${step.gaugeContact}`} /></div>
      </td>
      <td className="num-cell">{fmt(step.partZOffset, 1)}</td>
      <td className="num-cell"><strong>{fmt(step.ramDepth, 2)}</strong></td>
      <td className="num-cell">{fmt(step.force, 1)} kN<div className="small">{fmt(kNToTonnes(step.force), 2)} t</div></td>
      <td className="num-cell">{fmt(step.loadPercentOfTool, 0)} %</td>
      <td><Both k={`turn.${step.manipulation.turn}`} />{step.manipulation.stationChange && <div className="small muted"><Both k="sequence.stationChange" /></div>}</td>
      <td><Both k={`faceUp.${step.orientation.faceUp}`} /> / {step.orientation.backFlangeId}</td>
      <td className="notes-cell">{notes.map((n, i) => <div key={i} className="small">{n}</div>)}</td>
    </tr>
  );
}

export function ProgramPanel() {
  const { t, lang } = useI18n();
  const project = useProjectStore(s => s.project);
  const simLibrary = useProjectStore(s => s.simLibrary);
  const programStale = useProjectStore(s => s.programStale);
  const machine = useProjectStore(selectMachine);
  const material = useProjectStore(selectMaterial);
  const program = project.program;

  if (!program) {
    return (
      <div className="panel program-panel">
        <p className="muted">{t('program.noProgram')}</p>
        <div><button type="button" className="btn btn-primary" data-testid="plan-button-program" disabled={!project.part} onClick={() => { void useProjectStore.getState().plan(); }}>{t('sequence.plan')}</button></div>
      </div>
    );
  }
  const ctx = { program, part: project.part, machine, material, library: simLibrary };
  const base = safeFileName(project.name || program.partName, 'program');
  const print = (): void => {
    document.body.classList.add('printing-program');
    const done = (): void => document.body.classList.remove('printing-program');
    window.addEventListener('afterprint', done, { once: true });
    try { window.print(); } finally { setTimeout(done, 2000); }
  };
  const feasibleText = program.feasible
    ? `${translate('en', 'sequence.feasible')} / ${translate('th', 'sequence.feasible')}`
    : `${translate('en', 'sequence.infeasible')} / ${translate('th', 'sequence.infeasible')}`;

  return (
    <div className="panel program-panel">
      <div className="row row-wrap no-print">
        <button type="button" className="btn btn-primary" onClick={print} data-testid="print-program">{t('program.print')}</button>
        <button type="button" className="btn" data-testid="export-json" onClick={() => downloadText(`${base}-program.json`, programToJson(ctx), 'application/json')}>{t('program.exportJson')}</button>
        <button type="button" className="btn" data-testid="export-csv" onClick={() => downloadText(`${base}-program.csv`, programToCsv(ctx, lang), 'text/csv')}>{t('program.exportCsv')}</button>
        {programStale && <span className="badge badge-warn">{t('sequence.replan')}</span>}
      </div>
      <div className="program-print">
        <h2 className="program-title"><Both k="program.title" /></h2>
        <table className="table program-header">
          <tbody>
            <tr><th><Both k="program.header.part" /></th><td>{project.name || program.partName}{project.name && project.name !== program.partName ? ` (${program.partName})` : ''}</td>
              <th><Both k="program.header.machine" /></th><td>{machine.name} · {fmt(machine.capacity, 0)} kN · {fmt(machine.bedLength, 0)} mm</td></tr>
            <tr><th><Both k="program.header.material" /></th><td>{material?.name ?? program.materialId}</td>
              <th><Both k="program.header.thickness" /></th><td>{fmt(program.thickness, 2)} mm</td></tr>
            <tr><th><Both k="program.header.date" /></th><td>{fmtDate(new Date(), lang)}</td>
              <th><Both k="program.header.feasible" /></th><td className={program.feasible ? 'text-ok' : 'text-error'}>{feasibleText}</td></tr>
            <tr><th><Both k="program.header.setup" /></th>
              <td colSpan={3}>
                {program.setup.stations.map(st => {
                  const punch = simLibrary.punches.find(p => p.id === st.punchId)?.name ?? st.punchId;
                  const die = simLibrary.dies.find(d => d.id === st.dieId)?.name ?? st.dieId;
                  return <div key={st.id}>{t('program.station', { id: st.id, punch, die, zStart: fmt(st.zStart, 0), zEnd: fmt(st.zEnd, 0) })}</div>;
                })}
              </td></tr>
          </tbody>
        </table>
        <div className="table-wrap">
          <table className="table program-table" data-testid="program-table">
            <thead>
              <tr>{COLUMNS.map(k => <Th key={k} k={k} />)}</tr>
            </thead>
            <tbody>
              {program.steps.map(step => <StepRow key={step.index} step={step} />)}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={11} className="num-cell"><Both k="program.footer.maxForce" /></td>
                <td className="num-cell"><strong>{fmt(program.maxForce, 1)} kN</strong><div className="small">{fmt(kNToTonnes(program.maxForce), 2)} t</div></td>
                <td colSpan={4}><Both k="program.footer.capacity" />: {fmt(machine.capacity, 0)} kN ({fmt(kNToTonnes(machine.capacity), 1)} t) · {fmt((100 * program.maxForce) / machine.capacity, 0)} %</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {program.warnings.length > 0 && (
          <ul className="messages program-warnings">
            {program.warnings.map((w, i) => <li key={i} className={`msg msg-${w.severity ?? 'warning'}`}><span className="msg-text">{translate('en', w.key, w.params)} / {translate('th', w.key, w.params)}</span></li>)}
          </ul>
        )}
        <p className="small muted program-footer"><Both k="program.generated" /></p>
      </div>
    </div>
  );
}
