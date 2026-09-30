/**
 * ui — Tools panel: mounted stations (Z range, segments, punch / die pickers, flips), profile
 * previews, the backgauge finger, and the library manager (custom tools, add-custom dialog,
 * export / import / reset / save).
 */
import { useMemo, useRef, useState } from 'react';
import type { Die, Finger, Punch, ToolStation } from '../../core/types';
import { derivePunchParams } from '../../core/tools';
import { useI18n } from '../../i18n';
import { useProjectStore, selectMachine, selectSetupMessages } from '../store';
import { MessageList } from '../components/MessageList';
import { NumberField } from '../components/NumberField';
import { ProfilePreview } from '../components/ProfilePreview';
import { CustomToolDialog } from './CustomToolDialog';
import { downloadText, safeFileName } from '../project';
import { fmt, joinNumberList, parseNumberList } from '../format';

type StockStatus = 'in-stock' | 'not-in-stock';
type ToolPresentation = {
  stockStatus?: StockStatus;
  slotNumber?: string;
  slotPosition?: string;
  segmentInventory?: Array<{ length: number; quantity: number }>;
};

function stockStatusOf(tool: Punch | Die): StockStatus {
  const status = (tool as (Punch | Die) & ToolPresentation).stockStatus;
  return status === undefined || status === 'in-stock' ? 'in-stock' : 'not-in-stock';
}

function dieSlotLabel(die: Die, t: (k: string, p?: Record<string, string | number>) => string): string | null {
  const { slotNumber, slotPosition } = die as Die & ToolPresentation;
  const hasNumber = typeof slotNumber === 'string' && slotNumber.trim().length > 0;
  const hasPosition = typeof slotPosition === 'string' && slotPosition.trim().length > 0;
  const position = hasPosition ? t(`tools.diePosition.${slotPosition}`) : '';
  if (hasNumber && hasPosition) return t('tools.dieSlotWithPosition', { slot: slotNumber, position });
  if (hasNumber) return t('tools.dieSlot', { slot: slotNumber });
  if (hasPosition) return t('tools.dieSlotPosition', { position });
  return null;
}

function toolDisplayName(tool: Punch | Die, t: (k: string, p?: Record<string, string | number>) => string): string {
  const slot = tool.kind === 'die' ? dieSlotLabel(tool, t) : null;
  return `${tool.name}${slot ? ` · ${slot}` : ''}${tool.source === 'custom' ? ' *' : ''}`;
}

function segmentInventoryLabel(punch: Punch, t: (k: string, p?: Record<string, string | number>) => string): string | null {
  const inventory = (punch as Punch & ToolPresentation).segmentInventory;
  if (!Array.isArray(inventory)) return null;
  const items = inventory
    .filter(item => Number.isFinite(item?.length) && item.length > 0 && Number.isInteger(item?.quantity) && item.quantity > 0)
    .map(item => t('tools.segmentInventoryItem', { length: fmt(item.length, 1), quantity: item.quantity }));
  return items.length > 0 ? `${t('tools.segmentInventory')}: ${items.join(', ')}` : null;
}

interface ToolSelectProps<T extends Punch | Die> {
  items: readonly T[];
  value: string;
  onChange: (id: string) => void;
  testId?: string;
  label: string;
}

function ToolSelect<T extends Punch | Die>({ items, value, onChange, testId, label }: ToolSelectProps<T>) {
  const { t } = useI18n();
  const groups = useMemo(() => [
    { status: 'in-stock' as const, items: items.filter(item => stockStatusOf(item) === 'in-stock') },
    { status: 'not-in-stock' as const, items: items.filter(item => stockStatusOf(item) === 'not-in-stock') },
  ], [items]);
  const selected = items.find(item => item.id === value);
  const known = !!selected;
  const selectedStatus = selected ? stockStatusOf(selected) : null;
  const warningId = selectedStatus === 'not-in-stock' && testId ? `${testId}-stock-warning` : undefined;
  return (
    <label className="field tool-select" data-stock-status={selectedStatus ?? 'unknown'}>
      <span className="field-label">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} data-testid={testId} aria-describedby={warningId}>
        {!known && <option value={value}>{value}</option>}
        {groups.filter(group => group.items.length > 0).map(group => (
          <optgroup key={group.status} label={t(`tools.stock.${group.status}`)} data-stock-status={group.status}>
            {group.items.map(item => (
              <option key={item.id} value={item.id} data-stock-status={group.status}>
                {toolDisplayName(item, t)}{group.status === 'not-in-stock' ? ` — ${t('tools.stock.not-in-stock')}` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {selectedStatus === 'not-in-stock' && (
        <span id={warningId} className="badge badge-warn tool-stock-warning" role="status" data-testid={warningId}>
          {t('tools.stock.selectedUnavailable')}
        </span>
      )}
    </label>
  );
}

function SegmentsEditor({ station, onCommit, onAuto }: { station: ToolStation; onCommit: (segments: number[]) => void; onAuto: () => void }) {
  const { t } = useI18n();
  const text = joinNumberList(station.segments);
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  const [lastText, setLastText] = useState(text);
  if (lastText !== text) { setLastText(text); if (!editing) setDraft(text); }
  const sum = station.segments.reduce((a, b) => a + b, 0);
  const length = station.zEnd - station.zStart;
  const commit = (): void => { setEditing(false); onCommit(parseNumberList(draft)); };
  return (
    <div className="segments-editor">
      <label className="field field-grow">
        <span className="field-label">{t('tools.segments')}</span>
        <input
          type="text"
          value={draft}
          title={t('tools.segmentsHint')}
          data-testid={`station-segments-${station.id}`}
          onFocus={() => setEditing(true)}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>
      <span className={Math.abs(sum - length) > 0.5 && station.segments.length > 0 ? 'small text-error' : 'small muted'}>{t('tools.segmentsSum', { sum: fmt(sum, 1), length: fmt(length, 1) })}</span>
      <button type="button" className="btn btn-small" onClick={onAuto}>{t('tools.autoSegments')}</button>
    </div>
  );
}

function toolSummary(tool: Punch | Die | Finger, t: (k: string, p?: Record<string, string | number>) => string): string {
  const rating = tool.maxLoadPerMeter > 0 ? fmt(tool.maxLoadPerMeter, 0) : t('tools.ratingUnverified');
  if (tool.kind === 'punch') return `${t(`family.${tool.family}`)} · ${t('tools.tipAngle')} ${fmt(tool.tipAngle, 1)} · ${t('tools.tipRadius')} ${fmt(tool.tipRadius, 2)} · ${t('tools.height')} ${fmt(tool.height, 1)} · ${t('tools.rating')} ${rating}`;
  if (tool.kind === 'die') {
    const slot = dieSlotLabel(tool, t);
    return `${slot ? `${slot} · ` : ''}${t(`family.${tool.family}`)} · V ${fmt(tool.vWidth, 1)} · ${fmt(tool.vAngle, 1)}° · ${t('tools.shoulderRadius')} ${fmt(tool.shoulderRadius, 2)} · ${t('tools.height')} ${fmt(tool.height, 1)} · ${t('tools.rating')} ${rating}`;
  }
  return `${t('tools.stopHeight')} ${fmt(tool.stopHeight, 1)} · ${t('tools.bodyDepth')} ${fmt(tool.bodyDepth, 1)} · ${t('tools.width')} ${fmt(tool.width, 1)}`;
}

export function ToolsPanel() {
  const { t, tm } = useI18n();
  const project = useProjectStore(s => s.project);
  const library = useProjectStore(s => s.library);
  const machine = useProjectStore(selectMachine);
  const setupMessages = useMemo(() => selectSetupMessages({ project, library }), [project, library]);
  const actions = useProjectStore.getState();
  const [activeStation, setActiveStation] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  const stations = project.setup.stations;
  const station = stations.find(s => s.id === activeStation) ?? stations[0];
  const punch = station ? library.punches.find(p => p.id === station.punchId) : undefined;
  const die = station ? library.dies.find(d => d.id === station.dieId) : undefined;
  const punchInventory = punch ? segmentInventoryLabel(punch, t) : null;
  const finger = library.fingers.find(f => f.id === machine.backgauge.fingerId);
  const arc = punch ? derivePunchParams(punch.profile.points).arcVertices : [];
  const customTools = useMemo<Array<Punch | Die | Finger>>(
    () => [...library.punches, ...library.dies, ...library.fingers].filter(x => x.source === 'custom'),
    [library],
  );
  const onImportLibrary = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const messages = actions.importLibraryJson(await file.text(), 'merge');
      const lib = useProjectStore.getState().library;
      actions.notify({ key: 'app.notice.libraryImported', params: { punches: lib.punches.length, dies: lib.dies.length, fingers: lib.fingers.length } }, 'info');
      for (const m of messages) if (m.severity !== 'info') actions.notify(m);
      await actions.saveLibrary();
    } catch {
      actions.notify({ key: 'tools.libraryImportFailed', severity: 'error' }, 'error');
    }
  };

  return (
    <div className="panel tools-panel">
      <section className="panel-section">
        <div className="row row-between">
          <h3 className="section-title">{t('tools.stations')}</h3>
          <span className="row">
            <button type="button" className="btn btn-small" onClick={() => actions.addStation()} data-testid="add-station">{t('tools.addStation')}</button>
            <button type="button" className="btn btn-small" onClick={() => actions.resetSetup()} data-testid="reset-setup">{t('tools.resetSetup')}</button>
          </span>
        </div>
        {stations.length === 0 && <p className="muted">{t('tools.noStations')}</p>}
        {stations.map(st => (
          <div key={st.id} className={st.id === station?.id ? 'card card-active' : 'card'} data-testid={`station-${st.id}`} onClick={() => setActiveStation(st.id)}>
            <div className="row row-between">
              <strong>{t('tools.station', { id: st.id })}</strong>
              <span className="muted small">{t('tools.zRange')}: {fmt(st.zStart, 0)}–{fmt(st.zEnd, 0)} mm</span>
              <button type="button" className="btn btn-ghost btn-small" title={t('tools.removeStation')} aria-label={t('tools.removeStation')} onClick={e => { e.stopPropagation(); actions.removeStation(st.id); }}>✕</button>
            </div>
            <div className="row row-wrap">
              <ToolSelect items={library.punches} value={st.punchId} onChange={id => actions.updateStation(st.id, { punchId: id })} testId={`station-punch-${st.id}`} label={t('tools.punch')} />
              <ToolSelect items={library.dies} value={st.dieId} onChange={id => actions.updateStation(st.id, { dieId: id })} testId={`station-die-${st.id}`} label={t('tools.die')} />
            </div>
            <div className="row row-wrap">
              <NumberField label={t('tools.zStart')} value={st.zStart} onCommit={v => actions.updateStation(st.id, { zStart: v })} min={0} max={machine.bedLength} step={5} digits={1} testId={`station-zstart-${st.id}`} size={6} />
              <NumberField label={t('tools.zEnd')} value={st.zEnd} onCommit={v => actions.updateStation(st.id, { zEnd: v })} min={0} max={machine.bedLength} step={5} digits={1} testId={`station-zend-${st.id}`} size={6} />
              <label className="check"><input type="checkbox" checked={st.punchFlipped} onChange={e => actions.updateStation(st.id, { punchFlipped: e.target.checked })} /> {t('tools.punchFlipped')}</label>
              <label className="check"><input type="checkbox" checked={st.dieFlipped} onChange={e => actions.updateStation(st.id, { dieFlipped: e.target.checked })} /> {t('tools.dieFlipped')}</label>
            </div>
            <SegmentsEditor station={st} onCommit={segments => actions.updateStation(st.id, { segments })} onAuto={() => actions.autoSegments(st.id)} />
          </div>
        ))}
        {setupMessages.length > 0 && (
          <details className="details" open>
            <summary>{t('tools.setupWarnings')} ({setupMessages.length})</summary>
            <MessageList messages={setupMessages} testId="setup-warnings" />
          </details>
        )}
      </section>

      <section className="panel-section">
        <h3 className="section-title">{t('tools.preview')}</h3>
        <div className="previews">
          <div>
            <div className="small muted">{t('tools.punchPreview')}{punch ? `: ${toolDisplayName(punch, t)}` : ''}</div>
            <ProfilePreview points={punch?.profile.points ?? []} highlight={arc} mirrored={station?.punchFlipped} height={170} testId="punch-preview" />
            {punch && <div className="small muted">{toolSummary(punch, t)}</div>}
            {punchInventory && (
              <div className="small tool-inventory" data-testid="punch-segment-inventory">{punchInventory}</div>
            )}
          </div>
          <div>
            <div className="small muted">{t('tools.diePreview')}{die ? `: ${toolDisplayName(die, t)}` : ''}</div>
            <ProfilePreview points={die?.profile.points ?? []} mirrored={station?.dieFlipped} height={170} testId="die-preview" />
            {die && <div className="small muted" data-testid="die-slot-summary">{toolSummary(die, t)}</div>}
          </div>
        </div>
      </section>

      <section className="panel-section">
        <h3 className="section-title">{t('tools.finger')}</h3>
        <div className="row row-wrap">
          <label className="field">
            <span className="field-label">{t('machine.backgauge.fingerId')}</span>
            <select value={machine.backgauge.fingerId} onChange={e => actions.updateMachine({ backgauge: { fingerId: e.target.value } })} data-testid="finger-select">
              {library.fingers.map(f => <option key={f.id} value={f.id}>{f.name}{f.source === 'custom' ? ' *' : ''}</option>)}
            </select>
          </label>
          <div className="field-grow">
            <ProfilePreview points={finger?.profile.points ?? []} height={110} testId="finger-preview" />
            {finger && <div className="small muted">{toolSummary(finger, t)}</div>}
          </div>
        </div>
      </section>

      <section className="panel-section">
        <h3 className="section-title">{t('tools.library')}</h3>
        <div className="row row-wrap">
          <span className="row row-wrap">
            <button type="button" className="btn btn-primary btn-small" onClick={() => setDialogOpen(true)} data-testid="add-custom-tool">{t('tools.addCustom')}</button>
            <button type="button" className="btn btn-small" data-testid="export-library" onClick={() => downloadText(`${safeFileName('tool-library')}.json`, actions.exportLibraryJson())}>{t('tools.exportLibrary')}</button>
            <label className="btn btn-small">
              {t('tools.importLibrary')}
              <input ref={importInput} type="file" accept=".json,application/json" hidden data-testid="import-library" onChange={() => { const f = importInput.current?.files?.[0]; if (importInput.current) importInput.current.value = ''; void onImportLibrary(f); }} />
            </label>
            <button type="button" className="btn btn-small" onClick={() => { void actions.saveLibrary(); }} data-testid="save-library">{t('tools.saveLibrary')}</button>
            <button type="button" className="btn btn-small" onClick={() => actions.resetStandardItems()} data-testid="reset-standard">{t('tools.resetStandard')}</button>
          </span>
        </div>
        <h4 className="subsection-title">{t('tools.customTools')}</h4>
        {customTools.length === 0 && <p className="muted small">{t('tools.noCustomTools')}</p>}
        {customTools.length > 0 && (
          <ul className="list" data-testid="custom-tools">
            {customTools.map(tool => {
              const inUse = stations.some(s => s.punchId === tool.id || s.dieId === tool.id) || machine.backgauge.fingerId === tool.id;
              return (
                <li key={tool.id} className="list-item" data-testid={`custom-tool-${tool.id}`}>
                  <div className="row row-between">
                    <span>
                      <strong>{tool.name}</strong> <span className="badge">{t(`tools.kind.${tool.kind}`)}</span>{' '}
                      {inUse && <span className="badge badge-user">{t('tools.inUse')}</span>}{' '}
                      {tool.kind !== 'finger' && stockStatusOf(tool) === 'not-in-stock' && <span className="badge badge-warn">{t('tools.stock.not-in-stock')}</span>}
                    </span>
                    <button type="button" className="btn btn-ghost btn-small" title={t('tools.deleteTool')} aria-label={t('tools.deleteTool')} disabled={inUse} onClick={() => { if (window.confirm(t('tools.deleteConfirm', { name: tool.name }))) actions.removeLibraryItem(tool.id); }}>✕</button>
                  </div>
                  <div className="small muted">{toolSummary(tool, t)}</div>
                  {tool.notes && <div className="small">{tool.notes}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {dialogOpen && (
        <CustomToolDialog
          onClose={() => setDialogOpen(false)}
          onCreated={tool => {
            actions.upsertLibraryItem(tool);
            actions.notify({ key: 'app.notice.customToolAdded', params: { name: tool.name } }, 'info');
            void actions.saveLibrary();
            setDialogOpen(false);
          }}
          notify={m => actions.notify(m)}
          tm={tm}
        />
      )}
    </div>
  );
}
