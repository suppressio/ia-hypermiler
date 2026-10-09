// When to fetch an account and when to run the next refresh (issue: the instant gauge
// lagged up to 30 minutes behind real use, the providers update their counters within
// minutes). Pure functions, no Electron: the timers and the per-account state live in
// main.ts.
//
// - While consumption rises, the next refresh comes after FAST_REFRESH_MS instead of
//   the configured interval; the first refresh without a rise goes back to it.
// - Per-account backoff: every consecutive failed fetch doubles the minimum gap
//   between two fetches of that account (5 → 10 → 20 min…), never beyond the
//   configured interval. The endpoints read are internal (claude.ai behind Cloudflare,
//   copilot_internal): a faster pace must never insist on a provider that pushes back.
// - A manual refresh within MANUAL_REFRESH_CACHE_MS of the last fetch reuses that
//   result (the widget also asks for one every time it is recreated).

export const FAST_REFRESH_MS = 5 * 60 * 1000;
export const MANUAL_REFRESH_CACHE_MS = 60 * 1000;
// Timers fire a little early or late: a scheduled tick right at the gap still fetches.
const SCHEDULE_TOLERANCE_MS = 15 * 1000;

/**
 * Why a refresh runs:
 * - `scheduled`: the timer — the per-account backoff applies;
 * - `manual`: the refresh button, the tray, the widget opening — short cache only;
 * - `forced`: after a login or a settings change — always fetches.
 */
export type RefreshMode = 'scheduled' | 'manual' | 'forced';

export interface AccountFetchState {
  lastAttemptAt: number;
  failures: number;
}

const MODE_STRENGTH: Record<RefreshMode, number> = { scheduled: 0, manual: 1, forced: 2 };

/** The stronger of two requested modes (a queued refresh keeps the stronger one). */
export function strongerMode(a: RefreshMode, b: RefreshMode): RefreshMode {
  return MODE_STRENGTH[a] >= MODE_STRENGTH[b] ? a : b;
}

/** Minimum gap between two fetches of one account, from its consecutive failures. */
export function minFetchGapMs(failures: number, intervalMs: number): number {
  return Math.min(intervalMs, FAST_REFRESH_MS * 2 ** Math.max(0, failures));
}

/** Whether an account is fetched in this refresh, or its last result is reused. */
export function shouldFetchAccount(
  state: AccountFetchState | undefined,
  mode: RefreshMode,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (!state || mode === 'forced') return true;
  const elapsed = nowMs - state.lastAttemptAt;
  if (mode === 'manual') return elapsed >= MANUAL_REFRESH_CACHE_MS;
  return elapsed >= minFetchGapMs(state.failures, intervalMs) - SCHEDULE_TOLERANCE_MS;
}

/** State after a fetch attempt: failures reset on success, counted on failure. */
export function recordFetchAttempt(state: AccountFetchState | undefined, nowMs: number, ok: boolean): AccountFetchState {
  return { lastAttemptAt: nowMs, failures: ok ? 0 : (state?.failures ?? 0) + 1 };
}

/** Delay before the next scheduled refresh: fast while consumption rises. */
export function nextRefreshDelayMs(consumptionRose: boolean, intervalMs: number): number {
  return consumptionRose ? Math.min(FAST_REFRESH_MS, intervalMs) : intervalMs;
}
