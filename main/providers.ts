// main/providers.ts — provider-specific part of the account registry (issue #4,
// docs/EVOLUTION.md point 3). main.ts works only on generic AccountConfig values and
// delegates here everything that depends on the provider: connection state,
// credentials for the service, disconnection, redaction of secrets towards the
// renderer. Copilot is read by services/copilot.ts (fetchUsage(credentials), the
// contract of AGENTS.md); Codex by the Go core CLI (main/core.ts, #178), which uses the
// user's own Codex sign-in: nothing to connect and no secret in the app. Claude quotas are not read (#140): see ClaudeUsageUnavailableError. Adding a provider = a new branch in each function below (the exhaustive
// `switch` on `provider` makes tsc fail when one is forgotten).

import * as copilotService from '../services/copilot';
import { core } from './core';
import { requireFresh } from './coreClient';
import { clearClaudePartition } from './claude-auth';
import { PROVIDER_DISPLAY_NAMES } from '../store/migrate';
import type { AccountConfig, CodexAccountSettings, ProviderId, RawAccountUsage } from '../types/index';

const SECRET_PLACEHOLDER = '••••••••';

/**
 * Claude quotas are not read (#140): Anthropic does not allow third-party apps to
 * collect or store claude.ai session tokens (Claude Code legal and compliance page), and
 * that was the only source. Claude accounts stay for the local insights; quotas return
 * through an allowed source with the standalone core (#139).
 */
export class ClaudeUsageUnavailableError extends Error {
  constructor() {
    super('Claude quotas are not available in this version (#140)');
    this.name = 'ClaudeUsageUnavailableError';
  }
}

export function providerDisplayName(provider: ProviderId): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

export function isConnected(cfg: AccountConfig): boolean {
  switch (cfg.provider) {
    // Nothing to connect: the core uses the Codex sign-in of this computer (#178).
    case 'codex': return true;
    // Nothing to connect: the account exists for the local insights (#140).
    case 'claude': return true;
    case 'copilot': return !!cfg.credentials.token;
  }
}

/** Label of the Codex source in the diagnostic report. */
export const CODEX_CORE_ENDPOINT_LABEL = 'core: codex app-server account/rateLimits/read';

// Provider flags of `hypermiler usage codex`: only the optional binary path.
function codexCoreRequest(cfg: CodexAccountSettings): { provider: string; flags: string[] } {
  return { provider: 'codex', flags: cfg.binaryPath ? ['--codex-bin', cfg.binaryPath] : [] };
}

/** Calls the provider service's fetchUsage with the account credentials. */
export async function fetchUsage(cfg: AccountConfig): Promise<RawAccountUsage> {
  switch (cfg.provider) {
    case 'codex':
      return requireFresh(await core.usage(codexCoreRequest(cfg)), 'codex');
    case 'claude':
      throw new ClaudeUsageUnavailableError();
    case 'copilot':
      return copilotService.fetchUsage({
        token: cfg.credentials.token as string,
        accountScope: cfg.accountScope,
        manualQuota: cfg.manualQuota,
        host: cfg.host,
      });
  }
}

/**
 * The raw usage response of the account, for the manual "report response" diagnostic
 * (main.ts, diagnostics/githubIssue.ts). Copilot reads several endpoints with
 * fallbacks: its main source, copilot_internal/user, is reported.
 */
export async function fetchRawResponse(cfg: AccountConfig): Promise<{ endpointLabel: string; response: unknown }> {
  switch (cfg.provider) {
    case 'codex':
      // The core's reading (contract v1 document), not the raw app-server answer: the
      // core never forwards it. Redacted like any response by the report.
      return { endpointLabel: CODEX_CORE_ENDPOINT_LABEL, response: await core.usage(codexCoreRequest(cfg)) };
    case 'claude':
      throw new ClaudeUsageUnavailableError();
    case 'copilot':
      return {
        endpointLabel: copilotService.INTERNAL_USER_ENDPOINT_LABEL,
        response: await copilotService.fetchUsageResponse({
          token: cfg.credentials.token as string,
          accountScope: cfg.accountScope,
          manualQuota: cfg.manualQuota,
          host: cfg.host,
        }),
      };
  }
}

/**
 * Removes credentials and, for Claude, the partition cookies — not only the
 * sessionKey in the store (cause of issue #4). Returns the updated, disabled config: a
 * disconnected account stays disconnected until "Connect" is done again.
 */
export async function disconnect(cfg: AccountConfig): Promise<AccountConfig> {
  switch (cfg.provider) {
    // Nothing stored to remove: signing out of Codex is done in Codex itself.
    case 'codex':
      return { ...cfg, enabled: false };
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
    case 'codex': return cfg;
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
    case 'codex': {
      const cur = current as typeof incoming;
      return { ...incoming, partition: cur.partition };
    }
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
