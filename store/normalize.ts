// store/normalize.ts — makes the store conform to AppSettings, whatever is on disk.
// Pure function, tested in store/normalize.test.ts.
//
// Why: electron-store (conf) applies DEFAULTS with a SHALLOW merge (Object.assign), so
// a field added inside a nested object already persisted (e.g. history.recentSamples,
// workSchedule.enabled, updates) on an existing installation stayed `undefined` while
// typed as always present — a real bug that already happened (see CLAUDE.md, instant
// consumption gauge). Normalizing once at startup, and on every write from IPC, makes
// the types tell the truth and the rest of the code needs no fallback.
//
// Rules:
// - object in defaults + object on disk → recursive merge;
// - array in defaults → the array on disk if it is an array, otherwise the default;
// - primitive in defaults → the value on disk if it has the same `typeof`, otherwise
//   the default (a wrong type does not get through);
// - `null` default → the value on disk if present ("null or value" fields);
// - keys on disk missing from defaults (e.g. history.lastGood) → kept.
// Accounts have a dedicated per-provider normalization (normalizeAccounts).

import type { AppSettings } from '../types/index';
import { mergeWithDefaults, isPlainRecord } from './merge';
import { migrateAccounts, normalizeAccounts } from './migrate';

/**
 * Store on disk (any shape) → valid AppSettings. `legacyLocalInsights` serves only
 * the migration from the two-slot account schema (see migrate.ts).
 */
export function normalizeSettings(raw: unknown, defaults: AppSettings): AppSettings {
  const merged = mergeWithDefaults(defaults, raw) as AppSettings;
  const rawAccounts = isPlainRecord(raw) ? raw.accounts : undefined;
  const legacyLocalInsights = isPlainRecord(raw)
    && isPlainRecord(raw.localInsights)
    && isPlainRecord(raw.localInsights.claudeCode)
    && raw.localInsights.claudeCode.enabled === true;
  // Before 0.4.6 the work schedule was one global setting: it is handed to every account
  // that has none yet, then dropped.
  const inheritedSchedule = isPlainRecord(raw) ? raw.workSchedule : undefined;
  const accounts = Array.isArray(rawAccounts)
    ? normalizeAccounts(rawAccounts, inheritedSchedule)
    : migrateAccounts(rawAccounts, legacyLocalInsights, inheritedSchedule);
  // The old global `localInsights` flag and work schedule (now per account) are not part
  // of AppSettings.
  const result: AppSettings & { localInsights?: unknown; workSchedule?: unknown } = { ...merged, accounts };
  delete result.localInsights;
  delete result.workSchedule;
  return result;
}
