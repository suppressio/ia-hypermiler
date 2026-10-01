// services/_http.ts — HTTP helper shared by the services (see CLAUDE.md: 10s max
// timeout, never silently return null/undefined on error).

const DEFAULT_TIMEOUT_MS = 10000;

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  label?: string;
}

/**
 * GET with an explicit timeout and JSON parsing. Throws a readable error on any
 * failure (network, timeout, non-2xx status, invalid JSON).
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
      throw new Error(`Timeout (${timeoutMs}ms) calling ${label}`, { cause: err });
    }
    throw new Error(`Network error calling ${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let bodyText = '';
    try { bodyText = await response.text(); } catch { /* ignora */ }
    const error = new Error(`${label} answered ${response.status} ${response.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new Error(`Invalid JSON response from ${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export { DEFAULT_TIMEOUT_MS };
