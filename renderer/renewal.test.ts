// renderer/renewal.test.ts — renewal day read from the provider vs entered by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renewalFromProvider } from './renewal.js';
import type { QuotaWindow } from './types.js';

function win(overrides: Partial<QuotaWindow>): QuotaWindow {
  return { id: 'w', label: 'W', periodType: 'billing-cycle', periodLength: 1, unit: 'percentage', used: 10, total: null, resetsAt: null, ...overrides };
}

test('no data yet → the manual renewal day is needed', () => {
  assert.deepEqual(renewalFromProvider(null), { needsManual: true, next: null });
  assert.deepEqual(renewalFromProvider({ subscriptionRenewsAt: null, quotaWindows: [] }), { needsManual: true, next: null });
});

test('every paced window has its reset (Claude 5h/7d, Copilot) → read from the provider, earliest first', () => {
  const result = renewalFromProvider({
    subscriptionRenewsAt: null,
    quotaWindows: [
      win({ id: 'five_hour', periodType: 'rolling-hours', periodLength: 5, resetsAt: '2026-10-01T20:00:00Z' }),
      win({ id: 'seven_day', periodType: 'rolling-days', periodLength: 7, resetsAt: '2026-10-05T08:00:00Z' }),
    ],
  });
  assert.deepEqual(result, { needsManual: false, next: '2026-10-01T20:00:00Z' });
});

test("the provider's renewal date covers windows without their own reset", () => {
  const result = renewalFromProvider({ subscriptionRenewsAt: '2026-11-01T00:00:00Z', quotaWindows: [win({ resetsAt: null })] });
  assert.deepEqual(result, { needsManual: false, next: '2026-11-01T00:00:00Z' });
});

test('Claude spend limit (no date anywhere) → manual', () => {
  const result = renewalFromProvider({ subscriptionRenewsAt: null, quotaWindows: [win({ id: 'spend', resetsAt: null })] });
  assert.equal(result.needsManual, true);
});

test('an unpaced window alone (billing cycle of unknown length) needs no date', () => {
  const result = renewalFromProvider({
    subscriptionRenewsAt: null,
    quotaWindows: [win({ periodLength: null }), win({ id: 'five_hour', periodType: 'rolling-hours', periodLength: 5, resetsAt: '2026-10-01T20:00:00Z' })],
  });
  assert.deepEqual(result, { needsManual: false, next: '2026-10-01T20:00:00Z' });
});
