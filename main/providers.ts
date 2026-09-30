// main/providers.ts — parte specifica per provider del registro account (issue #4,
// EVOLUTION.md punto 3). main.ts lavora solo su AccountConfig generici e delega
// qui tutto ciò che dipende dal provider: stato di connessione, credenziali per il
// service, disconnessione, redazione dei segreti verso il renderer. I service
// (services/claude.ts, services/copilot.ts) restano invariati: il contratto
// fetchUsage(credentials) di CLAUDE.md è già la base comune tra provider.
// Aggiungere un provider = un nuovo ramo in ciascuna funzione qui sotto (il
// `switch` esaustivo su `provider` fa fallire tsc se se ne dimentica uno).

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
    case 'claude': return !!cfg.session?.sessionKey;
    case 'copilot': return !!cfg.credentials?.token;
  }
}

/** Chiama il fetchUsage del service del provider con le credenziali dell'account. */
export async function fetchUsage(cfg: AccountConfig): Promise<RawAccountUsage> {
  switch (cfg.provider) {
    case 'claude':
      return claudeService.fetchUsage({
        sessionKey: cfg.session.sessionKey as string,
        organizationId: cfg.session.organizationId,
        planTier: cfg.planTier,
        // Letto fresco ad ogni refresh (non persistito), dalla partition dell'account.
        cookieHeader: await buildClaudeCookieHeader(cfg.partition),
      });
    case 'copilot': {
      const raw = await copilotService.fetchUsage({
        token: cfg.credentials.token as string,
        accountScope: cfg.accountScope,
        manualQuota: cfg.manualQuota,
      });
      if (!raw.planTier) raw.planTier = cfg.planTier;
      return raw;
    }
  }
}

/**
 * Rimuove credenziali e, per Claude, i cookie della partition — non solo il
 * sessionKey nello store (causa di issue #4). Ritorna la config aggiornata,
 * disabilitata: un account disconnesso resta disconnesso finché non si rifà "Connetti".
 */
export async function disconnect(cfg: AccountConfig): Promise<AccountConfig> {
  switch (cfg.provider) {
    case 'claude':
      await clearClaudePartition(cfg.partition);
      return { ...cfg, enabled: false, session: { sessionKey: null, organizationId: null, capturedAt: null, expiresAt: null } };
    case 'copilot':
      // oauthApp.clientId non viene cancellato: non è un segreto, resta comodo per riconnettersi.
      return { ...cfg, enabled: false, credentials: { token: null, username: null } };
  }
}

/** Sostituisce i segreti con un segnaposto prima di passare il confine IPC verso il renderer. */
export function redactSecrets(cfg: AccountConfig): AccountConfig {
  switch (cfg.provider) {
    case 'claude':
      return { ...cfg, session: { ...cfg.session, sessionKey: cfg.session.sessionKey ? SECRET_PLACEHOLDER : null } };
    case 'copilot':
      return { ...cfg, credentials: { ...cfg.credentials, token: cfg.credentials.token ? SECRET_PLACEHOLDER : null } };
  }
}

/**
 * I segreti cambiano solo tramite i flussi dedicati (connect/disconnect), mai col
 * salvataggio generico delle Impostazioni: la config in arrivo dal renderer
 * contiene il segnaposto, che qui viene rimpiazzato dal valore reale attuale
 * dello stesso account (per id). Anche `partition` è gestita solo dal main.
 * Un account sconosciuto (id non presente) viene scartato: gli account si creano
 * solo via accounts:add, non inventandoli in una patch.
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
