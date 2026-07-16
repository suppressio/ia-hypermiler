// tests/integration/copilot.integration.test.ts — test contro i veri endpoint
// GitHub (RESEARCH.md v3 §2). Si attivano solo se le variabili d'ambiente giuste
// sono presenti — vedi .env.test.example e claude.integration.test.ts per il
// procedimento completo su come fornire le credenziali in sicurezza in locale.
//
// Variabili attese:
//   HYPERMILER_TEST_COPILOT_TOKEN  — fine-grained PAT con permesso "Plan" (read)
//   HYPERMILER_TEST_COPILOT_SCOPE  — 'personal' (default) oppure 'organization'
//                                    per testare il percorso best-effort seat aziendale

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as copilotService from '../../services/copilot';

const token = process.env.HYPERMILER_TEST_COPILOT_TOKEN;
const scope = (process.env.HYPERMILER_TEST_COPILOT_SCOPE || 'personal') as 'personal' | 'organization';

const skipReason = token
  ? false
  : 'HYPERMILER_TEST_COPILOT_TOKEN non impostata — vedi intestazione del file per come fornirla in locale';

test('resolveUsername su token reale ritorna uno username plausibile', { skip: skipReason }, async () => {
  const username = await copilotService.resolveUsername(token as string);
  assert.equal(typeof username, 'string');
  assert.ok(username.length > 0);
});

test('fetchUsage su account reale ritorna almeno una finestra di quota', { skip: skipReason }, async () => {
  const result = await copilotService.fetchUsage({ token: token as string, accountScope: scope, manualQuota: 300 });

  assert.ok(Array.isArray(result.quotaWindows));
  assert.ok(result.quotaWindows.length > 0);

  for (const win of result.quotaWindows) {
    assert.equal(typeof win.used, 'number');
    if (win.unit === 'percentage') {
      assert.ok(win.used >= 0 && win.used <= 100, `utilization fuori range: ${win.used}`);
    }
  }

  if (scope === 'organization') {
    // Percorso best-effort (RESEARCH.md v3 §2.2): se arriva fin qui senza eccezioni,
    // l'endpoint interno ha risposto con un formato riconosciuto — utile saperlo
    // subito se GitHub cambia qualcosa, invece di scoprirlo dall'app in produzione.
    console.log('[integration] Copilot seat aziendale: endpoint interno ancora compatibile.');
  }
});
