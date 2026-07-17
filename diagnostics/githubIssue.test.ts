// diagnostics/githubIssue.test.ts — verifica che la bozza di issue GitHub generata
// automaticamente non contenga mai valori reali, solo la struttura della risposta
// (vedi services/_shape.ts, CLAUDE.md). Nessuna chiamata di rete: buildFormatDriftIssueUrl
// è una funzione pura che costruisce solo l'URL, l'apertura nel browser resta in main.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormatDriftIssueUrl } from './githubIssue';
import { extractShape } from '../services/_shape';

test('buildFormatDriftIssueUrl punta al repo giusto con new issue', () => {
  const url = buildFormatDriftIssueUrl({ accountId: 'claude', endpointLabel: 'x', shape: {} });
  assert.match(url, /^https:\/\/github\.com\/suppressio\/ia-hypermiler\/issues\/new\?/);
});

test('buildFormatDriftIssueUrl include titolo con il nome servizio leggibile', () => {
  const urlClaude = buildFormatDriftIssueUrl({ accountId: 'claude', endpointLabel: 'ep', shape: {} });
  const urlCopilot = buildFormatDriftIssueUrl({ accountId: 'copilot', endpointLabel: 'ep', shape: {} });
  const titleClaude = new URL(urlClaude).searchParams.get('title') || '';
  const titleCopilot = new URL(urlCopilot).searchParams.get('title') || '';
  assert.match(titleClaude, /Claude/);
  assert.match(titleCopilot, /Copilot/);
});

test('buildFormatDriftIssueUrl imposta le label attese', () => {
  const url = buildFormatDriftIssueUrl({ accountId: 'claude', endpointLabel: 'ep', shape: {} });
  assert.equal(new URL(url).searchParams.get('labels'), 'api-drift,auto-generated');
});

test('buildFormatDriftIssueUrl non contiene mai valori reali, solo la shape ridotta', () => {
  const shape = extractShape({ used_dollars: 389.19, limit_dollars: 1000, resets_at: '2026-09-13T14:38:47.107149+00:00' });
  const url = buildFormatDriftIssueUrl({
    accountId: 'claude',
    endpointLabel: 'claude.ai/api/organizations/{id}/usage',
    shape,
  });
  const body = new URL(url).searchParams.get('body') || '';
  assert.ok(!body.includes('389.19'));
  assert.ok(!body.includes('1000'));
  assert.ok(!body.includes('2026-09-13'));
  assert.ok(body.includes('"used_dollars": "number"'));
});

test('buildFormatDriftIssueUrl include un promemoria di revisione manuale nel corpo', () => {
  const url = buildFormatDriftIssueUrl({ accountId: 'copilot', endpointLabel: 'ep', shape: {} });
  const body = new URL(url).searchParams.get('body') || '';
  assert.match(body, /rivedi il contenuto prima di inviare/i);
});
