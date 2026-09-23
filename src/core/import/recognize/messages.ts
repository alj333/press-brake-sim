/** Issue helpers: every recogniser message lives under `warnings.recognize.*`. */
import type { Message } from '../../types';

export function issue(key: string, params?: Record<string, string | number>, severity: Message['severity'] = 'warning'): Message {
  const m: Message = { key: `warnings.recognize.${key}`, severity };
  if (params) m.params = params;
  return m;
}

export function round3(v: number): number { return Math.round(v * 1000) / 1000; }

/** Bend angles are emitted at 0.01° resolution (hides float noise such as 89.9996 → 90). */
export function roundAngle(v: number): number { return Math.round(v * 100) / 100; }
