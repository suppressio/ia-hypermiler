// services/claude.ts — fetch utilizzo Claude (vedi RESEARCH.md v3 §1 e ARCHITECTURE.md §0)
//
// Non esiste un endpoint ufficiale per i piani Pro/Max/Team/Enterprise a livello di
// singolo utente: usiamo l'endpoint interno (non documentato, stabile nell'uso da parte
// di tool di terze parti) che alimenta la barra "Usage" di claude.ai, autenticato con il
// cookie di sessione dell'utente (sessionKey), catturato via login browser embedded
// (vedi main/claude-auth.ts) — mai chiesto in chiaro all'utente.

import { fetchJson } from './_http';
import { extractShape, FormatDriftError } from './_shape';
import type { ClaudeCredentials, QuotaWindow, RawAccountUsage } from '../types/index';

const BASE_URL = 'https://claude.ai/api';

// claude.ai è dietro Cloudflare: senza uno User-Agent da browser reale, anche
// con i cookie giusti la richiesta rischia di essere trattata come bot (vedi
// authHeaders sotto e main/claude-auth.ts:buildClaudeCookieHeader).
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface ClaudeOrganization {
  uuid?: string;
  id?: string;
  name?: string;
}

interface ClaudeUsageWindowResponse {
  utilization?: number | null;
  resets_at?: string | null;
  // Visti su alcune finestre (es. crediti extra a consumo): se presenti insieme a
  // utilization, trattiamo la finestra come "a conteggio" (unit: 'count') con
  // used/total in dollari reali invece che solo percentuale — vedi buildQuotaWindows.
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
}

// L'endpoint interno non è documentato e i nomi dei campi non sono stabili: oltre
// ai tre nomi storici (five_hour/seven_day/seven_day_opus, vedi RESEARCH.md v3 §1),
// un aggiornamento reale osservato il 2026-07 li ha sostituiti con nomi arbitrari
// diversi per ogni finestra (es. "cinder_cove", "omelette_promotional" — probabile
// offuscamento intenzionale lato Anthropic). Un indice di firma tipizzato ci
// permette di iterare su QUALSIASI chiave senza assumerne il nome, vedi sotto.
type ClaudeUsageResponse = Record<string, ClaudeUsageWindowResponse | null | undefined>;

// Etichette leggibili solo per i nomi storici noti (se dovessero ricomparire in
// futuro): per ogni altra chiave non riconosciuta generiamo un'etichetta generica
// a runtime in buildQuotaWindows, senza assumere cosa rappresenti.
const KNOWN_LABELS: Record<string, string> = {
  five_hour: 'Limite 5 ore',
  seven_day: 'Limite settimanale (tutti i modelli)',
  seven_day_opus: 'Limite settimanale Opus',
};

// Se disponibile un cookieHeader completo (letto fresco dalla sessione Electron,
// include cf_clearance), lo usiamo così com'è; altrimenti ricadiamo sul solo
// sessionKey — funziona per i test (fetch mockato) ma NON contro claude.ai reale,
// che senza cf_clearance risponde con la verifica Cloudflare invece dei dati.
function authHeaders(sessionKey: string, cookieHeader?: string | null): Record<string, string> {
  return {
    Cookie: cookieHeader || `sessionKey=${sessionKey}`,
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
  };
}

/**
 * Elenca le organizzazioni disponibili per l'account autenticato (serve a scegliere
 * l'organizationId da usare per l'endpoint di usage — un account personale ne ha
 * tipicamente una sola, un membro di più workspace può averne più di una).
 */
export async function listOrganizations(sessionKey: string, cookieHeader?: string | null): Promise<Array<{ id: string; name: string }>> {
  if (!sessionKey) {
    throw new Error("Claude: sessionKey mancante — collega l'account dalle Impostazioni");
  }
  const data = await fetchJson<ClaudeOrganization[]>(`${BASE_URL}/organizations`, {
    headers: authHeaders(sessionKey, cookieHeader),
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
 * ufficialmente e i nomi dei campi non sono stabili (vedi commento su
 * ClaudeUsageResponse sopra): invece di leggere per nome chiave, riconosciamo una
 * finestra di quota dalla FORMA del suo valore — qualunque chiave abbia un
 * `utilization` numerico viene trattata come una finestra reale, a prescindere
 * dal nome. Se un campo atteso manca semplicemente non generiamo quella finestra,
 * invece di assumere un valore e mostrare un dato sbagliato.
 */
export function buildQuotaWindows(usage: ClaudeUsageResponse): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  // Distinto da windows.length === 0: tiene traccia se ABBIAMO riconosciuto almeno
  // una finestra dalla forma (utilization numerico), anche se poi l'abbiamo scartata
  // perché non applicabile (0%, nessun reset, nessun importo). Solo se non
  // riconosciamo NULLA è un vero format-drift — un account senza finestre attive
  // (es. tutte 0%/non applicabili) è un risultato legittimo, non un errore.
  let recognizedAny = false;

  for (const [key, entry] of Object.entries(usage || {})) {
    if (!entry || typeof entry.utilization !== 'number') continue;
    recognizedAny = true;

    const resetsAt = entry.resets_at ? new Date(entry.resets_at) : null;
    const hasDollarAmounts = typeof entry.limit_dollars === 'number' && typeof entry.used_dollars === 'number';

    // Una finestra a 0% senza data di reset e senza importi non è distinguibile da
    // un campo "non applicabile a questo piano" (visto realmente: una finestra
    // promozionale completamente nulla tranne utilization:0) — la scartiamo per non
    // mostrare una riga vuota e priva di significato nel widget.
    if (entry.utilization === 0 && !resetsAt && !hasDollarAmounts) continue;

    const knownLabel = KNOWN_LABELS[key];
    const label = knownLabel
      ?? (hasDollarAmounts ? `Credito extra Claude (${key})` : `Utilizzo Claude — finestra non documentata (${key})`);

    // Nomi storici noti: manteniamo il periodo esplicito già verificato in passato.
    // Per qualunque altra chiave (nome non documentato/offuscato) non possiamo
    // dedurre con certezza la durata reale della finestra dalla sola distanza dal
    // reset — dichiariamo onestamente "billing-cycle"/durata sconosciuta invece di
    // indovinare un numero che potrebbe risultare sbagliato (vedi CLAUDE.md).
    let periodType: QuotaWindow['periodType'] = 'billing-cycle';
    let periodLength: number | null = null;
    if (key === 'five_hour') {
      periodType = 'rolling-hours';
      periodLength = 5;
    } else if (key === 'seven_day' || key === 'seven_day_opus') {
      periodType = 'rolling-days';
      periodLength = 7;
    }

    windows.push({
      id: key,
      label,
      periodType,
      periodLength,
      unit: hasDollarAmounts ? 'count' : 'percentage',
      used: hasDollarAmounts ? (entry.used_dollars as number) : entry.utilization,
      total: hasDollarAmounts ? (entry.limit_dollars as number) : null,
      resetsAt,
    });
  }

  if (windows.length === 0 && !recognizedAny) {
    // Logghiamo la risposta grezza per intero in console (terminale/log del main
    // process, mai nel renderer): non contiene credenziali, solo percentuali di
    // utilizzo — serve a capire il formato reale quando diverge da RESEARCH.md.
    console.error('[services/claude] risposta usage non riconosciuta, contenuto grezzo:', JSON.stringify(usage));
    const preview = JSON.stringify(usage).slice(0, 500);
    throw new FormatDriftError(
      `Claude: nessuna finestra di quota riconosciuta nella risposta — il formato dell'endpoint interno potrebbe essere cambiato (vedi RESEARCH.md). Risposta ricevuta: ${preview}`,
      'claude.ai/api/organizations/{id}/usage',
      extractShape(usage),
    );
  }
  // windows.length === 0 con recognizedAny === true: forma riconosciuta, ma
  // nessuna finestra applicabile in questo momento (es. solo crediti promozionali
  // inattivi) — risultato legittimo, non un errore.
  return windows;
}

export async function fetchUsage(credentials: ClaudeCredentials): Promise<RawAccountUsage> {
  const { sessionKey, planTier, cookieHeader } = credentials || ({} as ClaudeCredentials);
  if (!sessionKey) {
    throw new Error("Claude: sessionKey mancante — collega l'account dalle Impostazioni");
  }

  let organizationId = credentials.organizationId;
  if (!organizationId) {
    const orgs = await listOrganizations(sessionKey, cookieHeader);
    if (orgs.length === 0) {
      throw new Error('Claude: nessuna organizzazione trovata per questo account');
    }
    organizationId = orgs[0].id;
  }

  const usage = await fetchJson<ClaudeUsageResponse>(`${BASE_URL}/organizations/${organizationId}/usage`, {
    headers: authHeaders(sessionKey, cookieHeader),
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
