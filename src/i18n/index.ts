/**
 * ui — i18n: flat dictionaries (en.json is the reference, th.json mirrors every key),
 * `translate(lang, key, params)` with `{{param}}` / `{param}` interpolation and English fallback,
 * the React `LanguageProvider` / `useI18n()` and `tm(message)` for core `Message` objects.
 * See docs/specs/ui.md §1.
 */
import { createContext, createElement, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Language, Message } from '../core/types';
import en from './en.json';
import th from './th.json';

export type Params = Record<string, string | number>;
export type Dictionary = Record<string, string>;

export const LANGUAGES: readonly Language[] = ['en', 'th'];

export const dictionaries: Record<Language, Dictionary> = { en: en as Dictionary, th: th as Dictionary };

/** Native name of a language for the toggle. */
export function languageName(lang: Language): string {
  return lang === 'th' ? 'ไทย' : 'English';
}

export function isLanguage(v: unknown): v is Language {
  return v === 'en' || v === 'th';
}

/** Replace `{{name}}` and `{name}` with the parameter values; unknown names stay as written. */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (m, a: string | undefined, b: string | undefined) => {
    const name = a ?? b ?? '';
    return name in params ? String(params[name]) : m;
  });
}

/** Look a key up in `lang`, then in English, else return the key itself. */
export function translate(lang: Language, key: string, params?: Params): string {
  const s = dictionaries[lang]?.[key] ?? dictionaries.en[key];
  if (s === undefined) return key;
  return interpolate(s, params);
}

export function hasKey(key: string, lang: Language = 'en'): boolean {
  return dictionaries[lang]?.[key] !== undefined;
}

export function translateMessage(lang: Language, message: Message): string {
  return translate(lang, message.key, message.params);
}

// ── module-level language (for non-React code: toasts, CSV headers) ─────────

let globalLanguage: Language = 'en';

export function setGlobalLanguage(lang: Language): void {
  globalLanguage = isLanguage(lang) ? lang : 'en';
}

export function getGlobalLanguage(): Language {
  return globalLanguage;
}

/** Translate with the current global language. */
export function t(key: string, params?: Params): string {
  return translate(globalLanguage, key, params);
}

/** Translate a core `Message` with the current global language. */
export function tm(message: Message): string {
  return translate(globalLanguage, message.key, message.params);
}

// ── React ─────────────────────────────────────────────────────────────────

export type TFn = (key: string, params?: Params) => string;

export interface I18n {
  lang: Language;
  t: TFn;
  tm: (message: Message) => string;
  setLanguage: (lang: Language) => void;
}

const defaultI18n: I18n = {
  lang: 'en',
  t: (key, params) => translate('en', key, params),
  tm: message => translate('en', message.key, message.params),
  setLanguage: () => {},
};

const I18nContext = createContext<I18n>(defaultI18n);

export interface LanguageProviderProps {
  language: Language;
  onChange?: ((lang: Language) => void) | undefined;
  children?: ReactNode;
}

/** Provides `t` / `tm` for `language`; `onChange` receives the toggle's request. */
export function LanguageProvider({ language, onChange, children }: LanguageProviderProps) {
  const lang: Language = isLanguage(language) ? language : 'en';
  const tFn = useCallback<TFn>((key, params) => translate(lang, key, params), [lang]);
  const tmFn = useCallback((message: Message) => translate(lang, message.key, message.params), [lang]);
  const setLanguage = useCallback((next: Language) => { onChange?.(next); }, [onChange]);
  const value = useMemo<I18n>(() => ({ lang, t: tFn, tm: tmFn, setLanguage }), [lang, tFn, tmFn, setLanguage]);
  return createElement(I18nContext.Provider, { value }, children);
}

/** The current translator (English without a provider). */
export function useI18n(): I18n {
  return useContext(I18nContext);
}
