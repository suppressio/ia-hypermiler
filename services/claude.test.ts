// services/claude.test.ts — unit tests for services/claude.ts with a mocked fetch.
// No real network call: only parsing, mapping and error handling are checked.
// Integration tests with a real account are in tests/integration/claude.integration.test.ts.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeService from './claude';
import { at } from '../tests/support/at';
import { FormatDriftError } from './_shape';

type FetchMock = (input: string, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

function installFetchMock(impl: FetchMock): void {
  globalThis.fetch = impl as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('listOrganizations maps uuid/name from the response', async () => {
  installFetchMock(async () => jsonResponse([{ uuid: 'org-1', name: 'Acme Inc' }, { id: 'org-2' }]));
  const orgs = await claudeService.listOrganizations('sess-abc');
  assert.deepEqual(orgs, [{ id: 'org-1', name: 'Acme Inc' }, { id: 'org-2', name: 'Organization' }]);
});

test('listOrganizations throws an explicit error without sessionKey', async () => {
  await assert.rejects(() => claudeService.listOrganizations(''), /missing sessionKey/);
});

test('listOrganizations throws on a non-array response', async () => {
  installFetchMock(async () => jsonResponse({ unexpected: true }));
  await assert.rejects(() => claudeService.listOrganizations('sess-abc'), /unrecognized format/);
});

test('buildQuotaWindows converts only present and valid windows', () => {
  const windows = claudeService.buildQuotaWindows({
    five_hour: { utilization: 34, resets_at: '2026-07-20T10:00:00Z' },
    seven_day: { utilization: 58, resets_at: '2026-07-23T00:00:00Z' },
    // seven_day_opus missing on purpose: it must not appear in the output
  });
  assert.equal(windows.length, 2);
  assert.equal(at(windows, 0).id, 'five_hour');
  assert.equal(at(windows, 0).used, 34);
  assert.equal(at(windows, 0).unit, 'percentage');
  assert.equal(at(windows, 1).id, 'seven_day');
});

test('buildQuotaWindows throws an explicit error when no window is recognized', () => {
  assert.throws(() => claudeService.buildQuotaWindows({}), /no quota window recognized/);
});

test('buildQuotaWindows throws a FormatDriftError with the shape (never the values) when nothing is recognized', () => {
  try {
    // Deliberately off-schema shape: the cast goes through unknown, no `any`.
    const unrecognized = { cinder_cove: { some_unrelated_field: 389.19 } } as unknown as Parameters<typeof claudeService.buildQuotaWindows>[0];
    claudeService.buildQuotaWindows(unrecognized);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof FormatDriftError);
    const shape = err.shape;
    assert.ok(!JSON.stringify(shape).includes('389.19'));
  }
});

test('buildQuotaWindows recognizes a window whatever the key name, as long as utilization is numeric', () => {
  // Field names are not stable (see CLAUDE.md, real case observed in 2026-07):
  // "cinder_cove" is not a documented name, but it must still be recognized as a valid
  // window because it has the right shape (numeric utilization).
  const windows = claudeService.buildQuotaWindows({ cinder_cove: { utilization: 38.9, resets_at: '2026-09-13T00:00:00Z' } });
  assert.equal(windows.length, 1);
  assert.equal(at(windows, 0).id, 'cinder_cove');
  assert.equal(at(windows, 0).used, 38.9);
  assert.equal(at(windows, 0).unit, 'percentage');
});

test('buildQuotaWindows treats windows with limit_dollars/used_dollars as "count" with real amounts', () => {
  const windows = claudeService.buildQuotaWindows({
    cinder_cove: {
      utilization: 39.5166701,
      resets_at: '2026-09-13T14:38:47.361625+00:00',
      limit_dollars: 1000,
      used_dollars: 395.166701,
      remaining_dollars: 604.83,
    },
  });
  assert.equal(windows.length, 1);
  assert.equal(at(windows, 0).unit, 'count');
  assert.equal(at(windows, 0).used, 395.166701);
  assert.equal(at(windows, 0).total, 1000);
});

test('buildQuotaWindows drops 0% windows without reset and amounts (not applicable to the plan)', () => {
  const windows = claudeService.buildQuotaWindows({
    omelette_promotional: { utilization: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null },
  });
  assert.equal(windows.length, 0);
});

test('buildQuotaWindows: real case — payload with obfuscated field names (2026-07) is parsed correctly', () => {
  // Real payload received from a connected account, with the old names (five_hour,
  // seven_day, ...) all null and new/arbitrary names in their place — see the CLAUDE.md
  // progress log and the RESEARCH.md addendum.
  const windows = claudeService.buildQuotaWindows({
    five_hour: null,
    seven_day: null,
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    seven_day_omelette: null,
    tangelo: null,
    iguana_necktie: null,
    omelette_promotional: { utilization: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null },
    nimbus_quill: null,
    cinder_cove: {
      utilization: 39.5166701,
      resets_at: '2026-09-13T14:38:47.361625+00:00',
      limit_dollars: 1000,
      used_dollars: 395.166701,
      remaining_dollars: 604.83,
    },
  });
  assert.equal(windows.length, 1); // only cinder_cove: the others are null or filtered out as not applicable
  assert.equal(at(windows, 0).id, 'cinder_cove');
  assert.equal(at(windows, 0).unit, 'count');
  assert.equal(at(windows, 0).used, 395.166701);
  assert.equal(at(windows, 0).total, 1000);
});

// Shape of a company (Team/Enterprise seat) account seen on 2026-10-01 (issue #6):
// every window null, extra_usage.utilization null, the data moved to a new `spend`
// object with minor-unit amounts. Values here are invented.
function companySpendPayload(spend: Record<string, unknown>): Record<string, unknown> {
  return {
    five_hour: null,
    seven_day: null,
    cinder_cove: null,
    limits: [],
    member_dashboard_available: true,
    extra_usage: {
      credits_ever_enabled: true,
      currency: 'USD',
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 1234,
      utilization: null,
    },
    spend,
  };
}

test('buildQuotaWindows: real case — company account with only `spend` (2026-10, issue #6)', () => {
  const windows = claudeService.buildQuotaWindows(companySpendPayload({
    enabled: true,
    percent: 24.68,
    severity: 'normal',
    used: { amount_minor: 1234, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
    cap: { credits: { amount_minor: 5000, exponent: 2 }, money: null },
  }));
  assert.equal(windows.length, 1);
  assert.equal(at(windows, 0).id, 'spend');
  assert.equal(at(windows, 0).unit, 'count');
  assert.equal(at(windows, 0).used, 12.34);
  assert.equal(at(windows, 0).total, 50);
  assert.equal(at(windows, 0).periodType, 'billing-cycle');
  assert.equal(at(windows, 0).periodLength, 1); // monthly: pacing on the renewal rule
  assert.equal(at(windows, 0).resetsAt, null);
});

test('buildQuotaWindows: `spend` without usable amounts falls back to its percent', () => {
  const windows = claudeService.buildQuotaWindows(companySpendPayload({
    enabled: true,
    percent: 24.68,
    used: null,
    limit: null,
  }));
  assert.equal(windows.length, 1);
  assert.equal(at(windows, 0).unit, 'percentage');
  assert.equal(at(windows, 0).used, 24.68);
  assert.equal(at(windows, 0).total, null);
});

test('buildQuotaWindows: disabled `spend` is a recognized shape with no window, not a format drift', () => {
  const windows = claudeService.buildQuotaWindows(companySpendPayload({
    enabled: false,
    percent: 0,
    used: { amount_minor: 0, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
  }));
  assert.equal(windows.length, 0);
});

test('buildQuotaWindows: `spend` is not added when a dollar window already reports the extra credit', () => {
  const windows = claudeService.buildQuotaWindows({
    cinder_cove: { utilization: 39.5, resets_at: '2026-09-13T14:38:47Z', limit_dollars: 1000, used_dollars: 395 },
    spend: {
      enabled: true,
      percent: 39.5,
      used: { amount_minor: 39500, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 100000, currency: 'USD', exponent: 2 },
    },
  });
  assert.equal(windows.length, 1);
  assert.equal(at(windows, 0).id, 'cinder_cove');
});

// Shape seen on 2026-10-02 on a company account (RESEARCH.md §1 addendum 4):
// extra_usage now carries utilization and the monthly budget in minor units, the same
// money as `spend`. Values here are invented.
function companyExtraUsagePayload(spendUsedMinor: number): Record<string, unknown> {
  return {
    five_hour: null,
    seven_day: null,
    limits: [],
    extra_usage: {
      credits_ever_enabled: true, currency: 'USD', daily: null, decimal_places: 2, disabled_reason: null,
      is_enabled: true, monthly_limit: 20000, spend_limit_reached: false, used_credits: 2345,
      user_disabled: false, utilization: 11.725, weekly: null,
    },
    spend: {
      enabled: true, percent: 12, severity: 'normal',
      used: { amount_minor: spendUsedMinor, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 20000, currency: 'USD', exponent: 2 },
    },
  };
}

test('buildQuotaWindows: extra_usage with a monthly budget in minor units is a paced dollar window', () => {
  const { spend: _spend, ...withoutSpend } = companyExtraUsagePayload(2345);
  const windows = claudeService.buildQuotaWindows(withoutSpend);
  assert.equal(windows.length, 1);
  assert.deepEqual(at(windows, 0), {
    id: 'extra_usage', label: 'Extra usage (monthly)', periodType: 'billing-cycle', periodLength: 1,
    unit: 'count', used: 23.45, total: 200, resetsAt: null,
  });
});

test('buildQuotaWindows: extra_usage and spend with the same amounts → only spend (keeps its history)', () => {
  const windows = claudeService.buildQuotaWindows(companyExtraUsagePayload(2345));
  assert.deepEqual(windows.map((w) => w.id), ['spend']);
});

test('buildQuotaWindows: extra_usage and spend that differ are both shown', () => {
  const windows = claudeService.buildQuotaWindows(companyExtraUsagePayload(9000));
  assert.deepEqual(windows.map((w) => w.id).sort(), ['extra_usage', 'spend']);
});

test('buildQuotaWindows: `limits` is a fallback only when no named window is recognized', () => {
  const limits = [
    { group: 'xxxxxxx', is_active: true, kind: 'session', percent: 30, resets_at: '2026-07-13T12:00:00Z', scope: null, severity: 'normal' },
    { group: 'yyyyyy', is_active: false, kind: 'weekly_all', percent: 20, resets_at: '2026-07-18T21:00:00Z', scope: null, severity: 'normal' },
    { kind: 'future_kind', percent: 5, resets_at: null },
  ];
  // Named windows present: limits ignored (same data twice).
  const named = claudeService.buildQuotaWindows({ five_hour: { utilization: 30, resets_at: '2026-07-13T12:00:00Z' }, limits });
  assert.deepEqual(named.map((w) => w.id), ['five_hour']);
  // Named windows gone: read from limits, with the same ids (history continues).
  const fallback = claudeService.buildQuotaWindows({ five_hour: null, seven_day: null, limits });
  assert.deepEqual(fallback.map((w) => [w.id, w.periodType, w.periodLength, w.used]), [
    ['five_hour', 'rolling-hours', 5, 30],
    ['seven_day', 'rolling-days', 7, 20],
    ['limit_future_kind', 'billing-cycle', null, 5],
  ]);
});

test('buildQuotaWindows: `spend` with an unexpected shape is still a format drift', () => {
  assert.throws(
    () => claudeService.buildQuotaWindows(companySpendPayload({ enabled: true, something_else: 1 })),
    FormatDriftError,
  );
});

test('buildQuotaWindows: Free tier (member_dashboard_available=false, all nulls) returns empty array, not a format drift', () => {
  // Real shape received on 2026-10-09 after a Pro subscription expired (issue #44).
  // All window fields are null, limits is empty, member_dashboard_available is false.
  const windows = claudeService.buildQuotaWindows({
    amber_cistern: null, amber_gauge: null, cedar_ember: null, cinder_cove: null,
    copper_kite: null, extra_usage: null, five_hour: null, harbor_lantern: null,
    iguana_necktie: null, juniper_tide: null, nimbus_quill: null, omelette_promotional: null,
    seven_day: null, seven_day_breakdown: null, seven_day_cowork: null,
    seven_day_oauth_apps: null, seven_day_omelette: null, seven_day_opus: null,
    seven_day_sonnet: null, spend: null, tangelo: null, wattle_ember: null,
    weekly_scoped_shares: null,
    limits: [],
    member_dashboard_available: false,
  });
  assert.equal(windows.length, 0);
});

test('buildQuotaWindows: Free tier with member_dashboard_available=true still drifts when no window recognized', () => {
  // Only false is the known "no dashboard" signal; true with no windows is still a drift.
  assert.throws(
    () => claudeService.buildQuotaWindows({ limits: [], member_dashboard_available: true }),
    FormatDriftError,
  );
});


test('fetchUsage uses the given organizationId without calling /organizations', async () => {
  const calledUrls: string[] = [];
  installFetchMock(async (url) => {
    calledUrls.push(url);
    return jsonResponse({ seven_day: { utilization: 61, resets_at: '2026-07-25T00:00:00Z' } });
  });

  const result = await claudeService.fetchUsage({ sessionKey: 'sess-abc', organizationId: 'org-xyz' });

  assert.equal(calledUrls.length, 1);
  assert.match(at(calledUrls, 0), /organizations\/org-xyz\/usage/);
  assert.equal(at(result.quotaWindows, 0).used, 61);
  assert.equal(result.subscriptionRenewsAt, null);
});

test('fetchUsage resolves organizationId when missing, then calls /usage', async () => {
  const calledUrls: string[] = [];
  installFetchMock(async (url) => {
    calledUrls.push(url);
    if (url.endsWith('/organizations')) return jsonResponse([{ uuid: 'org-auto', name: 'Solo' }]);
    return jsonResponse({ seven_day: { utilization: 12 } });
  });

  const result = await claudeService.fetchUsage({ sessionKey: 'sess-abc' });

  assert.equal(calledUrls.length, 2);
  assert.match(at(calledUrls, 1), /organizations\/org-auto\/usage/);
  assert.equal(at(result.quotaWindows, 0).used, 12);
});

test('fetchUsageResponse returns the raw response as received, uninterpreted', async () => {
  const raw = { extra_usage: { utilization: 33.3 }, spend: { percent: 33.3, enabled: true }, limits: [] };
  installFetchMock(async () => jsonResponse(raw));
  assert.deepEqual(await claudeService.fetchUsageResponse({ sessionKey: 'sess-abc', organizationId: 'org-xyz' }), raw);
  await assert.rejects(() => claudeService.fetchUsageResponse({ sessionKey: '' }), /missing sessionKey/);
});

test('fetchUsage throws an explicit error without sessionKey', async () => {
  await assert.rejects(() => claudeService.fetchUsage({ sessionKey: '' }), /missing sessionKey/);
});

test('fetchUsage propagates a readable error on a non-ok HTTP response', async () => {
  installFetchMock(async () => jsonResponse({ error: 'unauthorized' }, 401));
  await assert.rejects(
    () => claudeService.fetchUsage({ sessionKey: 'sess-abc', organizationId: 'org-xyz' }),
    /answered 401/,
  );
});
