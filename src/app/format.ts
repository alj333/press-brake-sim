/** ui — number / unit formatting helpers (docs/specs/ui.md §5). */
import type { Language } from '../core/types';

/** 1 tonne-force = 9.80665 kN. */
export const KN_PER_TONNE = 9.80665;

/** Fixed digits with trailing zeros trimmed; '–' for non-finite values. */
export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const s = n.toFixed(digits);
  if (!s.includes('.')) return s;
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

export function fmtAngle(deg: number | null | undefined, digits = 1): string {
  return `${fmt(deg, digits)}°`;
}

export function fmtMm(v: number | null | undefined, digits = 2): string {
  return `${fmt(v, digits)} mm`;
}

export function kNToTonnes(kN: number): number {
  return kN / KN_PER_TONNE;
}

/** "11.9 kN (1.22 t)" */
export function fmtForce(kN: number | null | undefined): string {
  if (kN === null || kN === undefined || !Number.isFinite(kN)) return '–';
  return `${fmt(kN, 1)} kN (${fmt(kNToTonnes(kN), 2)} t)`;
}

export function fmtPercent(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return `${fmt(v, 0)} %`;
}

export function fmtDate(date: Date, lang: Language): string {
  try {
    return new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** "835, 835, 415" → [835, 835, 415]; invalid tokens are dropped. */
export function parseNumberList(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0);
}

export function joinNumberList(values: readonly number[]): string {
  return values.map(v => fmt(v, 2)).join(', ');
}

/** Round to `digits` decimals (for stored values). */
export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
