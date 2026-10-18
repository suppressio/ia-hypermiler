// Synthetic fixtures only; HTTP calls never reach the network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as codex from './codex';
import { FormatDriftError } from './_shape';
import { at } from '../tests/support/at';

const primary = {
  used_percent: 23,
  limit_window_seconds: 18000,
  reset_at: 1900000000
};
const weekly = {
  used_percent: 61,
  limit_window_seconds: 604800,
  reset_at: 1900500000
};
const normal = {
  plan_type: 'synthetic-plan',
  rate_limit: {
    primary_window: primary,
    secondary_window: weekly
  }
};
const credentials = {
  cookieHeader: 'synthetic=cookie',
  userAgent: 'SyntheticBrowser/1'
};
const token = 'synthetic-private-bearer';
const originalFetch = globalThis.fetch;
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status
});
afterEach(() => { globalThis.fetch = originalFetch; });

function install(usage: unknown = normal, session: unknown = {
  accessToken: token
}): void {
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return json(url.endsWith('/api/auth/session') ? session : usage);
  };
}

test('maps two independent windows, plan and renewal without exposing the session', async () => {
  install();
  const result = await codex.fetchUsage(credentials);
  assert.equal(result.planTier, 'synthetic-plan');
  assert.equal(result.subscriptionRenewsAt, null);
  assert.deepEqual(result.quotaWindows, [
    {
      id: 'codex-5h',
      label: '5-hour limit',
      periodType: 'rolling-hours',
      periodLength: 5,
      unit: 'percentage',
      used: 23,
      total: 100,
      resetsAt: new Date(1900000000000)
    },
    {
      id: 'codex-7d',
      label: '7-day limit',
      periodType: 'rolling-days',
      periodLength: 7,
      unit: 'percentage',
      used: 61,
      total: 100,
      resetsAt: new Date(1900500000000)
    },
  ]);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('weekly-only primary retains the duration-derived identity', () => {
  assert.deepEqual(codex.buildQuotaWindows({
    rate_limit: {
      primary_window: weekly,
      secondary_window: null
    }
  }), [at(codex.buildQuotaWindows(normal), 1)]);
});

test('missing or invalid absolute reset falls back to relative seconds or null', () => {
  for (const reset_at of [undefined, null, 'invalid', 0, -1, NaN, Infinity, 1e20]) {
    const window = {
      ...primary,
      reset_at,
      reset_after_seconds: 120
    };
    assert.equal(new Date(at(codex.buildQuotaWindows({
      rate_limit: {
        primary_window: window
      }
    }, 1000), 0).resetsAt ?? 0).getTime(), 121000);
    assert.equal(at(codex.buildQuotaWindows({
      rate_limit: {
        primary_window: {
          ...window,
          reset_after_seconds: null
        }
      }
    }), 0).resetsAt, null);
  }
});

for (const credits of [{
  balance: '37.25'
}, {
  balance: {}
}, 'odd', null]) {
  test('ignores credits regardless of their shape', () => {
    assert.deepEqual(codex.buildQuotaWindows({
      ...normal,
      credits
    }), codex.buildQuotaWindows(normal));
  });
}

test('additional and code-review windows never collide or sum percentages', () => {
  for (const additional_rate_limits of [[{
    rate_limit: {
      primary_window: primary
    }
  }, weekly], {
    model_a: {
      rate_limit: {
        primary_window: primary
      }
    },
    model_b: weekly
  }]) {
    const windows = codex.buildQuotaWindows({
      ...normal,
      additional_rate_limits,
      code_review_rate_limit: {
        primary_window: primary
      }
    });
    assert.equal(windows.length, 5);
    assert.equal(new Set(windows.map((window) => window.id)).size, 5);
    assert.deepEqual(windows.map((window) => window.used), [23, 61, 23, 23, 61]);
  }
  const entries = {
    a: primary,
    b: weekly
  };
  assert.deepEqual(codex.buildQuotaWindows({
    ...normal,
    additional_rate_limits: entries
  }), codex.buildQuotaWindows({
    ...normal,
    additional_rate_limits: {
      b: weekly,
      a: primary
    }
  }));
});

for (const additional_rate_limits of [null, 'odd', 42, [null, {}, {
  rate_limit: {
    primary_window: 'odd'
  }
}], {
    strange: true
  }]) {
  test('unknown optional shapes do not break the main quotas', () => {
    assert.deepEqual(codex.buildQuotaWindows({
      ...normal,
      additional_rate_limits,
      code_review_rate_limit: 'odd'
    }), codex.buildQuotaWindows(normal));
  });
}

for (const response of [null, {}, {
  rate_limit: []
}, {
    rate_limit: {}
  }, {
    rate_limit: {
      primary_window: {
        ...primary,
        used_percent: 'private-percent'
      }
    },
    email: 'synthetic-private-email'
  }]) {
  test('unknown usage throws structure-only format drift', () => {
    assert.throws(() => codex.buildQuotaWindows(response), (error: unknown) => {
      assert.ok(error instanceof FormatDriftError);
      assert.equal(error.endpointLabel, codex.USAGE_ENDPOINT_LABEL);
      assert.ok(!JSON.stringify(error).includes('synthetic-private-email'));
      assert.ok(!JSON.stringify(error).includes('private-percent'));
      return true;
    });
  });
}

for (const session of [{}, null, {
  accessToken: 42
}, {
  accessToken: ''
}]) {
  test('missing access token asks for sign-in without a drift report', async () => {
    install(normal, session);
    await assert.rejects(codex.fetchUsage(credentials), codex.CodexSignInRequiredError);
  });
}

test('sends cookies and partition UA to session, Bearer only to usage; raw return is usage only', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('User-Agent'), credentials.userAgent);
    assert.equal(headers.get('Accept'), 'application/json');
    if (url.endsWith('/api/auth/session')) {
      assert.equal(headers.get('Cookie'), credentials.cookieHeader);
      assert.equal(headers.get('Authorization'), null);
      return json({
        accessToken: token,
        user: {
          email: 'synthetic-private-email'
        },
        sessionToken: 'private-session'
      });
    }
    assert.equal(headers.get('Authorization'), `Bearer ${token}`);
    assert.equal(headers.get('Cookie'), null);
    return json(normal);
  };
  assert.deepEqual(await codex.fetchUsageResponse(credentials), normal);
  assert.deepEqual(calls, ['https://chatgpt.com/api/auth/session', `https://${codex.USAGE_ENDPOINT_LABEL}`]);
});

for (const endpoint of ['session', 'usage']) {
  const label = endpoint === 'session'
    ? 'chatgpt.com/api/auth/session' : codex.USAGE_ENDPOINT_LABEL;
  for (const failure of [401, 403, 429, 503, 'json', 'network', 'timeout']) {
    test(`${endpoint} ${failure} preserves error category without secrets or causes`, async () => {
      globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (endpoint === 'usage' && url.endsWith('/api/auth/session')) {
          return json({
            accessToken: token
          });
        }
        if (typeof failure === 'number') {
          return json({
            accessToken: token,
            sessionToken: 'private-session'
          }, failure);
        }
        if (failure === 'json') return new Response(token);
        if (failure === 'timeout') throw new DOMException('Request aborted', 'AbortError');
        throw new Error('Connection refused');
      };
      await assert.rejects(codex.fetchUsageResponse(credentials), (error: unknown) => {
        assert.ok(error instanceof Error);
        if (failure === 401 || failure === 403) {
          assert.ok(error instanceof codex.CodexSignInRequiredError);
        } else {
          assert.ok(!(error instanceof codex.CodexSignInRequiredError));
          const expected = typeof failure === 'number' ? `${label} answered ${failure}`
            : failure === 'timeout' ? `Timeout (10000ms) calling ${label}`
              : failure === 'network' ? `Network error calling ${label}: Connection refused`
                : `Invalid JSON response from ${label}`;
          assert.equal(error.message, expected);
        }
        assert.ok(!error.message.includes(token));
        assert.ok(!error.message.includes('private-session'));
        assert.equal(error.cause, undefined);
        return true;
      });
    });
  }
}

test('redacts an echoed Bearer in a usage transport error', async () => {
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/auth/session')) return json({
      accessToken: token
    });
    throw new Error(`Connection failed with Bearer ${token}`);
  };
  await assert.rejects(codex.fetchUsageResponse(credentials), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message,
      `Network error calling ${codex.USAGE_ENDPOINT_LABEL}: Connection failed with Bearer [redacted]`);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('retains exhausted and overshooting quotas without clamping', () => {
  for (const used_percent of [100, 123.5, 1000]) {
    const windows = codex.buildQuotaWindows({
      rate_limit: {
        primary_window: {
          ...primary,
          used_percent
        }
      }
    });
    assert.equal(windows.length, 1);
    assert.equal(at(windows, 0).used, used_percent);
    assert.equal(at(windows, 0).total, 100);
  }
});

test('requires cookie and partition User-Agent without fallback defaults', async () => {
  for (const missing of [{
    ...credentials,
    cookieHeader: ''
  }, {
    ...credentials,
    userAgent: ''
  }]) {
    await assert.rejects(codex.fetchUsage(missing), /missing cookie header or partition User-Agent/);
  }
});

test('optional map keys with lone surrogates do not cause mapping failures', () => {
  const windows = codex.buildQuotaWindows({
    ...normal,
    additional_rate_limits: {
      '\ud800': primary
    }
  });
  assert.equal(windows.length, 3);
  assert.equal(new Set(windows.map((window) => window.id)).size, 3);
});
