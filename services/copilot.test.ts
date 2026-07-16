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
  installFetchMock(async () => jsonResponse({ login: 'ddelbrocco' }));
  const username = await copilotService.resolveUsername('tok-123');
  assert.equal(username, 'ddelbrocco');
});

test('resolveUsername lancia errore esplicito senza token', async () => {
  await assert.rejects(() => copilotService.resolveUsername(''), /token mancante/);
});

test('resolveUsername lancia errore se manca login nella risposta', async () => {
  installFetchMock(async () => jsonResponse({}));
  await assert.rejects(() => copilotService.resolveUsername('tok-123'), /impossibile determinare lo username/);
});

test('sumCurrentMonthUsage somma solo le quantità del mese corrente', () => {
  const now = new Date(Date.UTC(2026, 6, 16)); // 16 luglio 2026 UTC
  const report = {
    usageItems: [
      { date: '2026-07-01T00:00:00Z', quantity: 10 },
      { date: '2026-07-15T00:00:00Z', quantity: 5 },
      { date: '2026-06-30T00:00:00Z', quantity: 100 }, // mese precedente, escluso
    ],
  };
  assert.equal(copilotService.sumCurrentMonthUsage(report, now), 15);
});

test('sumCurrentMonthUsage lancia errore esplicito se usageItems manca', () => {
  assert.throws(() => copilotService.sumCurrentMonthUsage({}, new Date()), /formato risposta inatteso/);
});

test('fetchUsage (personale) somma il report e applica manualQuota come total', async () => {
  installFetchMock(async (url) => {
    if (url.endsWith('/user')) return jsonResponse({ login: 'ddelbrocco' });
    return jsonResponse({ usageItems: [{ date: new Date().toISOString(), quantity: 42 }] });
  });

  const result = await copilotService.fetchUsage({ token: 'tok-123', accountScope: 'personal', manualQuota: 300 });

  assert.equal(result.quotaWindows.length, 1);
  assert.equal(result.quotaWindows[0].id, 'premium_requests');
  assert.equal(result.quotaWindows[0].used, 42);
  assert.equal(result.quotaWindows[0].total, 300);
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
