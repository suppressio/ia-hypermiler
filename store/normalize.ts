// store/normalize.ts — rende lo store conforme ad AppSettings, qualunque cosa ci
// sia su disco. Funzione pura, testata in store/normalize.test.ts.
//
// Perché: electron-store (conf) applica i DEFAULTS con un merge SHALLOW
// (Object.assign), quindi un campo aggiunto dentro un oggetto annidato già
// persistito (es. history.recentSamples, workSchedule.enabled, updates) su
// un'installazione esistente restava `undefined` pur essendo tipizzato come
// sempre presente — bug reale già capitato (vedi CLAUDE.md, gauge "consumo
// istantaneo"). Normalizzando una volta all'avvio, e ad ogni scrittura da IPC,
// i tipi dicono il vero e il resto del codice non ha bisogno di fallback.
//
// Regole:
// - oggetto nei default + oggetto su disco → merge ricorsivo;
// - array nei default → l'array su disco se è un array, altrimenti il default;
// - primitivo nei default → il valore su disco se ha lo stesso `typeof`,
//   altrimenti il default (un tipo sbagliato non passa);
// - default `null` → il valore su disco se presente (campi "null oppure valore");
// - chiavi su disco assenti nei default (es. history.lastGood) → conservate.
// Gli account hanno una normalizzazione dedicata per provider (normalizeAccounts).

import type { AppSettings } from '../types/index';
import { mergeWithDefaults, isPlainRecord } from './merge';
import { migrateAccounts, normalizeAccounts } from './migrate';

/**
 * Store su disco (qualunque forma) → AppSettings valido. `legacyLocalInsights`
 * serve solo alla migrazione dallo schema account a due slot (vedi migrate.ts).
 */
export function normalizeSettings(raw: unknown, defaults: AppSettings): AppSettings {
  const merged = mergeWithDefaults(defaults, raw) as AppSettings;
  const rawAccounts = isPlainRecord(raw) ? raw.accounts : undefined;
  const legacyLocalInsights = isPlainRecord(raw)
    && isPlainRecord(raw.localInsights)
    && isPlainRecord(raw.localInsights.claudeCode)
    && raw.localInsights.claudeCode.enabled === true;
  const accounts = Array.isArray(rawAccounts)
    ? normalizeAccounts(rawAccounts)
    : migrateAccounts(rawAccounts, legacyLocalInsights);
  // Il vecchio flag globale `localInsights` (ora per-account) non fa parte di AppSettings.
  const result: AppSettings & { localInsights?: unknown } = { ...merged, accounts };
  delete result.localInsights;
  return result;
}
