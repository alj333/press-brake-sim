/**
 * ui — Part panel: import (drop zone, 3D / DXF inputs, units overrides, sample menu), part name,
 * material and thickness, import / part messages, the flat-pattern canvas and the bends table.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BendLine } from '../../core/types';
import { SAMPLE_NAMES } from '../sampleNames';
import { useI18n } from '../../i18n';
import { useProjectStore } from '../store';
import { FileDrop } from '../components/FileDrop';
import { FlatView } from '../components/FlatView';
import { MessageList } from '../components/MessageList';
import { NumberField } from '../components/NumberField';
import { SourceBadge } from '../components/SourceBadge';
import { fmt } from '../format';

const DXF_UNIT_OPTIONS = ['auto', 'mm', 'in', 'cm', 'm'] as const;
const MESH_UNIT_OPTIONS = ['auto', 'mm', 'in', 'cm', 'm'] as const;

function bendLength(b: BendLine): number {
  return Math.hypot(b.p1.x - b.p0.x, b.p1.y - b.p0.y);
}

export function PartPanel() {
  const { t } = useI18n();
  const project = useProjectStore(s => s.project);
  const library = useProjectStore(s => s.library);
  const thickness = useProjectStore(s => s.thickness);
  const importing = useProjectStore(s => s.importing);
  const importWarnings = useProjectStore(s => s.importWarnings);
  const recognized = useProjectStore(s => s.recognized);
  const matchInfo = useProjectStore(s => s.matchInfo);
  const mesh = useProjectStore(s => s.mesh);
  const dxfUnits = useProjectStore(s => s.dxfUnits);
  const meshUnits = useProjectStore(s => s.meshUnits);
  const selectedBendId = useProjectStore(s => s.selectedBendId);
  const actions = useProjectStore.getState();
  const [addMode, setAddMode] = useState(false);
  const [sampleOpen, setSampleOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sampleOpen) return;
    const onDown = (e: MouseEvent): void => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setSampleOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setSampleOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [sampleOpen]);

  const part = project.part;
  const flat = part?.flat ?? null;
  const summary = useMemo(() => {
    if (!part) return null;
    const w = part.flatBounds.max.x - part.flatBounds.min.x, h = part.flatBounds.max.y - part.flatBounds.min.y;
    return { flanges: part.flanges.length, bends: part.flat.bends.length, holes: part.flat.holes.length, w: fmt(w, 1), h: fmt(h, 1) };
  }, [part]);

  return (
    <div className="panel part-panel">
      <section className="panel-section">
        <h3 className="section-title">{t('part.import')}</h3>
        <FileDrop onFiles={files => { void actions.importFiles(files); }} disabled={importing}>
          <div className="menu-wrap" ref={menuRef}>
            <button type="button" className="btn" onClick={() => setSampleOpen(o => !o)} aria-haspopup="menu" aria-expanded={sampleOpen} data-testid="sample-menu">
              {t('part.loadSample')} ▾
            </button>
            {sampleOpen && (
              <ul className="menu" role="menu">
                {SAMPLE_NAMES.map(name => (
                  <li key={name} role="none">
                    <button type="button" role="menuitem" className="menu-item" data-testid={`sample-${name}`} onClick={() => { setSampleOpen(false); void actions.loadSample(name); }}>
                      {t(`part.sample.${name}`)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FileDrop>
        <div className="row row-wrap">
          <label className="field">
            <span className="field-label">{t('part.dxfUnits')}</span>
            <select value={dxfUnits} onChange={e => actions.setDxfUnits(e.target.value as typeof dxfUnits)} data-testid="dxf-units">
              {DXF_UNIT_OPTIONS.map(u => <option key={u} value={u}>{t(`part.units.${u}`)}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('part.meshUnits')}</span>
            <select value={meshUnits} onChange={e => actions.setMeshUnits(e.target.value as typeof meshUnits)} data-testid="mesh-units">
              {MESH_UNIT_OPTIONS.map(u => <option key={u} value={u}>{t(`part.units.${u}`)}</option>)}
            </select>
          </label>
          {importing && <span className="muted busy" data-testid="part-importing">{t('part.importing')}</span>}
        </div>
      </section>

      <section className="panel-section">
        <div className="row row-wrap">
          <label className="field field-grow">
            <span className="field-label">{t('part.name')}</span>
            <input type="text" value={flat?.name ?? ''} disabled={!flat} onChange={e => actions.setPartName(e.target.value)} data-testid="part-name" />
          </label>
          <label className="field">
            <span className="field-label">{t('part.material')}</span>
            <select value={project.materialId} onChange={e => actions.setMaterial(e.target.value)} data-testid="material-select">
              {library.materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <NumberField label={t('part.thickness')} value={thickness} onCommit={v => actions.setThickness(v)} min={0.1} max={50} step={0.1} digits={2} testId="thickness-input" />
        </div>
        {recognized && (
          <p className="muted small" data-testid="part-recognized">
            {t('part.recognized', { bends: recognized.bendCount, thickness: fmt(recognized.thickness, 2), confidence: Math.round(recognized.confidence * 100) })}
            {mesh && <> · {t('part.mesh', { triangles: mesh.indices.length / 3 })}</>}
            {matchInfo && <> · {t('part.matched', { pairs: matchInfo.pairs, count: matchInfo.count })}</>}
          </p>
        )}
        {importWarnings.length > 0 && (
          <details className="details" open={importWarnings.some(w => w.severity === 'error')}>
            <summary>{t('part.importWarnings')} ({importWarnings.length})</summary>
            <MessageList messages={importWarnings} testId="import-warnings" />
          </details>
        )}
        {part && part.warnings.length > 0 && (
          <details className="details" open>
            <summary>{t('part.partWarnings')} ({part.warnings.length})</summary>
            <MessageList messages={part.warnings} testId="part-warnings" />
          </details>
        )}
      </section>

      <section className="panel-section">
        <div className="row row-between">
          <h3 className="section-title">{t('part.flatView')}</h3>
          {summary && <span className="muted small" data-testid="part-summary" data-flanges={summary.flanges} data-bends={summary.bends} data-holes={summary.holes}>{t('part.summary', summary)}</span>}
        </div>
        <FlatView
          flat={flat}
          part={part}
          selectedBendId={selectedBendId}
          onSelectBend={id => actions.selectBend(id)}
          addMode={addMode}
          onAddBend={(p0, p1) => { actions.addBend(p0, p1); setAddMode(false); }}
          height={240}
        />
        <div className="row legend small">
          <span><i className="swatch swatch-up" /> {t('part.legend.up')}</span>
          <span><i className="swatch swatch-down" /> {t('part.legend.down')}</span>
          <span><i className="swatch swatch-hole" /> {t('part.legend.hole')}</span>
          <span className="row-grow" />
          {flat && (
            <button type="button" className={addMode ? 'btn btn-on' : 'btn'} onClick={() => setAddMode(m => !m)} data-testid="add-bend">
              {addMode ? t('part.cancelAddBend') : t('part.addBend')}
            </button>
          )}
        </div>
      </section>

      <section className="panel-section">
        <h3 className="section-title">{t('part.bends')}</h3>
        {!flat && <p className="muted">{t('part.noPart')}</p>}
        {flat && flat.bends.length === 0 && <p className="muted">{t('part.noBends')}</p>}
        {flat && flat.bends.length > 0 && (
          <div className="table-wrap">
            <table className="table bends-table" data-testid="bends-table">
              <thead>
                <tr>
                  <th>{t('part.bend.id')}</th>
                  <th>{t('part.bend.direction')}</th>
                  <th>{t('part.bend.angle')}</th>
                  <th>{t('part.bend.innerRadius')}</th>
                  <th>{t('part.bend.kFactor')}</th>
                  <th>{t('part.bend.correction')}</th>
                  <th>{t('part.bend.length')}</th>
                  <th>{t('part.bend.allowance')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {flat.bends.map(b => {
                  const selected = b.id === selectedBendId;
                  return (
                    <tr key={b.id} data-testid={`bend-row-${b.id}`} className={selected ? 'row-selected' : undefined} onClick={() => actions.selectBend(b.id)}>
                      <td className="cell-id">
                        <strong>{b.id}</strong> <SourceBadge source={b.sources.geometry} />
                        {b.hem && <span className="badge badge-hem" title={t(`part.bend.hem.${b.hem}`)}>{t('part.bend.hem')}</span>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className={b.direction === 'up' ? 'btn btn-small dir-up' : 'btn btn-small dir-down'}
                          title={t('part.bend.toggleDirection')}
                          data-testid={`bend-dir-${b.id}`}
                          onClick={e => { e.stopPropagation(); actions.setBend(b.id, { direction: b.direction === 'up' ? 'down' : 'up' }); }}
                        >
                          {b.direction === 'up' ? `↑ ${t('common.up')}` : `↓ ${t('common.down')}`}
                        </button>
                        {' '}<SourceBadge source={b.sources.direction} />
                      </td>
                      <td>
                        <NumberField value={b.angle} onCommit={v => actions.setBend(b.id, { angle: v })} min={0.5} max={180} step={0.5} digits={2} testId={`bend-angle-${b.id}`} size={5} />
                        {' '}<SourceBadge source={b.sources.angle} />
                      </td>
                      <td>
                        <NumberField value={b.innerRadius} onCommit={v => actions.setBend(b.id, { innerRadius: v })} min={0} max={200} step={0.1} digits={3} testId={`bend-radius-${b.id}`} size={5} />
                        {' '}<SourceBadge source={b.sources.radius} />
                      </td>
                      <td><NumberField value={b.kFactor} onCommit={v => actions.setBend(b.id, { kFactor: v })} min={0.05} max={1} step={0.01} digits={3} testId={`bend-k-${b.id}`} size={4} /></td>
                      <td><NumberField value={b.angleCorrection ?? 0} onCommit={v => actions.setBend(b.id, { angleCorrection: v })} min={-45} max={45} step={0.5} digits={2} testId={`bend-corr-${b.id}`} size={4} /></td>
                      <td className="num-cell">{fmt(bendLength(b), 1)}</td>
                      <td className="num-cell">{fmt(part?.bendAllowance[b.id], 2)}</td>
                      <td>
                        <button type="button" className="btn btn-ghost btn-small" title={t('part.bend.delete')} aria-label={t('part.bend.delete')} data-testid={`bend-delete-${b.id}`} onClick={e => { e.stopPropagation(); actions.removeBend(b.id); }}>✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
