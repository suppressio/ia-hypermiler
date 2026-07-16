// services/claude.test.ts — test unitari per services/claude.ts con fetch mockato.
// Nessuna chiamata di rete reale: verifichiamo solo parsing, mapping e gestione errori.
// I test di integrazione con un account reale sono in tests/integration/claude.integration.test.ts.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeService from './claude';

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

test('listOrganizations mappa uuid/name dalla risposta', async () => {
  installFetchMock(async () => jsonResponse([{ uuid: 'org-1', name: 'Acme Inc' }, { id: 'org-2' }]));
  const orgs = await claudeService.listOrganizations('sess-abc');
  assert.deepEqual(orgs, [{ id: 'org-1', name: 'Acme Inc' }, { id: 'org-2', name: 'Organizzazione' }]);
});

test('listOrganizations lancia errore esplicito senza sessionKey', async () => {
  await assert.rejects(() => claudeService.listOrganizations(''), /sessionKey mancante/);
});

test('listOrganizations lancia errore su risposta non-array', async () => {
  installFetchMock(async () => jsonResponse({ unexpected: true }));
  await assert.rejects(() => claudeService.listOrganizations('sess-abc'), /formato non riconosciuto/);
});

test('buildQuotaWindows converte solo le finestre presenti e valide', () => {
  const windows = claudeService.buildQuotaWindows({
    five_hour: { utilization: 34, resets_at: '2026-07-20T10:00:00Z' },
    seven_day: { utilization: 58, resets_at: '2026-07-23T00:00:00Z' },
    // seven_day_opus assente di proposito: non deve comparire nell'output
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].id, 'five_hour');
  assert.equal(windows[0].used, 34);
  assert.equal(windows[0].unit, 'percentage');
  assert.equal(windows[1].id, 'seven_day');
});

test('buildQuotaWindows lancia errore esplicito se nessuna finestra riconosciuta', () => {
  assert.throws(() => claudeService.buildQuotaWindows({}), /nessuna finestra di quota riconosciuta/);
});

test('fetchUsage usa organizationId fornito senza chiamare /organizations', async () => {
  const calledUrls: string[] = [];
  installFetchMock(async (url) => {
    calledUrls.push(url);
    return jsonResponse({ seven_day: { utilization: 61, resets_at: '2026-07-25T00:00:00Z' } });
  });

  const result = await claudeService.fetchUsage({ sessionKey: 'sess-abc', organizationId: 'org-xyz' });

  assert.equal(calledUrls.length, 1);
  assert.match(calledUrls[0], /organizations\/org-xyz\/usage/);
  assert.equal(result.quotaWindows[0].used, 61);
  assert.equal(result.subscriptionRenewsAt, null);
});

test('fetchUsage risolve organizationId quando assente, poi chiama /usage', async () => {
  const calledUrls: string[] = [];
  installFetchMock(async (url) => {
    calledUrls.push(url);
    if (url.endsWith('/organizations')) return jsonResponse([{ uuid: 'org-auto', name: 'Solo' }]);
    return jsonResponse({ seven_day: { utilization: 12 } });
  });

  const result = await claudeService.fetchUsage({ sessionKey: 'sess-abc' });

  assert.equal(calledUrls.length, 2);
  assert.match(calledUrls[1], /organizations\/org-auto\/usage/);
  assert.equal(result.quotaWindows[0].used, 12);
});

test('fetchUsage lancia errore esplicito senza sessionKey', async () => {
  await assert.rejects(() => claudeService.fetchUsage({ sessionKey: '' }), /sessionKey mancante/);
});

test('fetchUsage propaga un errore leggibile su risposta HTTP non-ok', async () => {
  installFetchMock(async () => jsonResponse({ error: 'unauthorized' }, 401));
  await assert.rejects(
    () => claudeService.fetchUsage({ sessionKey: 'sess-abc', organizationId: 'org-xyz' }),
    /ha risposto 401/,
  );
});
