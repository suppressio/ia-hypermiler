// services/codex.ts — ChatGPT session and Codex usage (see docs/RESEARCH.md §6).

import { fetchJson } from './_http';
import { extractShape, FormatDriftError } from './_shape';
import type { CodexCredentials, QuotaWindow, RawAccountUsage } from '../types/index';

const SESSION_URL = 'https://chatgpt.com/api/auth/session';
/** Endpoint label used in usage errors and drift reports. */
export const USAGE_ENDPOINT_LABEL = 'chatgpt.com/backend-api/wham/usage';

/** Signals that the ChatGPT session must be renewed. */
export class CodexSignInRequiredError extends Error {
  constructor() {
    super('Codex: sign in again from Settings');
    this.name = 'CodexSignInRequiredError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeFetchError(error: unknown, label: string, token?: string): Error {
  const status = isRecord(error) ? error.status : undefined;
  if (status === 401 || status === 403) return new CodexSignInRequiredError();
  if (typeof status === 'number') return new Error(`${label} answered ${status}`);
  // JSON parser errors can quote the response body; transport messages are useful.
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = message.startsWith('Invalid JSON response from ')
    ? `Invalid JSON response from ${label}`
    : message;
  return new Error(token ? safeMessage.replaceAll(token, '[redacted]') : safeMessage);
}

/** Reads usage with an ephemeral session token that never leaves this call. */
export async function fetchUsageResponse(credentials: CodexCredentials): Promise<unknown> {
  if (!credentials.cookieHeader.trim() || !credentials.userAgent.trim()) {
    throw new Error('Codex: missing cookie header or partition User-Agent');
  }
  let session: unknown;
  try {
    session = await fetchJson(SESSION_URL, {
      headers: {
        Cookie: credentials.cookieHeader,
        'User-Agent': credentials.userAgent,
        Accept: 'application/json'
      },
      label: 'chatgpt.com/api/auth/session'
    });
  } catch (error) {
    throw sanitizeFetchError(error, 'chatgpt.com/api/auth/session');
  }
  if (!isRecord(session) || typeof session.accessToken !== 'string' || !session.accessToken.trim()) {
    throw new CodexSignInRequiredError();
  }
  try {
    return await fetchJson(`https://${USAGE_ENDPOINT_LABEL}`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'User-Agent': credentials.userAgent,
        Accept: 'application/json'
      },
      label: USAGE_ENDPOINT_LABEL
    });
  } catch (error) {
    throw sanitizeFetchError(error, USAGE_ENDPOINT_LABEL, session.accessToken);
  }
}

function readWindow(value: unknown, source: string, now: number): QuotaWindow | null {
  if (!isRecord(value)) return null;
  const used = value.used_percent;
  const seconds = value.limit_window_seconds;
  const validUsage = typeof used === 'number'
    && Number.isFinite(used) && used >= 0;
  const validDuration = typeof seconds === 'number'
    && Number.isSafeInteger(seconds) && seconds > 0;
  if (!validUsage || !validDuration) return null;
  const days = seconds % 86400 === 0;
  const hours = seconds < 86400 && seconds % 3600 === 0;
  if (!days && !hours) return null;
  const length = seconds / (days ? 86400 : 3600);
  let resetsAt: Date | null = null;
  const absoluteReset = typeof value.reset_at === 'number' && value.reset_at > 0
    ? value.reset_at * 1000 : NaN;
  const relativeReset = typeof value.reset_after_seconds === 'number' && value.reset_after_seconds >= 0
    ? now + value.reset_after_seconds * 1000 : NaN;
  for (const timestamp of [absoluteReset, relativeReset]) {
    const date = new Date(timestamp);
    if (Number.isFinite(date.getTime())) {
      resetsAt = date;
      break;
    }
  }
  return {
    id: `${source}-${length}${days ? 'd' : 'h'}`,
    label: `${length}-${days ? 'day' : 'hour'} limit`,
    periodType: days ? 'rolling-days' : 'rolling-hours',
    periodLength: length,
    unit: 'percentage',
    used,
    total: 100,
    resetsAt
  };
}

/** Maps recognized quota windows without clamping utilization. */
export function buildQuotaWindows(response: unknown, now = Date.now()): QuotaWindow[] {
  const drift = (): never => {
    throw new FormatDriftError('Codex: no quota window recognized', USAGE_ENDPOINT_LABEL, extractShape(response));
  };
  if (!isRecord(response) || !isRecord(response.rate_limit)) return drift();
  const windows: QuotaWindow[] = [];
  const add = (entry: unknown, source: string): void => {
    if (!isRecord(entry)) return;
    const limit = isRecord(entry.rate_limit) ? entry.rate_limit : entry;
    // Assume code-review and additional limits use direct windows or primary/secondary pairs.
    // Their populated shapes have not been observed yet (docs/RESEARCH.md §6.3).
    for (const value of [limit, limit.primary_window, limit.secondary_window]) {
      const window = readWindow(value, source, now);
      if (window && !windows.some((existing) => existing.id === window.id)) windows.push(window);
    }
  };
  add(response.rate_limit, 'codex');
  add(response.code_review_rate_limit, 'codex-review');
  // Unverified: additional limits are array entries or a keyed object map, optionally wrapping rate_limit.
  const additional: unknown = response.additional_rate_limits;
  if (Array.isArray(additional)) {
    additional.forEach((entry: unknown, index) => { add(entry, `codex-additional-array-${index}`); });
  } else if (isRecord(additional)) {
    for (const key of Object.keys(additional).sort()) add(additional[key], `codex-additional-key-${key}`);
  }
  if (windows.length === 0) return drift();
  return windows;
}

/** Fetches the plan and independent quota windows for a Codex account. */
export async function fetchUsage(credentials: CodexCredentials): Promise<RawAccountUsage> {
  const response = await fetchUsageResponse(credentials);
  return {
    planTier: isRecord(response) && typeof response.plan_type === 'string' ? response.plan_type : null,
    subscriptionRenewsAt: null,
    quotaWindows: buildQuotaWindows(response)
  };
}
