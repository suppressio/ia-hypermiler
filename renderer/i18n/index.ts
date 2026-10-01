// renderer/i18n/index.ts — renderer translations: active locale, t(), DOM
// application of `data-i18n*` attributes, locale-aware formatting via Intl.
// No library on purpose: the renderer has no bundler (it cannot import from
// node_modules), and typed dictionaries + Intl cover two languages fully.
//
// Language choice: `ui.language` ('auto' | 'en' | 'it'); 'auto' follows the
// system language (navigator.language, the same value Electron's main process
// sees via app.getLocale()).

import { en, type MessageKey } from './en.js';
import { it } from './it.js';

export type Locale = 'en' | 'it';
export type LanguageSetting = 'auto' | Locale;
export type { MessageKey };
export type MessageParams = Record<string, string | number>;

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, it };

let currentLocale: Locale = 'en';
// System locale (e.g. 'en-US'): used for date/number formats when its language
// matches the UI language, so an en-US system gets US formats and en-GB gets
// British ones; otherwise a neutral default for the UI language.
let systemLocale = '';

/** 'auto' → Italian for any Italian system locale (it, it-IT, it-CH…), English otherwise. */
export function resolveLocale(setting: LanguageSetting, systemLocale: string): Locale {
  if (setting === 'en' || setting === 'it') return setting;
  return systemLocale.toLowerCase().startsWith('it') ? 'it' : 'en';
}

export function setLocale(locale: Locale, system = ''): void {
  currentLocale = locale;
  systemLocale = system;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Replaces `{name}` placeholders; unknown placeholders are left visible on purpose. */
export function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: MessageKey, params: MessageParams = {}): string {
  return interpolate(DICTIONARIES[currentLocale][key], params);
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

/** Placeholder names used by a template — used by the dictionary parity test. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}

export const dictionaries: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = DICTIONARIES;

// Keys written in HTML attributes are plain strings: an unknown one is shown as
// is (visible in a screenshot/review) and logged, never silently swallowed.
function translateKey(key: string): string {
  if (isMessageKey(key)) return t(key);
  console.warn(`[i18n] unknown key: ${key}`);
  return key;
}

const ATTRIBUTE_TARGETS: readonly (readonly [string, string])[] = [
  ['i18nTitle', 'title'],
  ['i18nAriaLabel', 'aria-label'],
  ['i18nPlaceholder', 'placeholder'],
];

/**
 * Applies translations to every element under `root` carrying
 * `data-i18n` (text content), `data-i18n-title`, `data-i18n-aria-label` or
 * `data-i18n-placeholder`. Called at startup, on a language change and on
 * every cloned template (account detail panels).
 */
export function applyTranslations(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n;
    if (key) element.textContent = translateKey(key);
  });
  for (const [datasetKey, attribute] of ATTRIBUTE_TARGETS) {
    root.querySelectorAll<HTMLElement>(`[data-${datasetKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`).forEach((element) => {
      const key = element.dataset[datasetKey];
      if (key) element.setAttribute(attribute, translateKey(key));
    });
  }
}

// --- Locale-aware formatting (Intl) ------------------------------------------

function intlLocale(): string {
  if (systemLocale.toLowerCase().startsWith(currentLocale)) return systemLocale;
  return currentLocale === 'it' ? 'it-IT' : 'en-GB';
}

export function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits }).format(value);
}

export function formatDate(value: Date | string): string {
  return new Date(value).toLocaleDateString(intlLocale());
}

export function formatTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(value: Date | string): string {
  return new Date(value).toLocaleString(intlLocale());
}
