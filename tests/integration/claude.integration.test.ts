// tests/integration/claude.integration.test.ts — test contro il vero endpoint
// claude.ai (RESEARCH.md v3 §1). NON eseguiti in CI o in ambienti senza rete verso
// claude.ai: si attivano solo se sono presenti le variabili d'ambiente giuste.
//
// Come fornire le credenziali (in LOCALE, mai in chat, mai committate):
//   1. Copia .env.test.example in .env.test (già in .gitignore).
//   2. Compila HYPERMILER_TEST_CLAUDE_SESSION_KEY con il cookie `sessionKey`
//      catturato da un login reale (puoi leggerlo con gli strumenti developer del
//      browser dopo esserti autenticato su claude.ai, oppure — meglio — usa il
//      flusso "Connetti" dell'app stessa e ricopia il valore da store cifrato
//      solo per il test, mai in chiaro altrove).
//   3. (Opzionale) HYPERMILER_TEST_CLAUDE_ORG_ID se vuoi saltare la risoluzione
//      automatica dell'organizzazione.
//   4. Esegui `npm test` — Node carica automaticamente .env.test se presente
//      (grazie a --env-file-if-exists, vedi package.json) e questi test si
//      attivano da soli invece di essere skippati.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeService from '../../services/claude';

const sessionKey = process.env.HYPERMILER_TEST_CLAUDE_SESSION_KEY;
const organizationId = process.env.HYPERMILER_TEST_CLAUDE_ORG_ID;

const skipReason = sessionKey
  ? false
  : 'HYPERMILER_TEST_CLAUDE_SESSION_KEY non impostata — vedi intestazione del file per come fornirla in locale';

test('listOrganizations su account reale ritorna almeno un\'organizzazione', { skip: skipReason }, async () => {
  const orgs = await claudeService.listOrganizations(sessionKey as string);
  assert.ok(Array.isArray(orgs));
  assert.ok(orgs.length > 0, 'nessuna organizzazione trovata per questo account');
  for (const org of orgs) {
    assert.equal(typeof org.id, 'string');
  }
});

test('fetchUsage su account reale ritorna finestre di quota valide', { skip: skipReason }, async () => {
  const result = await claudeService.fetchUsage({ sessionKey: sessionKey as string, organizationId });

  assert.ok(Array.isArray(result.quotaWindows));
  assert.ok(result.quotaWindows.length > 0, 'RESEARCH.md prevedeva almeno una finestra (five_hour/seven_day/seven_day_opus): formato endpoint forse cambiato');

  for (const win of result.quotaWindows) {
    assert.equal(win.unit, 'percentage');
    assert.equal(typeof win.used, 'number');
    assert.ok(win.used >= 0 && win.used <= 100, `utilization fuori range: ${win.used}`);
  }
});
