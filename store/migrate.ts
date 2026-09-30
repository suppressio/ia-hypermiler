// store/migrate.ts — registro account: default per provider e migrazione dallo
// schema legacy a due slot `{ claude, copilot }` all'array `AccountConfig[]`
// (issue #4, EVOLUTION.md punto 3). Funzioni pure, nessuna dipendenza da Electron:
// testate in store/migrate.test.ts.

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
    // L'API di billing Copilot non espone la quota totale del piano: valore
    // configurato manualmente (vedi ARCHITECTURE.md §0 e RESEARCH.md v3 §3).
    manualQuota: 300,
    planTier: 'individual',
    experimentalWarningAcknowledged: false,
  };
}

export function defaultAccountFor(provider: ProviderId, id: AccountId, label?: string): AccountConfig {
  return provider === 'claude' ? defaultClaudeAccount(id, label) : defaultCopilotAccount(id, label);
}

/** Nome visualizzato di un nuovo account: "Claude", poi "Claude 2", "Claude 3"… */
export function nextAccountLabel(provider: ProviderId, existing: AccountConfig[]): string {
  const base = PROVIDER_DISPLAY_NAMES[provider];
  const labels = new Set(existing.map((a) => a.label));
  if (!labels.has(base)) return base;
  let n = 2;
  while (labels.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * Converte `accounts` in `AccountConfig[]`. Idempotente: un array già migrato
 * torna com'è. Gli account legacy mantengono id `'claude'`/`'copilot'` — gli
 * stessi valori già usati come `accountId` in history.dailyUsage/recentSamples/
 * lastGood, che così restano validi senza alcuna riscrittura dello storico.
 * Uno slot legacy mai configurato (né abilitato né con credenziali) non genera
 * un account: la tabella in Impostazioni parte vuota invece che con righe fantasma.
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
 * Al massimo un account Claude può avere `localInsights: true`: le sessioni
 * Claude Code locali non dicono a quale account appartengono. Se più d'uno lo
 * ha (patch arrivata dal renderer), vince il primo in ordine.
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
 * Registro account su disco (già nel formato ad array) → AccountConfig[] validi:
 * ogni voce è completata con i default del suo provider (campi aggiunti in versioni
 * successive, tipi sbagliati), le voci senza id o con un provider sconosciuto sono
 * scartate. `provider`, `id` e (per Claude) `partition` non si possono cambiare dal
 * contenuto su disco: la partition deriva sempre dall'id.
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
