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
import type { CopilotCredentials, QuotaWindow, RawAccountUsage } from '../types/index';

const API_BASE = 'https://api.github.com';
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

interface CopilotInternalQuotaSnapshot {
  percent_remaining?: number;
  [key: string]: unknown;
}

interface CopilotInternalUserResponse {
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_snapshots?: Record<string, CopilotInternalQuotaSnapshot | null> | null;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Resolves the GitHub username tied to the token (used on "Connect"). */
export async function resolveUsername(token: string): Promise<string> {
  if (!token) throw new Error('Copilot: missing token');
  const data = await fetchJson<GithubUserResponse | null>(`${API_BASE}/user`, {
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

function isHttp404(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 404;
}

/**
 * Reads the billing report for the current month. Tries `ai_credit/usage` first
 * (current endpoint, replacing the old "premium requests" model retired on 2026-06-01 —
 * see RESEARCH.md §2.1); on 404 (observed with a real account, cause not yet clear:
 * non-uniform endpoint rollout or account without its own personal plan) it falls back
 * to `premium_request/usage`, which the REST docs describe with exactly the same
 * response shape — same parsing, no duplicated logic. A non-404 failure (network,
 * 401/403, …) does not trigger the fallback: it propagates at once, so a credentials
 * problem is not hidden behind a useless second attempt.
 */
async function fetchBillingUsageReport(username: string, token: string, year: number, month: string): Promise<BillingUsageReport | null> {
  const headers = authHeaders(token);
  try {
    return await fetchJson<BillingUsageReport | null>(
      `${API_BASE}/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage?year=${year}&month=${month}`,
      { headers, label: 'users/{username}/settings/billing/ai_credit/usage' },
    );
  } catch (err) {
    if (!isHttp404(err)) throw err;
    return fetchJson<BillingUsageReport | null>(
      `${API_BASE}/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage?year=${year}&month=${month}`,
      { headers, label: 'users/{username}/settings/billing/premium_request/usage (fallback from ai_credit/usage 404)' },
    );
  }
}

async function fetchPersonalUsage({ token, manualQuota, now }: { token: string; manualQuota: number | null | undefined; now: Date }): Promise<RawAccountUsage> {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const username = await resolveUsername(token);

  try {
    const report = await fetchBillingUsageReport(username, token, year, month);
    const used = sumCreditsUsed(report);

    return {
      planTier: null, // filled in by the caller from the store, not derivable from the response
      subscriptionRenewsAt: null,
      quotaWindows: [
        {
          id: 'ai_credits',
          label: 'AI credits',
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
    // Both ai_credit/usage and premium_request/usage answered 404 (observed with a real
    // personal Free account — see RESEARCH.md §2.1 addendum — although the
    // github.com/settings/billing page of the same account shows real "Included credits"
    // consumption: these official REST endpoints evidently do not cover it for this kind
    // of plan). Last attempt: the same undocumented internal endpoint already used for
    // company seats (RESEARCH.md §2.2) — it powers the VS Code quota indicator for ANY
    // Copilot account, not only company ones, so it might work here too.
    return fetchCopilotInternalUsage(token, 'personal plan, internal fallback');
  }
}

/**
 * Undocumented internal endpoint powering the VS Code quota indicator, for any kind
 * of Copilot account (not only company seats — see RESEARCH.md §2.2). No guarantee of
 * stability or of compatibility with a standard PAT (VS Code uses a Copilot token
 * obtained through its own authentication flow, not necessarily a generic PAT). A
 * 401/403 here is expected: it means the token is not accepted by this internal
 * endpoint.
 */
async function fetchCopilotInternalUsage(token: string, context: string): Promise<RawAccountUsage> {
  let data: CopilotInternalUserResponse | null;
  try {
    data = await fetchJson<CopilotInternalUserResponse | null>(`${API_BASE}/copilot_internal/user`, {
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
    throw new FormatDriftError(
      `Copilot (${context}, best-effort): response without quota_snapshots — format changed or token not valid for this endpoint`,
      'copilot_internal/user',
      extractShape(data),
    );
  }

  const windows: QuotaWindow[] = [];
  for (const [key, entry] of Object.entries(data.quota_snapshots)) {
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

async function fetchOrgManagedUsage({ token }: { token: string }): Promise<RawAccountUsage> {
  return fetchCopilotInternalUsage(token, 'company seat');
}

export async function fetchUsage(credentials: CopilotCredentials): Promise<RawAccountUsage> {
  const { token, accountScope, manualQuota } = credentials;
  if (!token) {
    throw new Error('Copilot: missing token — connect the account from Settings');
  }

  const now = new Date();
  if (accountScope === 'organization') {
    return fetchOrgManagedUsage({ token });
  }
  return fetchPersonalUsage({ token, manualQuota, now });
}
