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

test('buildQuotaWindows lancia un FormatDriftError con la shape (mai i valori) quando nulla è riconosciuto', () => {
  try {
    claudeService.buildQuotaWindows({ cinder_cove: { some_unrelated_field: 389.19 } } as any);
    assert.fail('doveva lanciare');
  } catch (err) {
    assert.equal((err as Error).name, 'FormatDriftError');
    const shape = (err as any).shape;
    assert.ok(!JSON.stringify(shape).includes('389.19'));
  }
});

test('buildQuotaWindows riconosce una finestra qualunque sia il nome della chiave, purché abbia utilization numerico', () => {
  // Nomi dei campi non stabili (vedi CLAUDE.md, caso reale osservato il 2026-07):
  // "cinder_cove" non è un nome documentato, ma va comunque riconosciuto come
  // finestra valida perché ha la forma giusta (utilization numerico).
  const windows = claudeService.buildQuotaWindows({ cinder_cove: { utilization: 38.9, resets_at: '2026-09-13T00:00:00Z' } } as any);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'cinder_cove');
  assert.equal(windows[0].used, 38.9);
  assert.equal(windows[0].unit, 'percentage');
});

test('buildQuotaWindows tratta le finestre con limit_dollars/used_dollars come "count" con importi reali', () => {
  const windows = claudeService.buildQuotaWindows({
    cinder_cove: {
      utilization: 39.5166701,
      resets_at: '2026-09-13T14:38:47.361625+00:00',
      limit_dollars: 1000,
      used_dollars: 395.166701,
      remaining_dollars: 604.83,
    },
  } as any);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].unit, 'count');
  assert.equal(windows[0].used, 395.166701);
  assert.equal(windows[0].total, 1000);
});

test('buildQuotaWindows scarta le finestre a 0% senza reset e senza importi (non applicabili al piano)', () => {
  const windows = claudeService.buildQuotaWindows({
    omelette_promotional: { utilization: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null },
  } as any);
  assert.equal(windows.length, 0);
});

test('buildQuotaWindows: caso reale — payload con nomi di campo offuscati (2026-07) viene interpretato correttamente', () => {
  // Payload reale ricevuto da un account collegato, con i vecchi nomi (five_hour,
  // seven_day, ...) tutti null e nomi nuovi/arbitrari al loro posto — vedi
  // CLAUDE.md "Stato avanzamento" e RESEARCH.md addendum.
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
  } as any);
  assert.equal(windows.length, 1); // solo cinder_cove: gli altri sono null o filtrati come non applicabili
  assert.equal(windows[0].id, 'cinder_cove');
  assert.equal(windows[0].unit, 'count');
  assert.equal(windows[0].used, 395.166701);
  assert.equal(windows[0].total, 1000);
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
