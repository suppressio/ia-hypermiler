// store/migrate.ts — account registry: per-provider defaults and migration from the
// legacy two-slot schema `{ claude, copilot }` to the `AccountConfig[]` array (issue
// #4, EVOLUTION.md point 3). Pure functions, no Electron dependency: tested in
// store/migrate.test.ts.

import type {
  AccountConfig,
  AccountId,
  ClaudeAccountSettings,
  CopilotAccountSettings,
  ProviderId,
} from '../types/index';
import { isPlainRecord, mergeWithDefaults } from './merge';

export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  claude: 'Claude',
  copilot: 'GitHub Copilot',
};

export function claudePartitionFor(id: AccountId): string {
  return `persist:account-${id}`;
}

export function defaultClaudeAccount(id: AccountId, label = PROVIDER_DISPLAY_NAMES.claude): ClaudeAccountSettings {
  return {
    id,
    provider: 'claude',
    label,
    enabled: false,
    accountScope: 'personal',
    subscription: { renewalRule: { type: 'dayOfMonth', day: 1 } },
    authMethod: 'password',
    session: { sessionKey: null, organizationId: null, capturedAt: null, expiresAt: null },
    planTier: 'pro',
    partition: claudePartitionFor(id),
    localInsights: false,
  };
}

export function defaultCopilotAccount(id: AccountId, label = PROVIDER_DISPLAY_NAMES.copilot): CopilotAccountSettings {
  return {
    id,
    provider: 'copilot',
    label,
    enabled: false,
    accountScope: 'personal',
    subscription: { renewalRule: { type: 'dayOfMonth', day: 1 } },
    authMethod: 'pat',
    credentials: { token: null, username: null },
    oauthApp: { clientId: null },
    // Copilot's billing API does not expose the plan's total quota: value configured
    // by hand (see ARCHITECTURE.md §0 and RESEARCH.md v3 §3).
    manualQuota: 300,
    planTier: 'individual',
    experimentalWarningAcknowledged: false,
  };
}

export function defaultAccountFor(provider: ProviderId, id: AccountId, label?: string): AccountConfig {
  return provider === 'claude' ? defaultClaudeAccount(id, label) : defaultCopilotAccount(id, label);
}

/** Display name of a new account: "Claude", then "Claude 2", "Claude 3"… */
export function nextAccountLabel(provider: ProviderId, existing: AccountConfig[]): string {
  const base = PROVIDER_DISPLAY_NAMES[provider];
  const labels = new Set(existing.map((a) => a.label));
  if (!labels.has(base)) return base;
  let n = 2;
  while (labels.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * Converts `accounts` into `AccountConfig[]`. Idempotent: an already migrated array
 * comes back normalized. Legacy accounts keep the ids `'claude'`/`'copilot'` — the same
 * values already used as `accountId` in history.dailyUsage/recentSamples/lastGood,
 * which therefore stay valid without rewriting the history. A legacy slot never
 * configured (neither enabled nor with credentials) produces no account: the Settings
 * table starts empty instead of with ghost rows.
 */
export function migrateAccounts(rawAccounts: unknown, legacyLocalInsightsEnabled: boolean): AccountConfig[] {
  if (Array.isArray(rawAccounts)) return normalizeAccounts(rawAccounts);
  if (!isPlainRecord(rawAccounts)) return [];

  const result: AccountConfig[] = [];

  const claude = rawAccounts.claude;
  if (isPlainRecord(claude)) {
    const session = isPlainRecord(claude.session) ? claude.session : {};
    if (claude.enabled === true || typeof session.sessionKey === 'string') {
      const migrated = mergeWithDefaults(defaultClaudeAccount('claude'), claude) as ClaudeAccountSettings;
      migrated.id = 'claude';
      migrated.provider = 'claude';
      migrated.partition = claudePartitionFor('claude');
      migrated.localInsights = legacyLocalInsightsEnabled;
      result.push(migrated);
    }
  }

  const copilot = rawAccounts.copilot;
  if (isPlainRecord(copilot)) {
    const credentials = isPlainRecord(copilot.credentials) ? copilot.credentials : {};
    if (copilot.enabled === true || typeof credentials.token === 'string') {
      const migrated = mergeWithDefaults(defaultCopilotAccount('copilot'), copilot) as CopilotAccountSettings;
      migrated.id = 'copilot';
      migrated.provider = 'copilot';
      result.push(migrated);
    }
  }

  return result;
}

/**
 * At most one Claude account can have `localInsights: true`: local Claude Code
 * sessions do not say which account they belong to. If more have it (patch from the
 * renderer), the first in order wins.
 */
export function enforceSingleLocalInsights(accounts: AccountConfig[]): AccountConfig[] {
  let seen = false;
  return accounts.map((a) => {
    if (a.provider !== 'claude' || !a.localInsights) return a;
    if (seen) return { ...a, localInsights: false };
    seen = true;
    return a;
  });
}

/**
 * Account registry on disk (already in array form) → valid AccountConfig[]: each
 * entry is completed with its provider's defaults (fields added in later versions,
 * wrong types), entries without an id or with an unknown provider are dropped.
 * `provider`, `id` and (for Claude) `partition` cannot be changed by the content on
 * disk: the partition always derives from the id.
 */
export function normalizeAccounts(rawAccounts: unknown[]): AccountConfig[] {
  const result: AccountConfig[] = [];
  for (const raw of rawAccounts) {
    if (!isPlainRecord(raw) || typeof raw.id !== 'string' || raw.id === '') continue;
    const id = raw.id;
    if (raw.provider === 'claude') {
      const cfg = mergeWithDefaults(defaultClaudeAccount(id), raw) as ClaudeAccountSettings;
      result.push({ ...cfg, id, provider: 'claude', partition: claudePartitionFor(id) });
    } else if (raw.provider === 'copilot') {
      const cfg = mergeWithDefaults(defaultCopilotAccount(id), raw) as CopilotAccountSettings;
      result.push({ ...cfg, id, provider: 'copilot' });
    }
  }
  return enforceSingleLocalInsights(result);
}
