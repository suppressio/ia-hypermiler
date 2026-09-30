// services/_http.ts — helper HTTP condiviso per i service (vedi CLAUDE.md: timeout max 10s,
// mai ritornare null/undefined silenziosamente su errore).

const DEFAULT_TIMEOUT_MS = 10000;

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  label?: string;
}

/**
 * GET con timeout esplicito e parsing JSON. Lancia un errore leggibile in ogni
 * caso di fallimento (rete, timeout, status non-2xx, JSON non valido).
 */
export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, label = url } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timeout (${timeoutMs}ms) chiamando ${label}`, { cause: err });
    }
    throw new Error(`Errore di rete chiamando ${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let bodyText = '';
    try { bodyText = await response.text(); } catch { /* ignora */ }
    const error = new Error(`${label} ha risposto ${response.status} ${response.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new Error(`Risposta non JSON valida da ${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export { DEFAULT_TIMEOUT_MS };
