// services/claude.ts — Claude usage fetch (see RESEARCH.md v3 §1 and ARCHITECTURE.md §0)
//
// There is no official endpoint for Pro/Max/Team/Enterprise plans at the single-user
// level: we use the internal endpoint (undocumented, stable in practice and used by
// third-party tools) behind the claude.ai "Usage" bar, authenticated with the user's
// session cookie (sessionKey), captured through an embedded browser login (see
// main/claude-auth.ts) — never asked to the user in clear.

import { fetchJson } from './_http';
import { extractShape, FormatDriftError } from './_shape';
import type { ClaudeCredentials, QuotaWindow, RawAccountUsage } from '../types/index';

const BASE_URL = 'https://claude.ai/api';

// claude.ai is behind Cloudflare: without a real browser User-Agent, even with the
// right cookies the request risks being treated as a bot (see authHeaders below and
// main/claude-auth.ts:buildClaudeCookieHeader).
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
  // Seen on some windows (e.g. pay-as-you-go extra credits): when present together
  // with utilization, the window is treated as "count based" (unit: 'count') with
  // used/total in real dollars instead of a percentage only — see buildQuotaWindows.
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
}

// The internal endpoint is undocumented and field names are not stable: besides the
// three historical names (five_hour/seven_day/seven_day_opus, see RESEARCH.md v3 §1), a
// real update observed in 2026-07 replaced them with arbitrary names different for
// each window (e.g. "cinder_cove", "omelette_promotional" — likely intentional
// obfuscation on Anthropic's side). A typed index signature lets us iterate over ANY
// key without assuming its name, see below. Values are `unknown` and narrowed: besides
// windows the response carries other objects (extra_usage, spend), arrays (limits) and
// booleans.
type ClaudeUsageResponse = Record<string, unknown>;

// A minor-unit amount as found in `spend` (e.g. { amount_minor: 1234, exponent: 2 } = 12.34).
interface ClaudeMoneyAmount {
  amount_minor?: unknown;
  exponent?: unknown;
}

// `spend` object, seen for the first time on 2026-10-01 on a company (Team/Enterprise
// seat) account, where every window and extra_usage.utilization were null (issue #6,
// RESEARCH.md §1 addendum). It carries the extra-usage spend against its limit.
interface ClaudeSpendResponse {
  enabled?: unknown;
  percent?: unknown;
  used?: ClaudeMoneyAmount | null;
  limit?: ClaudeMoneyAmount | null;
}

const SPEND_KEY = 'spend';

// Readable labels only for the known historical names (should they come back):
// every other unrecognized key gets a generic label at runtime in buildQuotaWindows,
// without assuming what it represents. The renderer translates labels by window id
// (renderer/i18n), these are the English fallback.
const KNOWN_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit (all models)',
  seven_day_opus: 'Weekly Opus limit',
  [SPEND_KEY]: 'Spend limit',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ClaudeUsageWindow = ClaudeUsageWindowResponse & { utilization: number };

function asWindow(value: unknown): ClaudeUsageWindow | null {
  if (!isRecord(value) || typeof value.utilization !== 'number') return null;
  return { ...(value as ClaudeUsageWindowResponse), utilization: value.utilization };
}

/** Major-unit value of a minor-unit amount, or null when the shape is not the expected one. */
function moneyValue(amount: ClaudeMoneyAmount | null | undefined): number | null {
  if (!amount || typeof amount.amount_minor !== 'number' || typeof amount.exponent !== 'number') return null;
  return amount.amount_minor / 10 ** amount.exponent;
}

type SpendReading =
  | { kind: 'unrecognized' }
  | { kind: 'disabled' }
  | { kind: 'window'; window: QuotaWindow };

/**
 * Reads the `spend` object: real amounts when used/limit are well-formed (limit > 0),
 * otherwise its `percent`. `enabled: false` is a recognized "no spend limit active"
 * state, not a format drift.
 */
function readSpend(value: unknown): SpendReading {
  if (!isRecord(value)) return { kind: 'unrecognized' };
  const spend = value as ClaudeSpendResponse;
  if (spend.enabled === false) return { kind: 'disabled' };

  const used = moneyValue(spend.used);
  const limit = moneyValue(spend.limit);
  // A monthly spend limit: periodLength 1 (month) enables pacing, the period end comes
  // from the account renewal rule since the object carries no reset date.
  const base = { id: SPEND_KEY, label: KNOWN_LABELS[SPEND_KEY] ?? SPEND_KEY, periodType: 'billing-cycle' as const, periodLength: 1, resetsAt: null };
  if (used !== null && limit !== null && limit > 0) {
    return { kind: 'window', window: { ...base, unit: 'count', used, total: limit } };
  }
  if (typeof spend.percent === 'number') {
    return { kind: 'window', window: { ...base, unit: 'percentage', used: spend.percent, total: null } };
  }
  return { kind: 'unrecognized' };
}

// When a full cookieHeader is available (read fresh from the Electron session,
// includes cf_clearance) it is used as is; otherwise only the sessionKey is sent —
// fine for tests (mocked fetch) but NOT against the real claude.ai, which answers
// with the Cloudflare challenge instead of the data without cf_clearance.
function authHeaders(sessionKey: string, cookieHeader?: string | null): Record<string, string> {
  return {
    Cookie: cookieHeader || `sessionKey=${sessionKey}`,
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
  };
}

/**
 * Lists the organizations available to the authenticated account (needed to pick
 * the organizationId for the usage endpoint — a personal account usually has one, a
 * member of several workspaces may have more).
 */
export async function listOrganizations(sessionKey: string, cookieHeader?: string | null): Promise<Array<{ id: string; name: string }>> {
  if (!sessionKey) {
    throw new Error('Claude: missing sessionKey — connect the account from Settings');
  }
  const data = await fetchJson<(ClaudeOrganization | null)[] | null>(`${BASE_URL}/organizations`, {
    headers: authHeaders(sessionKey, cookieHeader),
    label: 'claude.ai/api/organizations',
  });
  if (!Array.isArray(data)) {
    throw new Error('Claude: unexpected response from /api/organizations (unrecognized format)');
  }
  // An organization without an identifier is dropped: a former `as string` cast hid
  // the undefined and the usage call ended up on /organizations/undefined.
  return data.flatMap((org) => {
    const id = org?.uuid || org?.id;
    return org && id ? [{ id, name: org.name || 'Organization' }] : [];
  });
}

/**
 * Converts the internal usage endpoint response into the QuotaWindow model shared
 * by ARCHITECTURE.md §0. The exact response format is not officially documented and
 * field names are not stable (see the comment on ClaudeUsageResponse above): instead
 * of reading by key name, a quota window is recognized by the SHAPE of its value —
 * any key with a numeric `utilization` is treated as a real window, whatever its
 * name. When an expected field is simply missing that window is not generated,
 * instead of assuming a value and showing wrong data.
 */
export function buildQuotaWindows(usage: ClaudeUsageResponse | null): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  // Different from windows.length === 0: tracks whether we recognized at least one
  // window by its shape (numeric utilization), even if it was then dropped as not
  // applicable (0%, no reset, no amount). Only when NOTHING is recognized is it a real
  // format drift — an account with no active window (e.g. all 0%/not applicable) is a
  // legitimate result, not an error.
  let recognizedAny = false;

  for (const [key, value] of Object.entries(usage ?? {})) {
    const entry = asWindow(value);
    if (!entry) continue;
    recognizedAny = true;

    const resetsAt = entry.resets_at ? new Date(entry.resets_at) : null;
    const hasDollarAmounts = typeof entry.limit_dollars === 'number' && typeof entry.used_dollars === 'number';

    // A 0% window without a reset date and without amounts cannot be told apart from a
    // "not applicable to this plan" field (seen for real: a promotional window entirely
    // null except utilization:0) — it is dropped so the widget does not show an empty,
    // meaningless row.
    if (entry.utilization === 0 && !resetsAt && !hasDollarAmounts) continue;

    const knownLabel = KNOWN_LABELS[key];
    const label = knownLabel
      ?? (hasDollarAmounts ? `Claude extra credit (${key})` : `Claude usage — undocumented window (${key})`);

    // Known historical names: we keep the explicit period verified in the past. For any
    // other key (undocumented/obfuscated name) the real window length cannot be derived
    // with certainty from the distance to the reset alone — we honestly declare
    // "billing-cycle"/unknown length instead of guessing a number that could be wrong
    // (see CLAUDE.md).
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

  // `spend` reports the same extra-usage money a dollar window already shows (personal
  // accounts): it becomes a window only when no such window exists, as on company
  // seats where it is the only data left (issue #6).
  if (usage && SPEND_KEY in usage) {
    const spend = readSpend(usage[SPEND_KEY]);
    if (spend.kind !== 'unrecognized') recognizedAny = true;
    if (spend.kind === 'window' && !windows.some((w) => w.unit === 'count')) {
      windows.push(spend.window);
    }
  }

  if (windows.length === 0 && !recognizedAny) {
    // The whole raw response is logged to the console (terminal/main-process log, never
    // the renderer): it contains no credentials, only usage percentages — it helps
    // understand the real format when it diverges from RESEARCH.md.
    console.error('[services/claude] unrecognized usage response, raw content:', JSON.stringify(usage));
    const preview = JSON.stringify(usage).slice(0, 500);
    throw new FormatDriftError(
      `Claude: no quota window recognized in the response — the internal endpoint format may have changed (see RESEARCH.md). Response received: ${preview}`,
      'claude.ai/api/organizations/{id}/usage',
      extractShape(usage),
    );
  }
  // windows.length === 0 with recognizedAny === true: shape recognized, but no
  // applicable window right now (e.g. only inactive promotional credits) — a
  // legitimate result, not an error.
  return windows;
}

export async function fetchUsage(credentials: ClaudeCredentials): Promise<RawAccountUsage> {
  const { sessionKey, planTier, cookieHeader } = credentials;
  if (!sessionKey) {
    throw new Error('Claude: missing sessionKey — connect the account from Settings');
  }

  let organizationId = credentials.organizationId;
  if (!organizationId) {
    const [firstOrg] = await listOrganizations(sessionKey, cookieHeader);
    if (!firstOrg) {
      throw new Error('Claude: no organization found for this account');
    }
    organizationId = firstOrg.id;
  }

  const usage = await fetchJson<ClaudeUsageResponse | null>(`${BASE_URL}/organizations/${organizationId}/usage`, {
    headers: authHeaders(sessionKey, cookieHeader),
    label: 'claude.ai/api/organizations/{id}/usage',
  });

  return {
    planTier: planTier || 'pro',
    // Claude does not expose the subscription billing date through this endpoint: it
    // stays a value configured by hand in Settings (account subscription).
    subscriptionRenewsAt: null,
    quotaWindows: buildQuotaWindows(usage),
    // No daily history is available from this API: the history is built locally by the
    // app, poll after poll (see main.ts + store.history).
  };
}
