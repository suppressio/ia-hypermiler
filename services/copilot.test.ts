// services/copilot.test.ts — unit tests for services/copilot.ts with a mocked fetch.
// No real network call. Integration tests are in
// tests/integration/copilot.integration.test.ts.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as copilotService from './copilot';
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

test('resolveUsername reads login from the /user response', async () => {
  installFetchMock(async () => jsonResponse({ login: 'testuser' }));
  const username = await copilotService.resolveUsername('tok-123');
  assert.equal(username, 'testuser');
});

test('resolveUsername throws an explicit error without token', async () => {
  await assert.rejects(() => copilotService.resolveUsername(''), /missing token/);
});

test('resolveUsername throws when login is missing from the response', async () => {
  installFetchMock(async () => jsonResponse({}));
  await assert.rejects(() => copilotService.resolveUsername('tok-123'), /could not determine the username/);
});

test('sumCreditsUsed sums the netAmount of every usage item and converts it to credits', () => {
  const report = {
    usageItems: [
      { netAmount: 0.1 },
      { netAmount: 0.05 },
    ],
  };
  assert.equal(copilotService.sumCreditsUsed(report), 15); // (0.10 + 0.05) USD / $0.01 = 15 credit
});

test('sumCreditsUsed throws an explicit error when usageItems is missing', () => {
  assert.throws(() => copilotService.sumCreditsUsed({}), /unexpected response format/);
});

test('fetchUsage (personal) sums the report in credits and applies manualQuota as total', async () => {
  installFetchMock(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    return jsonResponse({ usageItems: [{ netAmount: 0.42 }] });
  });

  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'personal', manualQuota: 300 });

  assert.equal(result.quotaWindows.length, 1);
  assert.equal(at(result.quotaWindows, 0).id, 'ai_credits');
  assert.equal(at(result.quotaWindows, 0).used, 42);
  assert.equal(at(result.quotaWindows, 0).total, 300);
});

test('fetchUsage (personal) falls back to premium_request/usage when ai_credit/usage answers 404', async () => {
  installFetchMock(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    if (url.includes('ai_credit/usage')) return jsonResponse({ message: 'Not Found' }, 404);
    if (url.includes('premium_request/usage')) return jsonResponse({ usageItems: [{ netAmount: 0.3 }] });
    throw new Error(`URL inatteso nel test: ${url}`);
  });

  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'personal' });

  assert.equal(at(result.quotaWindows, 0).used, 30);
});

test('fetchUsage (personal) falls back to copilot_internal/user when premium_request/usage also answers 404', async () => {
  installFetchMock(async (url) => {
    // copilot_internal/user also ends with "/user": it must be checked before the generic
    // check used to resolve the username (api.github.com/user).
    if (url.includes('copilot_internal/user')) {
      return jsonResponse({
        copilot_plan: 'individual',
        quota_reset_date: '2026-08-01T00:00:00Z',
        quota_snapshots: { premium_interactions: { percent_remaining: 80 } },
      });
    }
    if (url.includes('/settings/billing/')) return jsonResponse({ message: 'Not Found' }, 404);
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    throw new Error(`URL inatteso nel test: ${url}`);
  });

  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'personal' });

  assert.equal(result.planTier, 'individual');
  assert.equal(at(result.quotaWindows, 0).used, 20); // 100 - 80
});

test('fetchUsage (personal) does not fall back to premium_request/usage on errors other than 404', async () => {
  installFetchMock(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    return jsonResponse({ message: 'Bad credentials' }, 401);
  });

  await assert.rejects(
    () => copilotService.fetchUsage({ token: 'tok-invalido', accountScope: 'personal' }),
    /answered 401/,
  );
});

test('fetchUsage (company seat) converts quota_snapshots into percentage windows', async () => {
  installFetchMock(async () => jsonResponse({
    copilot_plan: 'business',
    quota_reset_date: '2026-08-01T00:00:00Z',
    quota_snapshots: {
      premium_interactions: { percent_remaining: 40 },
      chat: { percent_remaining: 90 },
    },
  }));

  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'organization' });

  assert.equal(result.planTier, 'business');
  assert.equal(result.quotaWindows.length, 2);
  const premium = result.quotaWindows.find((w) => w.id === 'premium_interactions');
  assert.equal(premium?.used, 60); // 100 - 40
});

test('fetchUsage (company seat) explicitly reports the failure as best-effort', async () => {
  installFetchMock(async () => jsonResponse({ message: 'Bad credentials' }, 401));
  await assert.rejects(
    () => copilotService.fetchUsage({ token: 'tok-invalido', accountScope: 'organization' }),
    /best-effort/,
  );
});

test('fetchUsage throws an explicit error without token', async () => {
  await assert.rejects(() => copilotService.fetchUsage({ token: '' }), /missing token/);
});

test('fetchOrgManagedUsage throws FormatDriftError with the shape (never the values) when quota_snapshots is missing', async () => {
  installFetchMock(async () => jsonResponse({ copilot_plan: 'business', cinder_cove: { used_dollars: 42 } }));
  try {
    await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'organization' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof FormatDriftError);
    assert.ok(!JSON.stringify(err.shape).includes('42'));
  }
});

// --- 2026-10-01: billing endpoints answer 400, token-based-billing snapshots, enterprise-managed seats (#7) ---

test('fetchUsage (personal) treats 400 "Unable to get billing usage data." like 404 and moves on', async () => {
  const calls: string[] = [];
  installFetchMock(async (url) => {
    calls.push(url);
    if (url.includes('copilot_internal/user')) {
      return jsonResponse({ copilot_plan: 'individual', quota_snapshots: { premium_interactions: { percent_remaining: 75 } } });
    }
    if (url.includes('/settings/billing/')) {
      return jsonResponse({ message: 'Unable to get billing usage data.', status: '400' }, 400);
    }
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    throw new Error(`Unexpected URL in test: ${url}`);
  });

  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'personal' });

  assert.ok(calls.some((u) => u.includes('premium_request/usage')));
  assert.equal(at(result.quotaWindows, 0).used, 25);
});

test('fetchUsage (personal) does not fall back on any other 400', async () => {
  installFetchMock(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    return jsonResponse({ message: 'Invalid month' }, 400);
  });
  await assert.rejects(
    () => copilotService.fetchUsage({ token: 'tok-123', accountScope: 'personal' }),
    /answered 400/,
  );
});

test('fetchUsage: unlimited snapshot with credits_used becomes a credits-used window without total', async () => {
  installFetchMock(async () => jsonResponse({
    copilot_plan: 'individual',
    token_based_billing: true,
    quota_snapshots: {
      premium_interactions: { unlimited: true, has_quota: true, percent_remaining: 100, credits_used: 321, entitlement: 0 },
    },
  }));
  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'organization' });
  assert.equal(result.quotaWindows.length, 1);
  const win = at(result.quotaWindows, 0);
  assert.equal(win.unit, 'count');
  assert.equal(win.used, 321);
  assert.equal(win.total, null);
});

test('fetchUsage: snapshot with an entitlement reports used = entitlement - quota_remaining', async () => {
  installFetchMock(async () => jsonResponse({
    copilot_plan: 'individual',
    quota_snapshots: {
      premium_interactions: {
        unlimited: false, percent_remaining: 70, entitlement: 1500, quota_remaining: 1050, credits_used: 450,
        quota_reset_at: 1793491200,
      },
    },
  }));
  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'organization' });
  const win = at(result.quotaWindows, 0);
  assert.equal(win.unit, 'count');
  assert.equal(win.used, 450);
  assert.equal(win.total, 1500);
  assert.equal(new Date(win.resetsAt ?? 0).getTime(), 1793491200 * 1000);
});

test('fetchUsage: snapshots with nothing to show (entitlement 0, unlimited without credits) are not a format drift', async () => {
  installFetchMock(async () => jsonResponse({
    copilot_plan: 'individual',
    quota_snapshots: {
      chat: { unlimited: true, has_quota: false, percent_remaining: 100, credits_used: 0 },
      completions: { unlimited: true, percent_remaining: 100 },
      premium_interactions: { unlimited: false, percent_remaining: 100, entitlement: 0 },
    },
  }));
  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'organization' });
  assert.equal(result.quotaWindows.length, 0);
});

test('fetchUsage: enterprise-managed seat without quota_snapshots throws CopilotUsageUnavailableError, not a format drift', async () => {
  installFetchMock(async () => jsonResponse({
    access_type_sku: 'enterprise_managed',
    copilot_plan: 'individual',
    chat_enabled: true,
    organization_list: [],
  }));
  await assert.rejects(
    () => copilotService.fetchUsage({ token: 'tok-123', accountScope: 'organization' }),
    (err: unknown) => err instanceof copilotService.CopilotUsageUnavailableError && !(err instanceof FormatDriftError),
  );
});
