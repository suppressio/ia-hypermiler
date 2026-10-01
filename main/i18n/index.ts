// main/i18n/index.ts — main-process translations. Same model as renderer/i18n
// (typed flat dictionaries, `{name}` placeholders, no library); kept as a separate
// copy because main and renderer are separate TypeScript projects (CommonJS vs ES
// modules) — resolveLocale must stay identical to renderer/i18n/index.ts.

import { en, type MainMessageKey } from './en';
import { it } from './it';
import type { LanguageSetting } from '../../types/index';

export type Locale = 'en' | 'it';
export type { MainMessageKey };

const DICTIONARIES: Record<Locale, Record<MainMessageKey, string>> = { en, it };

let currentLocale: Locale = 'en';

/** 'auto' → Italian for any Italian system locale (it, it-IT, it-CH…), English otherwise. */
export function resolveLocale(setting: LanguageSetting, systemLocale: string): Locale {
  if (setting === 'en' || setting === 'it') return setting;
  return systemLocale.toLowerCase().startsWith('it') ? 'it' : 'en';
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: MainMessageKey, params: Record<string, string | number> = {}): string {
  return interpolate(DICTIONARIES[currentLocale][key], params);
}

export const dictionaries: Readonly<Record<Locale, Readonly<Record<MainMessageKey, string>>>> = DICTIONARIES;
