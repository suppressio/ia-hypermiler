// main/providers.ts — provider-specific part of the account registry (issue #4,
// EVOLUTION.md point 3). main.ts works only on generic AccountConfig values and
// delegates here everything that depends on the provider: connection state,
// credentials for the service, disconnection, redaction of secrets towards the
// renderer. The services (services/claude.ts, services/copilot.ts) are unchanged: the
// fetchUsage(credentials) contract of CLAUDE.md is already the common base across
// providers. Adding a provider = a new branch in each function below (the exhaustive
// `switch` on `provider` makes tsc fail when one is forgotten).

import * as claudeService from '../services/claude';
import * as copilotService from '../services/copilot';
import { buildClaudeCookieHeader, clearClaudePartition } from './claude-auth';
import { PROVIDER_DISPLAY_NAMES } from '../store/migrate';
import type { AccountConfig, ProviderId, RawAccountUsage } from '../types/index';

const SECRET_PLACEHOLDER = '••••••••';

export function providerDisplayName(provider: ProviderId): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

export function isConnected(cfg: AccountConfig): boolean {
  switch (cfg.provider) {
    case 'claude': return !!cfg.session.sessionKey;
    case 'copilot': return !!cfg.credentials.token;
  }
}

/** Calls the provider service's fetchUsage with the account credentials. */
export async function fetchUsage(cfg: AccountConfig): Promise<RawAccountUsage> {
  switch (cfg.provider) {
    case 'claude':
      return claudeService.fetchUsage({
        sessionKey: cfg.session.sessionKey as string,
        organizationId: cfg.session.organizationId,
        planTier: cfg.planTier,
        // Read fresh on every refresh (not persisted), from the account partition.
        cookieHeader: await buildClaudeCookieHeader(cfg.partition),
      });
    case 'copilot': {
      const raw = await copilotService.fetchUsage({
        token: cfg.credentials.token as string,
        accountScope: cfg.accountScope,
        manualQuota: cfg.manualQuota,
        host: cfg.host,
      });
      if (!raw.planTier) raw.planTier = cfg.planTier;
      return raw;
    }
  }
}

/**
 * The raw usage response of the account, for the manual "report response" diagnostic
 * (main.ts, diagnostics/githubIssue.ts). Null for a provider that does not support it
 * yet: Copilot reads several endpoints with fallbacks, there is no single response.
 */
export async function fetchRawResponse(cfg: AccountConfig): Promise<{ endpointLabel: string; response: unknown } | null> {
  switch (cfg.provider) {
    case 'claude':
      return {
        endpointLabel: claudeService.USAGE_ENDPOINT_LABEL,
        response: await claudeService.fetchUsageResponse({
          sessionKey: cfg.session.sessionKey as string,
          organizationId: cfg.session.organizationId,
          planTier: cfg.planTier,
          cookieHeader: await buildClaudeCookieHeader(cfg.partition),
        }),
      };
    case 'copilot':
      return null;
  }
}

/**
 * Removes credentials and, for Claude, the partition cookies — not only the
 * sessionKey in the store (cause of issue #4). Returns the updated, disabled config: a
 * disconnected account stays disconnected until "Connect" is done again.
 */
export async function disconnect(cfg: AccountConfig): Promise<AccountConfig> {
  switch (cfg.provider) {
    case 'claude':
      await clearClaudePartition(cfg.partition);
      return { ...cfg, enabled: false, session: { sessionKey: null, organizationId: null, capturedAt: null, expiresAt: null } };
    case 'copilot':
      // oauthApp.clientId is not deleted: it is not a secret and is handy to reconnect.
      return { ...cfg, enabled: false, credentials: { token: null, username: null } };
  }
}

/** Replaces secrets with a placeholder before crossing the IPC boundary towards the renderer. */
export function redactSecrets(cfg: AccountConfig): AccountConfig {
  switch (cfg.provider) {
    case 'claude':
      return { ...cfg, session: { ...cfg.session, sessionKey: cfg.session.sessionKey ? SECRET_PLACEHOLDER : null } };
    case 'copilot':
      return { ...cfg, credentials: { ...cfg.credentials, token: cfg.credentials.token ? SECRET_PLACEHOLDER : null } };
  }
}

/**
 * Secrets change only through the dedicated flows (connect/disconnect), never through
 * the generic Settings save: the config coming from the renderer contains the
 * placeholder, replaced here by the current real value of the same account (by id).
 * `partition` is also owned by the main process only. An unknown account (id not
 * present) is dropped: accounts are created only via accounts:add, never invented in
 * a patch.
 */
export function preserveSecrets(incoming: AccountConfig, current: AccountConfig | undefined): AccountConfig | null {
  if (!current || current.provider !== incoming.provider) return null;
  switch (incoming.provider) {
    case 'claude': {
      const cur = current as typeof incoming;
      return { ...incoming, partition: cur.partition, session: { ...cur.session } };
    }
    case 'copilot': {
      const cur = current as typeof incoming;
      return { ...incoming, credentials: { ...cur.credentials } };
    }
  }
}
