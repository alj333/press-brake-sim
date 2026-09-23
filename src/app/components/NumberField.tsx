/**
 * ui — numeric input that edits a local draft and commits on blur / Enter (Escape reverts), so
 * the part model is not rebuilt on every keystroke and half-typed values never reach the store.
 */
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { fmt } from '../format';

export interface NumberFieldProps {
  value: number;
  onCommit: (value: number) => void;
  label?: string | undefined;
  unit?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  /** Decimals shown when the value is (re)formatted. Default 2. */
  digits?: number | undefined;
  disabled?: boolean | undefined;
  testId?: string | undefined;
  className?: string | undefined;
  title?: string | undefined;
  /** Commit while typing as soon as the draft is a valid number (default false). */
  live?: boolean | undefined;
  size?: number | undefined;
}

export function NumberField({ value, onCommit, label, unit, min, max, step, digits = 2, disabled, testId, className, title, live, size }: NumberFieldProps) {
  const formatted = Number.isFinite(value) ? fmt(value, digits) : '';
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);
  const [lastFormatted, setLastFormatted] = useState(formatted);
  /** Text shown when the field was focused — a commit needs an actual edit relative to it. */
  const focusText = useRef(formatted);
  if (lastFormatted !== formatted) {           // the value changed outside: refresh the draft (derived state)
    setLastFormatted(formatted);
    if (!editing) setDraft(formatted);
  }

  const parse = (text: string): number | null => {
    const n = Number(text.trim().replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    let v = n;
    if (min !== undefined && v < min) v = min;
    if (max !== undefined && v > max) v = max;
    return v;
  };

  const commit = (): void => {
    setEditing(false);
    const v = parse(draft);
    if (v === null) { setDraft(formatted); return; }
    // only a text edit commits: focusing and leaving a field whose value has more decimals than
    // `digits` shows must not push the rounded display value back into the store, and a value
    // that changed underneath an untouched field is not overwritten with the old text
    const edited = draft.trim() !== focusText.current.trim();
    if (edited && v !== value) onCommit(v);
    setDraft(edited || draft.trim() === formatted ? fmt(v, digits) : formatted);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }   // blur commits (once)
    else if (e.key === 'Escape') { setDraft(formatted); setEditing(false); (e.target as HTMLInputElement).blur(); }
  };

  const input = (
    <input
      type="number"
      className={className ? `num ${className}` : 'num'}
      value={draft}
      min={min}
      max={max}
      step={step ?? 'any'}
      disabled={disabled}
      data-testid={testId}
      title={title}
      size={size}
      onFocus={() => { focusText.current = draft; setEditing(true); }}
      onChange={e => {
        setDraft(e.target.value);
        if (live) {
          const v = parse(e.target.value);
          if (v !== null && v !== value) onCommit(v);
        }
      }}
      onBlur={commit}
      onKeyDown={onKeyDown}
      inputMode="decimal"
    />
  );
  if (!label && !unit) return input;
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      <span className="field-input">
        {input}
        {unit && <span className="field-unit">{unit}</span>}
      </span>
    </label>
  );
}
