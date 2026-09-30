// store/normalize.test.ts — normalizzazione dello store su disco (store/normalize.ts):
// campi mancanti, tipi sbagliati, schema account legacy. Nessun electron-store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from './normalize';
import { mergeWithDefaults } from './merge';
import { DEFAULTS } from './defaults';
import { at } from '../tests/support/at';

test('mergeWithDefaults: merge profondo, tipi sbagliati sostituiti, chiavi extra conservate', () => {
  const defaults = { a: 1, nested: { flag: true, list: [] as number[] }, nullable: null as string | null };
  const raw = { a: 'uno', nested: { list: [3] }, nullable: 'x', extra: 42 };
  assert.deepEqual(mergeWithDefaults(defaults, raw), { a: 1, nested: { flag: true, list: [3] }, nullable: 'x', extra: 42 });
});

test('mergeWithDefaults: valore non oggetto al posto di un oggetto → default', () => {
  assert.deepEqual(mergeWithDefaults({ x: { y: 1 } }, { x: 'rotto' }), { x: { y: 1 } });
  assert.deepEqual(mergeWithDefaults([1], 'non un array'), [1]);
});

test('normalizeSettings: store vuoto o non valido → i default', () => {
  assert.deepEqual(normalizeSettings(undefined, DEFAULTS), DEFAULTS);
  assert.deepEqual(normalizeSettings('corrotto', DEFAULTS), DEFAULTS);
});

test('normalizeSettings: campi aggiunti dopo il primo rilascio compaiono su uno store vecchio (bug merge shallow)', () => {
  // Forma reale di uno store 0.1.x: history senza recentSamples, workSchedule senza
  // enabled, nessuna sezione updates.
  const legacy = {
    history: { dailyUsage: [{ date: '2026-09-01', accountId: 'claude', windowId: 'w', used: 10 }], retentionDays: 90 },
    workSchedule: { days: DEFAULTS.workSchedule.days, hoursPerDay: 6 },
    ui: { windowStyle: 'filled-dark' },
  };
  const result = normalizeSettings(legacy, DEFAULTS);
  assert.deepEqual(result.history.recentSamples, []);
  assert.equal(result.history.dailyUsage.length, 1);
  assert.equal(result.workSchedule.enabled, true);
  assert.equal(result.workSchedule.hoursPerDay, 6);
  assert.equal(result.ui.windowStyle, 'filled-dark');
  assert.equal(result.ui.notificationThresholdPercent, 80);
  assert.deepEqual(result.updates, DEFAULTS.updates);
});

test('normalizeSettings: history.lastGood (non nei default) resta', () => {
  const lastGood = { claude: { planTier: null, subscriptionRenewsAt: null, quotaWindows: [], accountId: 'claude', lastUpdatedAt: 'x' } };
  const result = normalizeSettings({ history: { lastGood } }, DEFAULTS);
  assert.deepEqual(result.history.lastGood, lastGood);
});

test('normalizeSettings: schema account legacy migrato e vecchio flag localInsights rimosso', () => {
  const result = normalizeSettings({
    accounts: { claude: { enabled: true, session: { sessionKey: 'sk' } } },
    localInsights: { claudeCode: { enabled: true } },
  }, DEFAULTS);
  const claude = at(result.accounts, 0);
  assert.equal(claude.provider === 'claude' && claude.localInsights, true);
  assert.equal('localInsights' in result, false);
});

test('normalizeSettings: account nel formato ad array completati, voci non valide scartate', () => {
  const result = normalizeSettings({
    accounts: [
      { id: 'claude-1', provider: 'claude', label: 'Mio', session: { sessionKey: 'sk' } },
      { id: 'x', provider: 'openai' },
      { provider: 'copilot' },
      'rotto',
    ],
  }, DEFAULTS);
  assert.equal(result.accounts.length, 1);
  const claude = at(result.accounts, 0);
  assert.equal(claude.label, 'Mio');
  if (claude.provider !== 'claude') return assert.fail('atteso un account claude');
  assert.equal(claude.session.sessionKey, 'sk');
  assert.equal(claude.session.organizationId, null);
  assert.equal(claude.partition, 'persist:account-claude-1');
});

test('normalizeSettings: idempotente', () => {
  const once = normalizeSettings({ ui: { alwaysOnTop: true } }, DEFAULTS);
  assert.deepEqual(normalizeSettings(once, DEFAULTS), once);
});
