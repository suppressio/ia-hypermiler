// services/claude.ts — fetch utilizzo Claude (vedi RESEARCH.md v3 §1 e ARCHITECTURE.md §0)
//
// Non esiste un endpoint ufficiale per i piani Pro/Max/Team/Enterprise a livello di
// singolo utente: usiamo l'endpoint interno (non documentato, stabile nell'uso da parte
// di tool di terze parti) che alimenta la barra "Usage" di claude.ai, autenticato con il
// cookie di sessione dell'utente (sessionKey), catturato via login browser embedded
// (vedi main/claude-auth.ts) — mai chiesto in chiaro all'utente.

import { fetchJson } from './_http';
import type { ClaudeCredentials, QuotaWindow, RawAccountUsage } from '../types/index';

const BASE_URL = 'https://claude.ai/api';

interface ClaudeOrganization {
  uuid?: string;
  id?: string;
  name?: string;
}

interface ClaudeUsageWindowResponse {
  utilization?: number;
  resets_at?: string;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindowResponse;
  seven_day?: ClaudeUsageWindowResponse;
  seven_day_opus?: ClaudeUsageWindowResponse;
}

function authHeaders(sessionKey: string): Record<string, string> {
  return {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: 'application/json',
  };
}

/**
 * Elenca le organizzazioni disponibili per l'account autenticato (serve a scegliere
 * l'organizationId da usare per l'endpoint di usage — un account personale ne ha
 * tipicamente una sola, un membro di più workspace può averne più di una).
 */
export async function listOrganizations(sessionKey: string): Promise<Array<{ id: string; name: string }>> {
  if (!sessionKey) {
    throw new Error("Claude: sessionKey mancante — collega l'account dalle Impostazioni");
  }
  const data = await fetchJson<ClaudeOrganization[]>(`${BASE_URL}/organizations`, {
    headers: authHeaders(sessionKey),
    label: 'claude.ai/api/organizations',
  });
  if (!Array.isArray(data)) {
    throw new Error('Claude: risposta inattesa da /api/organizations (formato non riconosciuto)');
  }
  return data.map((org) => ({ id: (org.uuid || org.id) as string, name: org.name || 'Organizzazione' }));
}

/**
 * Converte la risposta dell'endpoint interno di usage nel modello QuotaWindow
 * condiviso da ARCHITECTURE.md §0. Il formato esatto della risposta non è documentato
 * ufficialmente: se un campo atteso manca semplicemente non generiamo quella finestra,
 * invece di assumere un valore e mostrare un dato sbagliato.
 */
export function buildQuotaWindows(usage: ClaudeUsageResponse): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const specs: Array<{ key: keyof ClaudeUsageResponse; id: string; label: string }> = [
    { key: 'five_hour', id: 'five_hour', label: 'Limite 5 ore' },
    { key: 'seven_day', id: 'seven_day', label: 'Limite settimanale (tutti i modelli)' },
    { key: 'seven_day_opus', id: 'seven_day_opus', label: 'Limite settimanale Opus' },
  ];

  for (const spec of specs) {
    const entry = usage?.[spec.key];
    if (!entry || typeof entry.utilization !== 'number') continue;
    windows.push({
      id: spec.id,
      label: spec.label,
      periodType: spec.key === 'five_hour' ? 'rolling-hours' : 'rolling-days',
      periodLength: spec.key === 'five_hour' ? 5 : 7,
      unit: 'percentage',
      used: entry.utilization,
      total: null,
      resetsAt: entry.resets_at ? new Date(entry.resets_at) : null,
    });
  }

  if (windows.length === 0) {
    throw new Error("Claude: nessuna finestra di quota riconosciuta nella risposta — il formato dell'endpoint interno potrebbe essere cambiato (vedi RESEARCH.md)");
  }
  return windows;
}

export async function fetchUsage(credentials: ClaudeCredentials): Promise<RawAccountUsage> {
  const { sessionKey, planTier } = credentials || ({} as ClaudeCredentials);
  if (!sessionKey) {
    throw new Error("Claude: sessionKey mancante — collega l'account dalle Impostazioni");
  }

  let organizationId = credentials.organizationId;
  if (!organizationId) {
    const orgs = await listOrganizations(sessionKey);
    if (orgs.length === 0) {
      throw new Error('Claude: nessuna organizzazione trovata per questo account');
    }
    organizationId = orgs[0].id;
  }

  const usage = await fetchJson<ClaudeUsageResponse>(`${BASE_URL}/organizations/${organizationId}/usage`, {
    headers: authHeaders(sessionKey),
    label: 'claude.ai/api/organizations/{id}/usage',
  });

  return {
    planTier: planTier || 'pro',
    // Claude non espone la data di fatturazione dell'abbonamento via questo endpoint:
    // resta un valore configurato manualmente in Impostazioni (accounts.claude.subscription).
    subscriptionRenewsAt: null,
    quotaWindows: buildQuotaWindows(usage),
    // Nessuno storico giornaliero disponibile da questa API: lo storico viene
    // costruito localmente dall'app poll dopo poll (vedi main.ts + store.history).
  };
}
