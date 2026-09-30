// store/migrate.test.ts — migrazione dallo schema a due slot `{ claude, copilot }`
// al registro `AccountConfig[]` (issue #4). Funzioni pure, nessun electron-store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudePartitionFor,
  defaultClaudeAccount,
  defaultCopilotAccount,
  enforceSingleLocalInsights,
  migrateAccounts,
  nextAccountLabel,
} from './migrate';

const legacyClaude = {
  enabled: true,
  accountScope: 'organization',
  authMethod: 'sso',
  session: { sessionKey: 'sk-real', organizationId: 'org-1', capturedAt: '2026-09-01T00:00:00Z', expiresAt: null },
  planTier: 'enterprise',
  subscription: { renewalRule: { type: 'dayOfMonth', day: 15 } },
};

const legacyCopilot = {
  enabled: true,
  accountScope: 'personal',
  authMethod: 'oauth',
  credentials: { token: 'ghp_real', username: 'someone' },
  oauthApp: { clientId: 'Iv1.x' },
  manualQuota: 500,
  planTier: 'pro_plus',
  subscription: { renewalRule: { type: 'dayOfMonth', day: 3 } },
  experimentalWarningAcknowledged: true,
};

test('migrateAccounts: legacy → array, id preservati per non invalidare lo storico', () => {
  const result = migrateAccounts({ claude: legacyClaude, copilot: legacyCopilot }, false);
  assert.deepEqual(result.map((a) => a.id), ['claude', 'copilot']);
  assert.deepEqual(result.map((a) => a.provider), ['claude', 'copilot']);
});

test('migrateAccounts: conserva credenziali e configurazione, aggiunge partition', () => {
  const [claude, copilot] = migrateAccounts({ claude: legacyClaude, copilot: legacyCopilot }, false);
  assert.equal(claude.provider, 'claude');
  if (claude.provider !== 'claude') return;
  assert.equal(claude.session.sessionKey, 'sk-real');
  assert.equal(claude.planTier, 'enterprise');
  assert.equal(claude.subscription.renewalRule.day, 15);
  assert.equal(claude.partition, claudePartitionFor('claude'));
  assert.equal(claude.label, 'Claude');

  assert.equal(copilot.provider, 'copilot');
  if (copilot.provider !== 'copilot') return;
  assert.equal(copilot.credentials.token, 'ghp_real');
  assert.equal(copilot.manualQuota, 500);
  assert.equal(copilot.oauthApp.clientId, 'Iv1.x');
});

test('migrateAccounts: il vecchio flag globale localInsights passa all\'account Claude', () => {
  const [claude] = migrateAccounts({ claude: legacyClaude }, true);
  assert.equal(claude.provider === 'claude' && claude.localInsights, true);
});

test('migrateAccounts: slot legacy mai configurato non genera righe fantasma', () => {
  const neverUsed = { claude: { ...legacyClaude, enabled: false, session: { sessionKey: null } }, copilot: { ...legacyCopilot, enabled: false, credentials: { token: null, username: null } } };
  assert.deepEqual(migrateAccounts(neverUsed, false), []);
});

test('migrateAccounts: slot legacy incompleto (merge shallow electron-store) riceve i default mancanti', () => {
  const partial = { claude: { enabled: true, session: { sessionKey: 'sk' } } };
  const [claude] = migrateAccounts(partial, false);
  assert.equal(claude.provider, 'claude');
  if (claude.provider !== 'claude') return;
  assert.equal(claude.session.organizationId, null);
  assert.equal(claude.planTier, 'pro');
  assert.deepEqual(claude.subscription.renewalRule, { type: 'dayOfMonth', day: 1 });
});

test('migrateAccounts: idempotente su un array già migrato', () => {
  const already = [defaultClaudeAccount('claude-abc')];
  assert.equal(migrateAccounts(already, true), already);
});

test('migrateAccounts: valore non valido → nessun account', () => {
  assert.deepEqual(migrateAccounts(undefined, false), []);
  assert.deepEqual(migrateAccounts('x', false), []);
});

test('nextAccountLabel: numerazione progressiva per provider', () => {
  const existing = [defaultClaudeAccount('a'), defaultClaudeAccount('b', 'Claude 2'), defaultCopilotAccount('c')];
  assert.equal(nextAccountLabel('claude', existing), 'Claude 3');
  assert.equal(nextAccountLabel('copilot', existing), 'GitHub Copilot 2');
  assert.equal(nextAccountLabel('claude', []), 'Claude');
});

test('enforceSingleLocalInsights: al massimo un account Claude con insight locali', () => {
  const a = { ...defaultClaudeAccount('a'), localInsights: true };
  const b = { ...defaultClaudeAccount('b'), localInsights: true };
  const result = enforceSingleLocalInsights([a, defaultCopilotAccount('c'), b]);
  const flags = result.map((x) => x.provider === 'claude' && x.localInsights);
  assert.deepEqual(flags, [true, false, false]);
});
