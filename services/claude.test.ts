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
  assert.deepEqual(orgs, [{ id: 'org-1', name: 'Acme Inc' }, { id: 'org-2', name: 'Organizzazione' }]);
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
