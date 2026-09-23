/**
 * Typed import failure. `key` is an i18n key under `errors.import.*`; `params` are interpolated
 * by the UI (`t(key, params)`). Importers throw this (never a bare Error) for unusable input.
 */
import type { Message } from '../types';

export type ImportErrorParams = Record<string, string | number>;

export class ImportError extends Error {
  readonly key: string;
  readonly params?: ImportErrorParams;

  constructor(key: string, params?: ImportErrorParams, detail?: string) {
    super(detail ? `${key}: ${detail}` : key);
    this.name = 'ImportError';
    this.key = key;
    this.params = params;
  }

  toMessage(): Message {
    return { key: this.key, params: this.params, severity: 'error' };
  }
}

/** Normalise any thrown value to an ImportError with the given key (keeps ImportErrors as they are). */
export function asImportError(err: unknown, key: string, extra?: ImportErrorParams): ImportError {
  if (err instanceof ImportError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ImportError(key, { ...extra, detail }, detail);
}

/** Build a warning message. */
export function warn(key: string, params?: Record<string, string | number>, severity: Message['severity'] = 'warning'): Message {
  return params ? { key, params, severity } : { key, severity };
}

/** Round to 3 decimals for message params. */
export function r3(v: number): number { return Math.round(v * 1000) / 1000; }
