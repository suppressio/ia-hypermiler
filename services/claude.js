// services/claude.js — fetch utilizzo Claude (vedi RESEARCH.md v3 §1 e ARCHITECTURE.md §0)
//
// Non esiste un endpoint ufficiale per i piani Pro/Max/Team/Enterprise a livello di
// singolo utente: usiamo l'endpoint interno (non documentato, stabile nell'uso da parte
// di tool di terze parti) che alimenta la barra "Usage" di claude.ai, autenticato con il
// cookie di sessione dell'utente (sessionKey), catturato via login browser embedded
// (vedi main/claude-auth.js) — mai chiesto in chiaro all'utente.
//
// Interfaccia: vedi CLAUDE.md / ARCHITECTURE.md §0.
// @param {{ sessionKey: string, organizationId?: string, planTier?: string }} credentials
// @returns {Promise<{ planTier, subscriptionRenewsAt: null, quotaWindows: Array }>}

const { fetchJson } = require('./_http');

const BASE_URL = 'https://claude.ai/api';

function authHeaders(sessionKey) {
  return {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: 'application/json',
  };
}

/**
 * Elenca le organizzazioni disponibili per l'account autenticato (serve a scegliere
 * l'organizationId da usare per l'endpoint di usage — un account personale ne ha
 * tipicamente una sola, un membro di più workspace può averne più di una).
 * @param {string} sessionKey
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function listOrganizations(sessionKey) {
  if (!sessionKey) {
    throw new Error('Claude: sessionKey mancante — collega l\'account dalle Impostazioni');
  }
  const data = await fetchJson(`${BASE_URL}/organizations`, {
    headers: authHeaders(sessionKey),
    label: 'claude.ai/api/organizations',
  });
  if (!Array.isArray(data)) {
    throw new Error('Claude: risposta inattesa da /api/organizations (formato non riconosciuto)');
  }
  return data.map((org) => ({ id: org.uuid || org.id, name: org.name || 'Organizzazione' }));
}

/**
 * Converte la risposta dell'endpoint interno di usage nel modello quotaWindows
 * condiviso da ARCHITECTURE.md §0. Il formato esatto della risposta non è documentato
 * ufficialmente: se un campo atteso manca semplicemente non generiamo quella finestra,
 * invece di assumere un valore e mostrare un dato sbagliato.
 */
function buildQuotaWindows(usage) {
  const windows = [];
  const specs = [
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
    throw new Error('Claude: nessuna finestra di quota riconosciuta nella risposta — il formato dell\'endpoint interno potrebbe essere cambiato (vedi RESEARCH.md)');
  }
  return windows;
}

async function fetchUsage(credentials) {
  const { sessionKey, planTier } = credentials || {};
  if (!sessionKey) {
    throw new Error('Claude: sessionKey mancante — collega l\'account dalle Impostazioni');
  }

  let organizationId = credentials.organizationId;
  if (!organizationId) {
    const orgs = await listOrganizations(sessionKey);
    if (orgs.length === 0) {
      throw new Error('Claude: nessuna organizzazione trovata per questo account');
    }
    organizationId = orgs[0].id;
  }

  const usage = await fetchJson(`${BASE_URL}/organizations/${organizationId}/usage`, {
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
    // costruito localmente dall'app poll dopo poll (vedi main.js + store.history).
  };
}

module.exports = { fetchUsage, listOrganizations };
