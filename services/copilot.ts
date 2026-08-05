// services/copilot.ts — fetch utilizzo GitHub Copilot (vedi RESEARCH.md v3 §2 e ARCHITECTURE.md §0)
//
// Due percorsi molto diversi in affidabilità:
// - Piano PERSONALE: endpoint ufficiale e documentato (ai_credit/usage, poi
//   premium_request/usage come fallback), via PAT. Se entrambi rispondono 404
//   (osservato con un account Free reale — vedi RESEARCH.md §2.1 addendum),
//   ultimo tentativo sull'endpoint interno sotto, condiviso col percorso aziendale.
// - Seat AZIENDALE (org-managed): nessun endpoint pubblico self-service. Unico dato
//   disponibile è l'endpoint interno non documentato copilot_internal/user (stesso
//   usato dall'indicatore di quota in VS Code) — trattato esplicitamente come
//   funzionalità sperimentale/best-effort, può rompersi senza preavviso.
//
// L'API di billing di GitHub non espone la quota TOTALE del piano (solo il consumo):
// il totale resta un valore configurato manualmente dall'utente (credentials.manualQuota),
// come già anticipato in ARCHITECTURE.md §0.

import { fetchJson } from './_http';
import { extractShape, FormatDriftError } from './_shape';
import type { CopilotCredentials, QuotaWindow, RawAccountUsage } from '../types/index';

const API_BASE = 'https://api.github.com';
const USD_PER_CREDIT = 0.01; // 1 AI credit = $0.01, vedi RESEARCH.md §2.1

interface GithubUserResponse {
  login?: string;
}

interface BillingUsageItem {
  netAmount?: number;
  [key: string]: unknown;
}

interface BillingUsageReport {
  // year/month/day: un solo timePeriod per l'intero report (non una data per item) —
  // il filtro per mese avviene lato server tramite i parametri di query year/month.
  usageItems?: BillingUsageItem[];
}

interface CopilotInternalQuotaSnapshot {
  percent_remaining?: number;
  [key: string]: unknown;
}

interface CopilotInternalUserResponse {
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_snapshots?: Record<string, CopilotInternalQuotaSnapshot>;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Risolve lo username GitHub associato al token (usato al momento del "Connetti"). */
export async function resolveUsername(token: string): Promise<string> {
  if (!token) throw new Error('Copilot: token mancante');
  const data = await fetchJson<GithubUserResponse>(`${API_BASE}/user`, {
    headers: authHeaders(token),
    label: 'api.github.com/user',
  });
  if (!data?.login) {
    throw new Error('Copilot: impossibile determinare lo username dal token fornito');
  }
  return data.login;
}

/**
 * Somma il consumo (in credit AI) degli usage item di un report di billing.
 * Il report è già filtrato per anno/mese dal server (parametri di query year/month
 * sulla richiesta): ogni item non ha una propria data, solo un `netAmount` in USD
 * (importo netto dopo eventuali sconti) — convertito in credit AI (1 credit = $0.01).
 */
export function sumCreditsUsed(report: BillingUsageReport): number {
  const items = report?.usageItems;
  if (!Array.isArray(items)) {
    throw new FormatDriftError(
      'Copilot: formato risposta inatteso su ai_credit/usage (nessun usageItems) — vedi RESEARCH.md',
      'users/{username}/settings/billing/ai_credit/usage',
      extractShape(report),
    );
  }
  const totalUsd = items.reduce((sum, item) => sum + (Number(item.netAmount) || 0), 0);
  return Math.round(totalUsd / USD_PER_CREDIT);
}

function isHttp404(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 404;
}

/**
 * Legge il report di billing per il mese corrente. Prova prima `ai_credit/usage`
 * (endpoint corrente, sostituisce il vecchio modello "premium requests" ritirato
 * l'1/06/2026 — vedi RESEARCH.md §2.1); se risponde 404 (osservato con un account
 * reale, causa non ancora chiarita: rollout non uniforme dell'endpoint o account
 * senza un piano personale proprio) ripiega su `premium_request/usage`, che la
 * doc REST descrive con la stessa identica forma di risposta — stesso parsing,
 * nessuna logica duplicata. Un fallimento non-404 (rete, 401/403, ecc.) non
 * innesca il fallback: si propaga subito, per non mascherare un problema di
 * credenziali dietro un secondo tentativo inutile.
 */
async function fetchBillingUsageReport(username: string, token: string, year: number, month: string): Promise<BillingUsageReport> {
  const headers = authHeaders(token);
  try {
    return await fetchJson<BillingUsageReport>(
      `${API_BASE}/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage?year=${year}&month=${month}`,
      { headers, label: 'users/{username}/settings/billing/ai_credit/usage' },
    );
  } catch (err) {
    if (!isHttp404(err)) throw err;
    return fetchJson<BillingUsageReport>(
      `${API_BASE}/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage?year=${year}&month=${month}`,
      { headers, label: 'users/{username}/settings/billing/premium_request/usage (fallback da ai_credit/usage 404)' },
    );
  }
}

async function fetchPersonalUsage({ token, manualQuota, now }: { token: string; manualQuota?: number | null; now: Date }): Promise<RawAccountUsage> {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const username = await resolveUsername(token);

  try {
    const report = await fetchBillingUsageReport(username, token, year, month);
    const used = sumCreditsUsed(report);

    return {
      planTier: null, // valorizzato dal chiamante da store, non derivabile dalla risposta
      subscriptionRenewsAt: null,
      quotaWindows: [
        {
          id: 'ai_credits',
          label: 'Credito AI',
          periodType: 'billing-cycle',
          periodLength: null,
          unit: 'count',
          used,
          total: typeof manualQuota === 'number' ? manualQuota : null,
          resetsAt: null,
        },
      ],
    };
  } catch (err) {
    if (!isHttp404(err)) throw err;
    // Sia ai_credit/usage sia premium_request/usage hanno risposto 404 (osservato con
    // un account Free personale reale — vedi RESEARCH.md §2.1 addendum — nonostante la
    // pagina github.com/settings/billing dello stesso account mostri un consumo
    // "Included credits" reale: questi endpoint REST ufficiali evidentemente non lo
    // coprono per questo tipo di piano). Ultimo tentativo: lo stesso endpoint interno
    // non documentato già usato per i seat aziendali (RESEARCH.md §2.2) — alimenta
    // l'indicatore quota di VS Code per QUALSIASI account Copilot, non solo quelli
    // aziendali, quindi potrebbe funzionare anche qui.
    return fetchCopilotInternalUsage(token, 'piano personale, fallback interno');
  }
}

/**
 * Endpoint interno non documentato che alimenta l'indicatore di quota di VS Code,
 * per qualunque tipo di account Copilot (non solo seat aziendali — vedi RESEARCH.md
 * §2.2). Nessuna garanzia di stabilità o di compatibilità con un token PAT standard
 * (VS Code usa un token Copilot ottenuto con un proprio flusso di autenticazione, non
 * necessariamente un PAT generico). Se questa chiamata fallisce con 401/403, è atteso:
 * significa che il token fornito non è accettato da questo endpoint interno.
 */
async function fetchCopilotInternalUsage(token: string, context: string): Promise<RawAccountUsage> {
  let data: CopilotInternalUserResponse;
  try {
    data = await fetchJson<CopilotInternalUserResponse>(`${API_BASE}/copilot_internal/user`, {
      headers: authHeaders(token),
      label: 'copilot_internal/user (endpoint interno non ufficiale)',
    });
  } catch (err) {
    throw new Error(
      `Copilot (${context}, best-effort): chiamata fallita — ${(err as Error).message}. ` +
      'Questo endpoint non è ufficiale: potrebbe richiedere un token Copilot diverso da un PAT standard. Vedi RESEARCH.md.',
    );
  }

  const snapshot = data?.quota_snapshots;
  if (!snapshot) {
    throw new FormatDriftError(
      `Copilot (${context}, best-effort): risposta senza quota_snapshots — formato cambiato o token non valido per questo endpoint`,
      'copilot_internal/user',
      extractShape(data),
    );
  }

  const windows: QuotaWindow[] = [];
  for (const [key, entry] of Object.entries(snapshot)) {
    if (!entry || typeof entry.percent_remaining !== 'number') continue;
    windows.push({
      id: key,
      label: `Copilot — ${key}`,
      periodType: 'billing-cycle',
      periodLength: null,
      unit: 'percentage',
      used: Math.round((100 - entry.percent_remaining) * 10) / 10,
      total: null,
      resetsAt: data.quota_reset_date ? new Date(data.quota_reset_date) : null,
    });
  }

  if (windows.length === 0) {
    throw new FormatDriftError(
      `Copilot (${context}, best-effort): nessuna finestra di quota riconosciuta nella risposta`,
      'copilot_internal/user',
      extractShape(snapshot),
    );
  }

  return {
    planTier: data.copilot_plan || null,
    subscriptionRenewsAt: data.quota_reset_date ? new Date(data.quota_reset_date) : null,
    quotaWindows: windows,
  };
}

async function fetchOrgManagedUsage({ token }: { token: string; manualQuota?: number | null; now: Date }): Promise<RawAccountUsage> {
  return fetchCopilotInternalUsage(token, 'seat aziendale');
}

export async function fetchUsage(credentials: CopilotCredentials): Promise<RawAccountUsage> {
  const { token, accountScope, manualQuota } = credentials || ({} as CopilotCredentials);
  if (!token) {
    throw new Error("Copilot: token mancante — collega l'account dalle Impostazioni");
  }

  const now = new Date();
  if (accountScope === 'organization') {
    return fetchOrgManagedUsage({ token, manualQuota, now });
  }
  return fetchPersonalUsage({ token, manualQuota, now });
}
