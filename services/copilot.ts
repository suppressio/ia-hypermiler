// services/copilot.ts — GitHub Copilot usage fetch (see RESEARCH.md v3 §2 and ARCHITECTURE.md §0)
//
// Two paths with very different reliability:
// - PERSONAL plan: official, documented endpoint (ai_credit/usage, then
//   premium_request/usage as fallback), via PAT. When both answer 404 (observed with a
//   real Free account — see RESEARCH.md §2.1 addendum), a last attempt goes to the
//   internal endpoint below, shared with the company path.
// - COMPANY seat (org-managed): no public self-service endpoint. The only data source
//   is the undocumented internal endpoint copilot_internal/user (the same used by the
//   VS Code quota indicator) — explicitly treated as an experimental/best-effort
//   feature, it can break without notice.
//
// GitHub's billing API does not expose the plan's TOTAL quota (only consumption): the
// total stays a value configured by hand by the user (credentials.manualQuota), as
// anticipated in ARCHITECTURE.md §0.

import { fetchJson } from './_http';
import { extractShape, FormatDriftError } from './_shape';
import { githubApiBase } from './githubHost';
import type { CopilotCredentials, QuotaWindow, RawAccountUsage } from '../types/index';

const USD_PER_CREDIT = 0.01; // 1 AI credit = $0.01, see RESEARCH.md §2.1

interface GithubUserResponse {
  login?: string;
}

interface BillingUsageItem {
  netAmount?: number;
  [key: string]: unknown;
}

interface BillingUsageReport {
  // year/month/day: a single timePeriod for the whole report (not one date per item) —
  // the monthly filter happens server side through the year/month query parameters.
  usageItems?: BillingUsageItem[];
}

// Field meanings follow VS Code's own reader of this endpoint (chatEntitlementService.ts,
// getQuotaUsage — see RESEARCH.md §2.2 addendum 2026-10-01). External data: every field
// is `unknown` and narrowed.
interface CopilotInternalQuotaSnapshot {
  percent_remaining?: unknown;
  unlimited?: unknown;
  has_quota?: unknown;
  entitlement?: unknown;
  quota_remaining?: unknown;
  credits_used?: unknown;
  quota_reset_at?: unknown; // epoch seconds
}

interface CopilotInternalUserResponse {
  access_type_sku?: unknown;
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_reset_date_utc?: string;
  quota_snapshots?: Record<string, CopilotInternalQuotaSnapshot | null> | null;
}

/**
 * The account is recognized but GitHub exposes no usage data for it — observed for
 * enterprise-managed seats (access_type_sku "enterprise_managed", no quota_snapshots,
 * whatever the token type, issue #7). A known limit, not a format drift: main.ts shows
 * a translated explanation instead of opening an issue draft.
 */
export class CopilotUsageUnavailableError extends Error {
  readonly reason = 'enterpriseManagedSeat' as const;
}

const ENTERPRISE_MANAGED_SKU = 'enterprise_managed';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Resolves the GitHub username tied to the token (used on "Connect"). */
export async function resolveUsername(token: string, host: string): Promise<string> {
  if (!token) throw new Error('Copilot: missing token');
  const data = await fetchJson<GithubUserResponse | null>(`${githubApiBase(host)}/user`, {
    headers: authHeaders(token),
    label: 'api.github.com/user',
  });
  if (!data?.login) {
    throw new Error('Copilot: could not determine the username from the given token');
  }
  return data.login;
}

/**
 * Sums the consumption (in AI credits) of the usage items of a billing report.
 * The report is already filtered by year/month by the server (year/month query
 * parameters on the request): items have no date of their own, only a `netAmount` in
 * USD (net amount after discounts) — converted to AI credits (1 credit = $0.01).
 */
export function sumCreditsUsed(report: BillingUsageReport | null): number {
  const items = report?.usageItems;
  if (!Array.isArray(items)) {
    throw new FormatDriftError(
      'Copilot: unexpected response format on ai_credit/usage (no usageItems) — see RESEARCH.md',
      'users/{username}/settings/billing/ai_credit/usage',
      extractShape(report),
    );
  }
  const totalUsd = items.reduce((sum, item) => sum + (Number(item.netAmount) || 0), 0);
  return Math.round(totalUsd / USD_PER_CREDIT);
}

function httpStatus(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null ? (err as { status?: number }).status : undefined;
}

// "This billing report does not apply to this account": 404 (observed until 2026-07) or,
// since 2026-10, 400 with this exact message for accounts without their own billing
// (company seats). Any other 400 stays an error.
const BILLING_NOT_APPLICABLE_MESSAGE = 'Unable to get billing usage data';

function isBillingNotApplicable(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 404) return true;
  return status === 400 && err instanceof Error && err.message.includes(BILLING_NOT_APPLICABLE_MESSAGE);
}

/**
 * Reads the billing report for the current month. Tries `ai_credit/usage` first
 * (current endpoint, replacing the old "premium requests" model retired on 2026-06-01 —
 * see RESEARCH.md §2.1); when the report does not apply to the account (404, or since
 * 2026-10 a 400 "Unable to get billing usage data." — see isBillingNotApplicable) it
 * falls back to `premium_request/usage`, which the REST docs describe with exactly the
 * same response shape — same parsing, no duplicated logic. Any other failure (network,
 * 401/403, other 400s, …) does not trigger the fallback: it propagates at once, so a
 * credentials problem is not hidden behind a useless second attempt.
 */
async function fetchBillingUsageReport(apiBase: string, username: string, token: string, year: number, month: string): Promise<BillingUsageReport | null> {
  const headers = authHeaders(token);
  try {
    return await fetchJson<BillingUsageReport | null>(
      `${apiBase}/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage?year=${year}&month=${month}`,
      { headers, label: 'users/{username}/settings/billing/ai_credit/usage' },
    );
  } catch (err) {
    if (!isBillingNotApplicable(err)) throw err;
    return fetchJson<BillingUsageReport | null>(
      `${apiBase}/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage?year=${year}&month=${month}`,
      { headers, label: 'users/{username}/settings/billing/premium_request/usage (fallback from ai_credit/usage)' },
    );
  }
}

/**
 * Personal scope: the internal endpoint first, because it has the real quotas per
 * category (budget, remaining, reset — the same data VS Code shows), then the official
 * billing report as a fallback, which only has the month's spend in dollars against a
 * hand-entered total. Observed on 2026-10-01: an OAuth token gets the quotas, a
 * fine-grained PAT with "Plan" gets the billing report.
 */
async function fetchPersonalUsage({ apiBase, host, token, manualQuota, now }: { apiBase: string; host: string; token: string; manualQuota: number | null | undefined; now: Date }): Promise<RawAccountUsage> {
  let internal: RawAccountUsage | null = null;
  let internalError: Error | null = null;
  try {
    internal = await fetchCopilotInternalUsage(apiBase, token, 'personal plan');
  } catch (err) {
    internalError = err instanceof Error ? err : new Error(String(err));
  }
  if (internal && internal.quotaWindows.length > 0) return internal;

  try {
    return await fetchBillingUsage({ apiBase, host, token, manualQuota, now });
  } catch (err) {
    // A recognized internal answer with nothing to show (e.g. a Free plan with no
    // premium allotment) is a legitimate result, whatever the billing report says.
    if (internal) return internal;
    // Neither source applies to this account: the internal error says why (enterprise-
    // managed seat, format drift). Any other billing error (401/403, network) wins: it
    // is about the token, not the account.
    if (isBillingNotApplicable(err) && internalError !== null) throw internalError;
    throw err;
  }
}

async function fetchBillingUsage({ apiBase, host, token, manualQuota, now }: { apiBase: string; host: string; token: string; manualQuota: number | null | undefined; now: Date }): Promise<RawAccountUsage> {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const username = await resolveUsername(token, host);
  const report = await fetchBillingUsageReport(apiBase, username, token, year, month);
  const used = sumCreditsUsed(report);

  return {
    planTier: null, // filled in by the caller from the store, not derivable from the response
    subscriptionRenewsAt: null,
    quotaWindows: [
      {
        id: 'ai_credits',
        label: 'AI credits',
        periodType: 'billing-cycle',
        periodLength: 1, // the billing report covers the current calendar month
        unit: 'count',
        used,
        total: typeof manualQuota === 'number' ? manualQuota : null,
        resetsAt: null,
      },
    ],
  };
}

/**
 * Undocumented internal endpoint powering the VS Code quota indicator, for any kind
 * of Copilot account (not only company seats — see RESEARCH.md §2.2). No guarantee of
 * stability or of compatibility with a standard PAT (VS Code uses a Copilot token
 * obtained through its own authentication flow, not necessarily a generic PAT). A
 * 401/403 here is expected: it means the token is not accepted by this internal
 * endpoint.
 */
async function fetchCopilotInternalUsage(apiBase: string, token: string, context: string): Promise<RawAccountUsage> {
  let data: CopilotInternalUserResponse | null;
  try {
    data = await fetchJson<CopilotInternalUserResponse | null>(`${apiBase}/copilot_internal/user`, {
      headers: authHeaders(token),
      label: 'copilot_internal/user (unofficial internal endpoint)',
    });
  } catch (err) {
    throw new Error(
      `Copilot (${context}, best-effort): call failed — ${err instanceof Error ? err.message : String(err)}. ` +
      'This endpoint is not official: it may require a Copilot token different from a standard PAT. See RESEARCH.md.',
      { cause: err },
    );
  }

  if (!data?.quota_snapshots) {
    if (data?.access_type_sku === ENTERPRISE_MANAGED_SKU) {
      throw new CopilotUsageUnavailableError(
        `Copilot (${context}): GitHub exposes no usage data for enterprise-managed seats (no quota_snapshots) — see RESEARCH.md §2.2`,
      );
    }
    throw new FormatDriftError(
      `Copilot (${context}, best-effort): response without quota_snapshots — format changed or token not valid for this endpoint`,
      'copilot_internal/user',
      extractShape(data),
    );
  }

  const fallbackReset = data.quota_reset_date_utc || data.quota_reset_date;
  const windows: QuotaWindow[] = [];
  let recognizedAny = false;
  for (const [key, entry] of Object.entries(data.quota_snapshots)) {
    const reading = readQuotaSnapshot(key, entry, fallbackReset ? new Date(fallbackReset) : null);
    if (reading.kind === 'unrecognized') continue;
    recognizedAny = true;
    if (reading.kind === 'window') windows.push(reading.window);
  }

  if (!recognizedAny) {
    throw new FormatDriftError(
      `Copilot (${context}, best-effort): no quota window recognized in the response`,
      'copilot_internal/user',
      extractShape(data.quota_snapshots),
    );
  }

  return {
    planTier: data.copilot_plan || null,
    subscriptionRenewsAt: data.quota_reset_date ? new Date(data.quota_reset_date) : null,
    quotaWindows: windows,
  };
}

type SnapshotReading =
  | { kind: 'unrecognized' }
  | { kind: 'empty' }
  | { kind: 'window'; window: QuotaWindow };

/**
 * One quota snapshot → one window, with VS Code's rules (getQuotaUsage):
 * - unlimited: only "credits used" (no denominator), nothing when has_quota is false or
 *   credits_used is missing (nor, here, when it is 0);
 * - entitlement > 0: used = entitlement − quota_remaining (or derived from
 *   percent_remaining), out of the entitlement;
 * - entitlement 0: nothing allocated for this category;
 * - otherwise the percentage, as before token-based billing.
 */
function readQuotaSnapshot(key: string, entry: CopilotInternalQuotaSnapshot | null | undefined, fallbackReset: Date | null): SnapshotReading {
  if (!entry || typeof entry.percent_remaining !== 'number') return { kind: 'unrecognized' };
  const percentRemaining = Math.min(100, Math.max(0, entry.percent_remaining));
  const resetsAt = typeof entry.quota_reset_at === 'number' && entry.quota_reset_at > 0
    ? new Date(entry.quota_reset_at * 1000)
    : fallbackReset;
  // Monthly quotas: periodLength 1 (month) enables pacing up to resetsAt.
  const base = { id: key, label: `Copilot — ${key}`, periodType: 'billing-cycle' as const, periodLength: 1, resetsAt };

  if (entry.unlimited === true) {
    // Unlike VS Code, an unlimited category with zero credits is not shown: on a company
    // seat chat and completions are always unlimited and would only add empty rows.
    if (entry.has_quota === false || typeof entry.credits_used !== 'number' || entry.credits_used <= 0) return { kind: 'empty' };
    return { kind: 'window', window: { ...base, unit: 'count', used: entry.credits_used, total: null } };
  }
  if (entry.entitlement === 0) return { kind: 'empty' };
  if (typeof entry.entitlement === 'number' && entry.entitlement > 0) {
    const total = entry.entitlement;
    const used = typeof entry.quota_remaining === 'number'
      ? total - entry.quota_remaining
      : total * (100 - percentRemaining) / 100;
    return { kind: 'window', window: { ...base, unit: 'count', used: Math.max(0, used), total } };
  }
  return {
    kind: 'window',
    window: { ...base, unit: 'percentage', used: Math.round((100 - percentRemaining) * 10) / 10, total: null },
  };
}

async function fetchOrgManagedUsage({ apiBase, token }: { apiBase: string; token: string }): Promise<RawAccountUsage> {
  return fetchCopilotInternalUsage(apiBase, token, 'company seat');
}

export async function fetchUsage(credentials: CopilotCredentials): Promise<RawAccountUsage> {
  const { token, accountScope, manualQuota, host } = credentials;
  if (!token) {
    throw new Error('Copilot: missing token — connect the account from Settings');
  }
  // Throws on an unsupported host before any request: the token goes only to GitHub.
  const apiBase = githubApiBase(host);

  const now = new Date();
  if (accountScope === 'organization') {
    return fetchOrgManagedUsage({ apiBase, token });
  }
  return fetchPersonalUsage({ apiBase, host, token, manualQuota, now });
}
