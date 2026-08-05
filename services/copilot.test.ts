// services/copilot.test.ts — test unitari per services/copilot.ts con fetch mockato.
// Nessuna chiamata di rete reale. I test di integrazione sono in
// tests/integration/copilot.integration.test.ts.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as copilotService from './copilot';

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

test('resolveUsername legge login dalla risposta /user', async () => {
  installFetchMock(async () => jsonResponse({ login: 'testuser' }));
  const username = await copilotService.resolveUsername('tok-123');
  assert.equal(username, 'testuser');
});

test('resolveUsername lancia errore esplicito senza token', async () => {
  await assert.rejects(() => copilotService.resolveUsername(''), /token mancante/);
});

test('resolveUsername lancia errore se manca login nella risposta', async () => {
  installFetchMock(async () => jsonResponse({}));
  await assert.rejects(() => copilotService.resolveUsername('tok-123'), /impossibile determinare lo username/);
});

test('sumCreditsUsed somma il netAmount di tutti gli usage item e lo converte in credit', () => {
  const report = {
    usageItems: [
      { netAmount: 0.1 },
      { netAmount: 0.05 },
    ],
  };
  assert.equal(copilotService.sumCreditsUsed(report), 15); // (0.10 + 0.05) USD / $0.01 = 15 credit
});

test('sumCreditsUsed lancia errore esplicito se usageItems manca', () => {
  assert.throws(() => copilotService.sumCreditsUsed({}), /formato risposta inatteso/);
});

test('fetchUsage (personale) somma il report in credit e applica manualQuota come total', async () => {
  installFetchMock(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    return jsonResponse({ usageItems: [{ netAmount: 0.42 }] });
  });

  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'personal', manualQuota: 300 });

  assert.equal(result.quotaWindows.length, 1);
  assert.equal(result.quotaWindows[0].id, 'ai_credits');
  assert.equal(result.quotaWindows[0].used, 42);
  assert.equal(result.quotaWindows[0].total, 300);
});

test('fetchUsage (personale) ripiega su premium_request/usage se ai_credit/usage risponde 404', async () => {
  installFetchMock(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    if (url.includes('ai_credit/usage')) return jsonResponse({ message: 'Not Found' }, 404);
    if (url.includes('premium_request/usage')) return jsonResponse({ usageItems: [{ netAmount: 0.3 }] });
    throw new Error(`URL inatteso nel test: ${url}`);
  });

  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'personal' });

  assert.equal(result.quotaWindows[0].used, 30);
});

test('fetchUsage (personale) ripiega su copilot_internal/user se anche premium_request/usage risponde 404', async () => {
  installFetchMock(async (url) => {
    // copilot_internal/user termina anch'esso per "/user": va controllato prima
    // del check generico usato per risolvere lo username (api.github.com/user).
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
  assert.equal(result.quotaWindows[0].used, 20); // 100 - 80
});

test('fetchUsage (personale) non ripiega su premium_request/usage per errori diversi da 404', async () => {
  installFetchMock(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'testuser' });
    return jsonResponse({ message: 'Bad credentials' }, 401);
  });

  await assert.rejects(
    () => copilotService.fetchUsage({ token: 'tok-invalido', accountScope: 'personal' }),
    /ha risposto 401/,
  );
});

test('fetchUsage (seat aziendale) converte quota_snapshots in finestre percentuali', async () => {
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

test('fetchUsage (seat aziendale) segnala esplicitamente il fallimento come best-effort', async () => {
  installFetchMock(async () => jsonResponse({ message: 'Bad credentials' }, 401));
  await assert.rejects(
    () => copilotService.fetchUsage({ token: 'tok-invalido', accountScope: 'organization' }),
    /best-effort/,
  );
});

test('fetchUsage lancia errore esplicito senza token', async () => {
  await assert.rejects(() => copilotService.fetchUsage({ token: '' }), /token mancante/);
});

test('fetchOrgManagedUsage lancia FormatDriftError con la shape (mai i valori) se manca quota_snapshots', async () => {
  installFetchMock(async () => jsonResponse({ copilot_plan: 'business', cinder_cove: { used_dollars: 42 } }));
  try {
    await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'organization' });
    assert.fail('doveva lanciare');
  } catch (err) {
    assert.equal((err as Error).name, 'FormatDriftError');
    assert.ok(!JSON.stringify((err as any).shape).includes('42'));
  }
});
