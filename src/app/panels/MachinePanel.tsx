/**
 * ui — Machine panel: picker, grouped form for every Machine field (general, ram / clamp,
 * speeds, table / holder, backgauge incl. flags and retract-at-pinch), validation messages,
 * derived levels and "save as new machine".
 */
import { useMemo, useState } from 'react';
import { machineLevels } from '../../core/machine';
import { useI18n } from '../../i18n';
import { useProjectStore, selectMachine, selectMachineMessages } from '../store';
import type { MachinePatch } from '../store';
import { MessageList } from '../components/MessageList';
import { NumberField } from '../components/NumberField';
import { fmt, kNToTonnes } from '../format';

type NumKey = 'bedLength' | 'capacity' | 'stroke' | 'daylight' | 'throatDepth' | 'distanceBetweenFrames' | 'yCorrection';
type RamKey = 'thickness' | 'height' | 'clampThickness' | 'clampHeight' | 'clampFrontOffset';
type SpeedKey = 'approach' | 'bend' | 'retract';
type TableKey = 'width' | 'holderWidth' | 'holderHeight' | 'height';
type GaugeNumKey = 'xMin' | 'xMax' | 'rMin' | 'rMax' | 'zMin' | 'zMax' | 'beamDepth' | 'beamHeight' | 'retractAtPinch' | 'speed';

const GENERAL: Array<[NumKey, number | undefined, string | undefined]> = [
  ['bedLength', 0, 'machine-bed-length'], ['capacity', 0, undefined], ['stroke', 0, undefined], ['daylight', 0, undefined],
  ['throatDepth', 0, undefined], ['distanceBetweenFrames', 0, undefined], ['yCorrection', undefined, undefined],
];
const RAM: RamKey[] = ['thickness', 'height', 'clampThickness', 'clampHeight', 'clampFrontOffset'];
const SPEEDS: SpeedKey[] = ['approach', 'bend', 'retract'];
const TABLE: TableKey[] = ['width', 'holderWidth', 'holderHeight', 'height'];
const GAUGE: Array<[GaugeNumKey, number | undefined]> = [
  ['xMin', undefined], ['xMax', undefined], ['rMin', undefined], ['rMax', undefined], ['zMin', undefined], ['zMax', undefined],
  ['beamDepth', 0], ['beamHeight', 0], ['retractAtPinch', 0], ['speed', 0],
];

export function MachinePanel() {
  const { t } = useI18n();
  const library = useProjectStore(s => s.library);
  const machineId = useProjectStore(s => s.project.machineId);
  const machine = useProjectStore(selectMachine);
  const project = useProjectStore(s => s.project);
  const messages = useMemo(() => selectMachineMessages({ project, library }), [project, library]);
  const actions = useProjectStore.getState();
  const [newName, setNewName] = useState('');
  const levels = machineLevels(machine);
  const patch = (p: MachinePatch): void => actions.updateMachine(p);

  return (
    <div className="panel machine-panel">
      <section className="panel-section">
        <div className="row row-wrap">
          <label className="field field-grow">
            <span className="field-label">{t('machine.select')}</span>
            <select value={machineId} onChange={e => actions.setMachine(e.target.value)} data-testid="machine-select">
              {library.machines.map(m => <option key={m.id} value={m.id}>{m.name}{m.id.startsWith('custom:') ? ' *' : ''}</option>)}
            </select>
          </label>
          <label className="field field-grow">
            <span className="field-label">{t('machine.name')}</span>
            <input type="text" value={machine.name} onChange={e => patch({ name: e.target.value })} data-testid="machine-name" />
          </label>
        </div>
        <div className="row row-wrap">
          <input type="text" className="field-grow" placeholder={t('machine.newName')} value={newName} onChange={e => setNewName(e.target.value)} data-testid="machine-new-name" />
          <button type="button" className="btn" data-testid="machine-save-as" onClick={() => { actions.saveMachineAs(newName || `${machine.name} (copy)`); setNewName(''); }}>{t('machine.saveAs')}</button>
        </div>
        {messages.length === 0
          ? <p className="small text-ok">{t('machine.valid')}</p>
          : <MessageList messages={messages} testId="machine-messages" />}
        <p className="small muted">{t('machine.levels', { tableTop: fmt(levels.tableTopY, 0), tdc: fmt(levels.tdcClampY, 0), maxRamDepth: fmt(levels.maxRamDepth, 1) })}</p>
      </section>

      <section className="panel-section">
        <h3 className="section-title">{t('machine.general')}</h3>
        <div className="form-grid">
          {GENERAL.map(([key, min, testId]) => (
            <NumberField key={key} label={t(`machine.${key}`)} value={machine[key]} min={min} step={1} digits={1} testId={testId ?? `machine-${key}`} onCommit={v => patch({ [key]: v } as MachinePatch)} />
          ))}
          <span className="small muted form-note">{t('machine.capacityTonnes', { tonnes: fmt(kNToTonnes(machine.capacity), 1) })}</span>
        </div>
      </section>

      <section className="panel-section">
        <h3 className="section-title">{t('machine.ram')}</h3>
        <div className="form-grid">
          {RAM.map(key => (
            <NumberField key={key} label={t(`machine.ram.${key}`)} value={machine.ram[key]} min={0} step={1} digits={1} testId={`machine-ram-${key}`} onCommit={v => patch({ ram: { [key]: v } })} />
          ))}
        </div>
        <h4 className="subsection-title">{t('machine.speeds')}</h4>
        <div className="form-grid">
          {SPEEDS.map(key => (
            <NumberField key={key} label={t(`machine.speed.${key}`)} value={machine.ram.speeds[key]} min={0.1} step={1} digits={1} testId={`machine-speed-${key}`} onCommit={v => patch({ ram: { speeds: { [key]: v } } })} />
          ))}
        </div>
      </section>

      <section className="panel-section">
        <h3 className="section-title">{t('machine.table')}</h3>
        <div className="form-grid">
          {TABLE.map(key => (
            <NumberField key={key} label={t(`machine.table.${key}`)} value={machine.table[key]} min={0} step={1} digits={1} testId={`machine-table-${key}`} onCommit={v => patch({ table: { [key]: v } })} />
          ))}
        </div>
      </section>

      <section className="panel-section">
        <h3 className="section-title">{t('machine.backgauge')}</h3>
        <div className="form-grid">
          {GAUGE.map(([key, min]) => (
            <NumberField key={key} label={t(`machine.backgauge.${key}`)} value={machine.backgauge[key]} min={min} step={1} digits={1} testId={`machine-backgauge-${key}`} onCommit={v => patch({ backgauge: { [key]: v } })} />
          ))}
          <NumberField label={t('machine.backgauge.fingerCount')} value={machine.backgauge.fingerCount} min={1} max={8} step={1} digits={0} testId="machine-backgauge-fingerCount" onCommit={v => patch({ backgauge: { fingerCount: Math.max(1, Math.round(v)) } })} />
          <label className="field">
            <span className="field-label">{t('machine.backgauge.fingerId')}</span>
            <select value={machine.backgauge.fingerId} onChange={e => patch({ backgauge: { fingerId: e.target.value } })} data-testid="machine-backgauge-fingerId">
              {library.fingers.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={machine.backgauge.independentX} onChange={e => patch({ backgauge: { independentX: e.target.checked } })} data-testid="machine-backgauge-independentX" /> {t('machine.backgauge.independentX')}</label>
          <label className="check"><input type="checkbox" checked={machine.backgauge.independentR} onChange={e => patch({ backgauge: { independentR: e.target.checked } })} data-testid="machine-backgauge-independentR" /> {t('machine.backgauge.independentR')}</label>
        </div>
      </section>
    </div>
  );
}
