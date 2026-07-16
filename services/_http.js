// services/_http.js — helper HTTP condiviso per i service (vedi CLAUDE.md: timeout max 10s,
// mai ritornare null/undefined silenziosamente su errore).

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * GET con timeout esplicito e parsing JSON. Lancia un errore leggibile in ogni
 * caso di fallimento (rete, timeout, status non-2xx, JSON non valido).
 */
async function fetchJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, label = url } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timeout (${timeoutMs}ms) chiamando ${label}`);
    }
    throw new Error(`Errore di rete chiamando ${label}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let bodyText = '';
    try { bodyText = await response.text(); } catch { /* ignora */ }
    throw new Error(`${label} ha risposto ${response.status} ${response.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new Error(`Risposta non JSON valida da ${label}: ${err.message}`);
  }
}

module.exports = { fetchJson, DEFAULT_TIMEOUT_MS };
