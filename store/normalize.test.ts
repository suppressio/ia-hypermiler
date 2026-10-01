// store/normalize.test.ts — normalization of the store on disk (store/normalize.ts):
// missing fields, wrong types, legacy account schema. No electron-store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from './normalize';
import { mergeWithDefaults } from './merge';
import { DEFAULT_WORK_SCHEDULE, DEFAULTS } from './defaults';
import { at } from '../tests/support/at';

test('mergeWithDefaults: deep merge, wrong types replaced, extra keys kept', () => {
  const defaults = { a: 1, nested: { flag: true, list: [] as number[] }, nullable: null as string | null };
  const raw = { a: 'uno', nested: { list: [3] }, nullable: 'x', extra: 42 };
  assert.deepEqual(mergeWithDefaults(defaults, raw), { a: 1, nested: { flag: true, list: [3] }, nullable: 'x', extra: 42 });
});

test('mergeWithDefaults: non-object value in place of an object → default', () => {
  assert.deepEqual(mergeWithDefaults({ x: { y: 1 } }, { x: 'rotto' }), { x: { y: 1 } });
  assert.deepEqual(mergeWithDefaults([1], 'non un array'), [1]);
});

test('normalizeSettings: empty or invalid store → the defaults', () => {
  assert.deepEqual(normalizeSettings(undefined, DEFAULTS), DEFAULTS);
  assert.deepEqual(normalizeSettings('corrotto', DEFAULTS), DEFAULTS);
});

test('normalizeSettings: fields added after the first release appear on an old store (shallow-merge bug)', () => {
  // Real shape of a 0.1.x store: history without recentSamples, workSchedule without
  // enabled, no updates section.
  const legacy = {
    history: { dailyUsage: [{ date: '2026-09-01', accountId: 'claude', windowId: 'w', used: 10 }], retentionDays: 90 },
    workSchedule: { days: DEFAULT_WORK_SCHEDULE.days, hoursPerDay: 6 },
    ui: { windowStyle: 'filled-dark' },
  };
  const result = normalizeSettings(legacy, DEFAULTS);
  assert.deepEqual(result.history.recentSamples, []);
  assert.equal(result.history.dailyUsage.length, 1);
  assert.equal(result.ui.windowStyle, 'filled-dark');
  assert.equal(result.ui.notificationThresholdPercent, 80);
  assert.deepEqual(result.updates, DEFAULTS.updates);
});

test('normalizeSettings: history.lastGood (not in defaults) is kept', () => {
  const lastGood = { claude: { planTier: null, subscriptionRenewsAt: null, quotaWindows: [], accountId: 'claude', lastUpdatedAt: 'x' } };
  const result = normalizeSettings({ history: { lastGood } }, DEFAULTS);
  assert.deepEqual(result.history.lastGood, lastGood);
});

test('normalizeSettings: legacy account schema migrated and old localInsights flag removed', () => {
  const result = normalizeSettings({
    accounts: { claude: { enabled: true, session: { sessionKey: 'sk' } } },
    localInsights: { claudeCode: { enabled: true } },
  }, DEFAULTS);
  const claude = at(result.accounts, 0);
  assert.equal(claude.provider === 'claude' && claude.localInsights, true);
  assert.equal('localInsights' in result, false);
});

test('normalizeSettings: accounts in array form completed, invalid entries dropped', () => {
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
  if (claude.provider !== 'claude') return assert.fail('expected a claude account');
  assert.equal(claude.session.sessionKey, 'sk');
  assert.equal(claude.session.organizationId, null);
  assert.equal(claude.partition, 'persist:account-claude-1');
});

test('normalizeSettings: idempotent', () => {
  const once = normalizeSettings({ ui: { alwaysOnTop: true } }, DEFAULTS);
  assert.deepEqual(normalizeSettings(once, DEFAULTS), once);
});

// --- Work schedule per account (it used to be one global setting) ---

const LEGACY_SCHEDULE = {
  enabled: true,
  days: { mon: 'full', tue: 'full', wed: 'half', thu: 'full', fri: 'off', sat: 'off', sun: 'off' },
  hoursPerDay: 6,
};

test('normalizeSettings: the global work schedule moves into every account and the global key disappears', () => {
  const result = normalizeSettings({
    workSchedule: LEGACY_SCHEDULE,
    accounts: [
      { id: 'a', provider: 'claude', label: 'Work' },
      { id: 'b', provider: 'copilot', label: 'Personal' },
    ],
  }, DEFAULTS);
  assert.equal('workSchedule' in result, false);
  assert.deepEqual(at(result.accounts, 0).workSchedule, LEGACY_SCHEDULE);
  assert.deepEqual(at(result.accounts, 1).workSchedule, LEGACY_SCHEDULE);
});

test('normalizeSettings: an account schedule wins over the legacy global one', () => {
  const own = { ...LEGACY_SCHEDULE, enabled: false };
  const result = normalizeSettings({
    workSchedule: LEGACY_SCHEDULE,
    accounts: [{ id: 'a', provider: 'claude', workSchedule: own }],
  }, DEFAULTS);
  assert.deepEqual(at(result.accounts, 0).workSchedule, own);
});

test('normalizeSettings: the legacy two-slot schema carries the global schedule too', () => {
  const result = normalizeSettings({
    workSchedule: LEGACY_SCHEDULE,
    accounts: { claude: { enabled: true, session: { sessionKey: 'sk' } } },
  }, DEFAULTS);
  assert.deepEqual(at(result.accounts, 0).workSchedule, LEGACY_SCHEDULE);
});

test('normalizeSettings: missing or invalid schedule fields are completed per account', () => {
  const result = normalizeSettings({
    accounts: [{ id: 'a', provider: 'claude', workSchedule: { enabled: 'yes', days: { mon: 'half', tue: 'never' } } }],
  }, DEFAULTS);
  const schedule = at(result.accounts, 0).workSchedule;
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.days.mon, 'half');
  assert.equal(schedule.days.tue, 'full');
  assert.equal(schedule.days.sat, 'off');
  assert.equal(schedule.hoursPerDay, 8);
});

test('normalizeSettings: accounts do not share the same schedule object', () => {
  const result = normalizeSettings({
    accounts: [{ id: 'a', provider: 'claude' }, { id: 'b', provider: 'claude' }],
  }, DEFAULTS);
  at(result.accounts, 0).workSchedule.days.mon = 'off';
  assert.equal(at(result.accounts, 1).workSchedule.days.mon, 'full');
  assert.equal(DEFAULT_WORK_SCHEDULE.days.mon, 'full');
});
