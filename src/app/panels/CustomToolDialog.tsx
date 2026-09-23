/**
 * ui — "Add custom tool" dialog: DXF cross-section → importToolProfileDxf → preview → reference
 * point (click or auto) + up direction + mirror + scale → normalizeProfile (messages; errors block
 * saving) → metadata (name, kind, rating, segment lengths, overrides) → createCustomPunch/Die/Finger.
 */
import { useMemo, useRef, useState } from 'react';
import type { Die, Finger, Message, Punch, Vec2 } from '../../core/types';
import { ImportError, importToolProfileDxf } from '../../core/import';
import type { DxfUnits } from '../../core/import';
import { createCustomDie, createCustomFinger, createCustomPunch, derivePunchParams, deriveDieParams, deriveFingerParams, normalizeProfile } from '../../core/tools';
import type { ProfileUpDir, ToolKind } from '../../core/tools';
import { useI18n } from '../../i18n';
import { Dialog } from '../components/Dialog';
import { MessageList } from '../components/MessageList';
import { ProfilePreview } from '../components/ProfilePreview';
import { fmt, parseNumberList } from '../format';

export interface CustomToolDialogProps {
  onClose: () => void;
  onCreated: (tool: Punch | Die | Finger) => void;
  notify: (m: Message) => void;
  tm: (m: Message) => string;
}

const UP_DIRS: ProfileUpDir[] = ['y+', 'y-', 'x+', 'x-'];
const UNITS: Array<'auto' | DxfUnits> = ['auto', 'mm', 'in', 'cm'];

function numOrUndefined(text: string): number | undefined {
  const s = text.trim();
  if (!s) return undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

export function CustomToolDialog({ onClose, onCreated, notify, tm }: CustomToolDialogProps) {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<{ text: string; fileName: string } | null>(null);
  const [readError, setReadError] = useState<Message | null>(null);
  const [kind, setKind] = useState<ToolKind>('punch');
  const [name, setName] = useState('');
  const [units, setUnits] = useState<'auto' | DxfUnits>('auto');
  const [reference, setReference] = useState<Vec2 | null>(null);
  const [upDir, setUpDir] = useState<ProfileUpDir>('y+');
  const [mirror, setMirror] = useState(false);
  const [scale, setScale] = useState('1');
  const [rating, setRating] = useState('');
  const [segments, setSegments] = useState('');
  const [notes, setNotes] = useState('');
  const [tipAngle, setTipAngle] = useState('');
  const [tipRadius, setTipRadius] = useState('');
  const [vWidth, setVWidth] = useState('');
  const [vAngle, setVAngle] = useState('');
  const [fingerWidth, setFingerWidth] = useState('');

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const text = await file.text();
      setSource({ text, fileName: file.name });
      setReadError(null);
      setReference(null);
      if (!name) setName(file.name.replace(/\.[^.]+$/, ''));
    } catch {
      setSource(null);
      setReadError({ key: 'errors.app.readFailed', params: { name: file.name }, severity: 'error' });
    }
  };

  // parsed profile — re-derived when the units override changes after the file was chosen
  const parsed = useMemo<{ raw: { points: Vec2[]; units: DxfUnits; warnings: Message[]; fileName: string } | null; error: Message | null }>(() => {
    if (!source) return { raw: null, error: null };
    try {
      const res = importToolProfileDxf(source.text, units === 'auto' ? {} : { units });
      return { raw: { points: res.points, units: res.units, warnings: res.warnings, fileName: source.fileName }, error: null };
    } catch (err) {
      const error: Message = err instanceof ImportError ? err.toMessage() : { key: 'errors.import.unknown', params: { detail: err instanceof Error ? err.message : String(err) }, severity: 'error' };
      return { raw: null, error };
    }
  }, [source, units]);
  const raw = parsed.raw;
  const fileError = readError ?? parsed.error;

  const scaleNum = numOrUndefined(scale) ?? 1;
  const normalized = useMemo(() => {
    if (!raw) return null;
    return normalizeProfile(raw.points, { kind, ...(reference ? { referencePoint: reference } : {}), upDir, mirrorX: mirror, scale: scaleNum > 0 ? scaleNum : 1 });
  }, [raw, kind, reference, upDir, mirror, scaleNum]);

  const derived = useMemo(() => {
    if (!normalized || normalized.profile.points.length < 3) return null;
    const pts = normalized.profile.points;
    if (kind === 'punch') { const d = derivePunchParams(pts); return { text: `${t('tools.tipAngle')} ${fmt(d.tipAngle, 1)} · ${t('tools.tipRadius')} ${fmt(d.tipRadius, 2)} · ${t('tools.bodyWidth')} ${fmt(d.bodyWidth, 1)} · ${t('tools.height')} ${fmt(d.height, 1)}`, highlight: d.arcVertices, messages: d.messages }; }
    if (kind === 'die') { const d = deriveDieParams(pts); return { text: `${t('tools.vWidth')} ${fmt(d.vWidth, 2)} · ${t('tools.vAngle')} ${fmt(d.vAngle, 1)} · ${t('tools.shoulderRadius')} ${fmt(d.shoulderRadius, 2)} · ${t('tools.bodyWidth')} ${fmt(d.bodyWidth, 1)} · ${t('tools.height')} ${fmt(d.height, 1)}`, highlight: [], messages: d.messages }; }
    const d = deriveFingerParams(pts);
    return { text: `${t('tools.stopHeight')} ${fmt(d.stopHeight, 1)} · ${t('tools.bodyDepth')} ${fmt(d.bodyDepth, 1)} · ${t('tools.height')} ${fmt(d.height, 1)}`, highlight: [], messages: d.messages };
  }, [normalized, kind, t]);

  const messages = useMemo<Message[]>(() => [...(raw?.warnings ?? []), ...(normalized?.messages ?? []), ...(derived?.messages ?? [])], [raw, normalized, derived]);
  const blocked = !normalized || normalized.messages.some(m => m.severity === 'error');

  const save = (): void => {
    if (!normalized || blocked) return;
    const meta = {
      name: name.trim() || undefined,
      maxLoadPerMeter: numOrUndefined(rating),
      segmentLengths: segments.trim() ? parseNumberList(segments) : undefined,
      notes: notes.trim() || undefined,
    };
    const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
    let tool: Punch | Die | Finger;
    try {
      if (kind === 'punch') tool = createCustomPunch(normalized.profile, clean({ ...meta, tipAngle: numOrUndefined(tipAngle), tipRadius: numOrUndefined(tipRadius) }));
      else if (kind === 'die') tool = createCustomDie(normalized.profile, clean({ ...meta, vWidth: numOrUndefined(vWidth), vAngle: numOrUndefined(vAngle), family: 'custom' as const }));
      else tool = createCustomFinger(normalized.profile, clean({ ...meta, width: numOrUndefined(fingerWidth) }));
    } catch (err) {
      notify({ key: 'errors.import.unknown', params: { detail: err instanceof Error ? err.message : String(err) }, severity: 'error' });
      return;
    }
    onCreated(tool);
  };

  return (
    <Dialog title={t('tools.dialog.title')} onClose={onClose} testId="custom-tool-dialog" wide
      footer={(
        <>
          <span className="muted small">{blocked && raw ? t('tools.dialog.invalidProfile') : ''}</span>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={blocked} onClick={save} data-testid="custom-tool-save">{t('tools.dialog.save')}</button>
        </>
      )}
    >
      <div className="dialog-grid">
        <div className="dialog-col">
          <label className="field">
            <span className="field-label">{t('tools.dialog.file')}</span>
            <input ref={fileInput} type="file" accept=".dxf" data-testid="custom-tool-file" onChange={() => { void onFile(fileInput.current?.files?.[0]); }} />
          </label>
          <label className="field">
            <span className="field-label">{t('tools.dialog.units')}</span>
            <select value={units} onChange={e => { setUnits(e.target.value as 'auto' | DxfUnits); setReference(null); }} data-testid="custom-tool-units">
              {UNITS.map(u => <option key={u} value={u}>{u === 'auto' ? t('part.units.auto') : u}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('tools.dialog.kind')}</span>
            <select value={kind} onChange={e => { setKind(e.target.value as ToolKind); setReference(null); }} data-testid="custom-tool-kind">
              <option value="punch">{t('tools.kind.punch')}</option>
              <option value="die">{t('tools.kind.die')}</option>
              <option value="finger">{t('tools.kind.finger')}</option>
            </select>
          </label>
          <p className="small muted">{t(`tools.dialog.hint.${kind}`)}</p>
          <label className="field">
            <span className="field-label">{t('tools.dialog.name')}</span>
            <input type="text" value={name} onChange={e => setName(e.target.value)} data-testid="custom-tool-name" />
          </label>
          <label className="field">
            <span className="field-label">{t('tools.dialog.upDir')}</span>
            <select value={upDir} onChange={e => setUpDir(e.target.value as ProfileUpDir)} data-testid="custom-tool-updir">
              {UP_DIRS.map(d => <option key={d} value={d}>{t(`tools.dialog.upDir.${d}`)}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={mirror} onChange={e => setMirror(e.target.checked)} data-testid="custom-tool-mirror" /> {t('tools.dialog.mirror')}</label>
          <label className="field">
            <span className="field-label">{t('tools.dialog.scale')}</span>
            <input type="number" step="any" value={scale} onChange={e => setScale(e.target.value)} title={t('tools.dialog.scaleHint')} data-testid="custom-tool-scale" />
          </label>
          <div className="field">
            <span className="field-label">{t('tools.dialog.reference')}</span>
            <span className="row row-wrap small">
              <span>{reference ? t('tools.dialog.referenceAt', { x: fmt(reference.x, 2), y: fmt(reference.y, 2) }) : t('tools.dialog.referenceAuto')}</span>
              {reference && <button type="button" className="btn btn-small" onClick={() => setReference(null)}>{t('tools.dialog.clearReference')}</button>}
            </span>
            <span className="small muted">{t('tools.dialog.referenceHint')}</span>
          </div>
          <label className="field">
            <span className="field-label">{t('tools.dialog.rating')}</span>
            <input type="number" step="any" value={rating} onChange={e => setRating(e.target.value)} placeholder="600" data-testid="custom-tool-rating" />
          </label>
          <label className="field">
            <span className="field-label">{t('tools.dialog.segments')}</span>
            <input type="text" value={segments} onChange={e => setSegments(e.target.value)} placeholder="835, 415, 100, 50" data-testid="custom-tool-segments" />
          </label>
          <fieldset className="fieldset">
            <legend>{t('tools.dialog.overrides')}</legend>
            {kind === 'punch' && (
              <div className="row row-wrap">
                <label className="field"><span className="field-label">{t('tools.tipAngle')}</span><input type="number" step="any" value={tipAngle} onChange={e => setTipAngle(e.target.value)} data-testid="custom-tool-tip-angle" /></label>
                <label className="field"><span className="field-label">{t('tools.tipRadius')}</span><input type="number" step="any" value={tipRadius} onChange={e => setTipRadius(e.target.value)} data-testid="custom-tool-tip-radius" /></label>
              </div>
            )}
            {kind === 'die' && (
              <div className="row row-wrap">
                <label className="field"><span className="field-label">{t('tools.vWidth')}</span><input type="number" step="any" value={vWidth} onChange={e => setVWidth(e.target.value)} data-testid="custom-tool-v-width" /></label>
                <label className="field"><span className="field-label">{t('tools.vAngle')}</span><input type="number" step="any" value={vAngle} onChange={e => setVAngle(e.target.value)} data-testid="custom-tool-v-angle" /></label>
              </div>
            )}
            {kind === 'finger' && (
              <label className="field"><span className="field-label">{t('tools.dialog.width')}</span><input type="number" step="any" value={fingerWidth} onChange={e => setFingerWidth(e.target.value)} data-testid="custom-tool-width" /></label>
            )}
          </fieldset>
          <label className="field">
            <span className="field-label">{t('tools.dialog.notes')}</span>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)} data-testid="custom-tool-notes" />
          </label>
        </div>
        <div className="dialog-col">
          {!raw && <p className="muted">{t('tools.dialog.noProfile')}</p>}
          {raw && (
            <>
              <div className="small muted">{t('tools.dialog.raw')} — {t('tools.dialog.profilePoints', { count: raw.points.length, units: raw.units })}</div>
              <ProfilePreview points={raw.points} marker={reference} onPick={p => setReference(p)} showFrame={false} height={200} testId="custom-tool-raw-preview" />
              <div className="small muted">{t('tools.dialog.normalized')}</div>
              <ProfilePreview points={normalized?.profile.points ?? []} highlight={derived?.highlight ?? []} height={200} testId="custom-tool-preview" />
              {derived && <div className="small">{t('tools.dialog.derived')}: {derived.text}</div>}
            </>
          )}
          {fileError && <MessageList messages={[fileError]} />}
          {messages.length > 0 && <MessageList messages={messages} testId="custom-tool-messages" />}
          {messages.length === 0 && raw && <p className="small muted">{tm({ key: 'tools.dialog.profilePoints', params: { count: normalized?.profile.points.length ?? 0, units: 'mm' } })}</p>}
        </div>
      </div>
    </Dialog>
  );
}
