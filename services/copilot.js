// services/copilot.js — fetch utilizzo GitHub Copilot (vedi RESEARCH.md v3 §2 e ARCHITECTURE.md §0)
//
// Due percorsi molto diversi in affidabilità:
// - Piano PERSONALE: endpoint ufficiale e documentato (premium_request/usage), via PAT.
// - Seat AZIENDALE (org-managed): nessun endpoint pubblico self-service. Unico dato
//   disponibile è l'endpoint interno non documentato copilot_internal/user (stesso
//   usato dall'indicatore di quota in VS Code) — trattato esplicitamente come
//   funzionalità sperimentale/best-effort, può rompersi senza preavviso.
//
// L'API di billing di GitHub non espone la quota TOTALE del piano (solo il consumo):
// il totale resta un valore configurato manualmente dall'utente (credentials.manualQuota),
// come già anticipato in ARCHITECTURE.md §0.

const { fetchJson } = require('./_http');

const API_BASE = 'https://api.github.com';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Risolve lo username GitHub associato al token (usato al momento del "Connetti"). */
async function resolveUsername(token) {
  if (!token) throw new Error('Copilot: token mancante');
  const data = await fetchJson(`${API_BASE}/user`, {
    headers: authHeaders(token),
    label: 'api.github.com/user',
  });
  if (!data?.login) {
    throw new Error('Copilot: impossibile determinare lo username dal token fornito');
  }
  return data.login;
}

/** Somma le quantità degli usage item del mese corrente da un report di billing. */
function sumCurrentMonthUsage(report, now) {
  const items = report?.usageItems;
  if (!Array.isArray(items)) {
    throw new Error('Copilot: formato risposta inatteso su premium_request/usage (nessun usageItems) — vedi RESEARCH.md');
  }
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  return items
    .filter((item) => {
      if (!item?.date) return true; // se il report non ha già filtrato per mese, includiamo comunque per non sottostimare
      const d = new Date(item.date);
      return d.getUTCFullYear() === year && d.getUTCMonth() === month;
    })
    .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

async function fetchPersonalUsage({ token, manualQuota, now }) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  const report = await fetchJson(
    `${API_BASE}/users/${encodeURIComponent(await resolveUsername(token))}/settings/billing/premium_request/usage?year=${year}&month=${month}`,
    { headers: authHeaders(token), label: 'users/{username}/settings/billing/premium_request/usage' },
  );

  const used = sumCurrentMonthUsage(report, now);

  return {
    planTier: null, // valorizzato dal chiamante da store, non derivabile dalla risposta
    subscriptionRenewsAt: null,
    quotaWindows: [
      {
        id: 'premium_requests',
        label: 'Richieste premium',
        periodType: 'billing-cycle',
        periodLength: null,
        unit: 'count',
        used,
        total: typeof manualQuota === 'number' ? manualQuota : null,
        resetsAt: null,
      },
    ],
  };
}

async function fetchOrgManagedUsage({ token, manualQuota }) {
  // ATTENZIONE: endpoint interno non documentato, nessuna garanzia di stabilità o di
  // compatibilità con un token PAT standard (VS Code usa un token Copilot ottenuto con
  // un proprio flusso di autenticazione, non necessariamente un PAT generico) — vedi
  // RESEARCH.md v3 §2.2. Se questa chiamata fallisce con 401/403, è atteso: significa che
  // il token fornito non è accettato da questo endpoint interno.
  let data;
  try {
    data = await fetchJson(`${API_BASE}/copilot_internal/user`, {
      headers: authHeaders(token),
      label: 'copilot_internal/user (endpoint interno non ufficiale)',
    });
  } catch (err) {
    throw new Error(
      `Copilot (seat aziendale, best-effort): chiamata fallita — ${err.message}. ` +
      'Questo endpoint non è ufficiale: potrebbe richiedere un token Copilot diverso da un PAT standard. Vedi RESEARCH.md.',
    );
  }

  const snapshot = data?.quota_snapshots;
  if (!snapshot) {
    throw new Error('Copilot (seat aziendale, best-effort): risposta senza quota_snapshots — formato cambiato o token non valido per questo endpoint');
  }

  const windows = [];
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
    throw new Error('Copilot (seat aziendale, best-effort): nessuna finestra di quota riconosciuta nella risposta');
  }

  return {
    planTier: data.copilot_plan || null,
    subscriptionRenewsAt: data.quota_reset_date ? new Date(data.quota_reset_date) : null,
    quotaWindows: windows,
  };
}

/**
 * @param {{ token: string, accountScope: 'personal'|'organization', manualQuota?: number }} credentials
 */
async function fetchUsage(credentials) {
  const { token, accountScope, manualQuota } = credentials || {};
  if (!token) {
    throw new Error('Copilot: token mancante — collega l\'account dalle Impostazioni');
  }

  const now = new Date();
  if (accountScope === 'organization') {
    return fetchOrgManagedUsage({ token, manualQuota, now });
  }
  return fetchPersonalUsage({ token, manualQuota, now });
}

module.exports = { fetchUsage, resolveUsername };
