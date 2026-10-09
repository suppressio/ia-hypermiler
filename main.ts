// main.ts — Electron main process
// Day 2, Session 1: real data from services/claude.ts and services/copilot.ts instead
// of the Day 1 mock. When a fetch fails, the last known data is shown with its
// timestamp (never a blank screen, see CLAUDE.md).

import { app, dialog, ipcMain, BrowserWindow, Notification, shell, Menu, screen, utilityProcess } from 'electron';
import store, { DEFAULTS } from './store/index';
import { normalizeSettings } from './store/normalize';
import { isPlainRecord } from './store/merge';
import { createMainWindow, createSettingsWindow } from './main/windows';
import { createTray } from './main/tray';
import { captureClaudeSession, buildClaudeCookieHeader, migrateDefaultSessionCookies } from './main/claude-auth';
import { captureGithubOAuthToken } from './main/copilot-oauth';
import * as providers from './main/providers';
import * as refreshPolicy from './main/refreshPolicy';
import type { AccountFetchState, RefreshMode } from './main/refreshPolicy';
import { defaultAccountFor, enforceSingleLocalInsights, nextAccountLabel, normalizeAccounts } from './store/migrate';
import * as budget from './budget';
import * as claudeService from './services/claude';
import * as copilotService from './services/copilot';
import path from 'path';
import { fetchLatestUpdate, guideUrl, TRUSTED_DOWNLOAD_PREFIX } from './services/updates';
import { DEFAULT_GITHUB_HOST, normalizeGithubHost } from './services/githubHost';
import type { TrayHandle } from './main/tray';
import { FormatDriftError, shapeSignature } from './services/_shape';
import { buildFormatDriftIssueUrl, buildReportIssueUrl } from './diagnostics/githubIssue';
import { buildDiagnosticReport, neutralize } from './diagnostics/report';
import type { ReportAccount } from './diagnostics/report';
import { LogBuffer, captureConsole } from './diagnostics/logBuffer';
import os from 'os';
import { writeFile } from 'fs/promises';
import { formatNumber, getLocale, resolveLocale, setLocale, t } from './main/i18n/index';
import { randomUUID } from 'crypto';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  AccountConfig,
  AccountId,
  AccountSnapshot,
  AppSettings,
  ClaudeLocalInsights,
  DailyUsagePoint,
  ProviderId,
  UpdateSettings,
  QuotaWindow,
  QuotaWindowSnapshot,
  RawAccountUsage,
  RecentUsageSample,
  RenewalRule,
  UsageSnapshot,
  WorkSchedule,
  WindowStyle,
} from './types/index';

const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes, as per CLAUDE.md
// New-version check (issue #5): at startup (with a short delay, not to overlap
// the first usage refresh) and then every 24 hours.
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_FIRST_CHECK_DELAY_MS = 10 * 1000;
// Local insights recomputation (services/claudeLocalSessions.ts): more expensive
// than a regular refresh (scanning files on disk, not a network poll), no need to do
// it on every 30-minute refresh — cached with this minimum interval, same pattern as
// advisorCache.
const LOCAL_INSIGHTS_RECOMPUTE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Promises launched "in the background" (timers, fire-and-forget IPC, after an IPC
// reply was already sent): never an unhandled rejection, which Node would log without
// context or, worse, would leave the app half-way with no trace (CLAUDE.md: never
// silent failures).
function runDetached(label: string, task: Promise<unknown>): void {
  task.catch((err: unknown) => {
    console.error(`[main] ${label} failed:`, err);
  });
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
// Last snapshot sent to the widget: the diagnostic report shows how the app read the data.
let lastSnapshot: UsageSnapshot | null = null;

// Last main-process errors/warnings, in memory only, for the diagnostic report: an
// installed app has no visible console (diagnostics/logBuffer.ts).
const logBuffer = new LogBuffer(50);
captureConsole(logBuffer);

// Durations of the last refresh and of the last local insights scan, for the
// diagnostic report (a slow startup had to be inferred before).
const timings: { lastRefresh: { at: string; ms: number } | null; lastLocalInsights: { at: string; ms: number } | null } = {
  lastRefresh: null,
  lastLocalInsights: null,
};
let refreshTimer: NodeJS.Timeout | null = null;
// Whether the last refresh that fetched something saw consumption rise (fast pace).
let lastConsumptionRose = false;
let hoverPollTimer: NodeJS.Timeout | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let trayHandle: TrayHandle | null = null;
let lastHoverState = false;

// ---------------------------------------------------------------------------
// Window hover detection for the "auto-hiding" title bar/buttons (user feedback):
// a pure CSS :hover, and even mouseover/mouseout on the document, do not fire
// reliably over the -webkit-app-region:drag strip, because the OS treats it as a
// non-client area (like a native title bar) and captures the mouse for dragging
// instead of dispatching regular DOM events — with that technique the bar vanished
// exactly while hovering it. The reliable fix queries the cursor position in the main
// process (always available via screen.getCursorScreenPoint(), independent of the
// renderer's event dispatch), compares it with the window bounds and sends only state
// changes to the renderer via IPC.
// ---------------------------------------------------------------------------
function startWindowHoverPolling(): void {
  if (hoverPollTimer) clearInterval(hoverPollTimer);
  hoverPollTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const isOver =
      cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    if (isOver !== lastHoverState) {
      lastHoverState = isOver;
      mainWindow.webContents.send('window:hoverChanged', isOver);
    }
  }, 120);
}

function configuredRefreshIntervalMs(): number {
  const intervalMinutes = store.get('ui').refreshIntervalMinutes || DEFAULT_REFRESH_INTERVAL_MS / (60 * 1000);
  return Math.max(5, intervalMinutes) * 60 * 1000;
}

// One timer, re-armed after every refresh (main/refreshPolicy.ts): the configured
// interval, or the fast pace while consumption rises.
function scheduleNextRefresh(delayMs: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { runDetached('refresh usage', refreshAndBroadcast('scheduled')); }, delayMs);
}

// Startup, a settings change (new interval) or a failed refresh: the pace stays fast
// if the last refresh saw consumption rise.
function scheduleRefreshLoop(): void {
  scheduleNextRefresh(refreshPolicy.nextRefreshDelayMs(lastConsumptionRose, configuredRefreshIntervalMs()));
}

// ---------------------------------------------------------------------------
// Local history: neither Claude nor Copilot provides a daily history via API (see
// RESEARCH.md), so we build it ourselves, one point per day, on every successful
// refresh.
// ---------------------------------------------------------------------------
// The store is encrypted and electron-store re-reads and decrypts the whole file on
// every get (and re-encrypts and writes it on every set), synchronously on the main
// thread: one get/set pair per window per refresh could block the app for seconds on a
// slower machine (the Settings window stayed blank). A refresh therefore works on an
// in-memory draft of the history, read once and written once (commitHistoryDraft).
interface HistoryDraft {
  dailyUsage: DailyUsagePoint[];
  recentSamples: RecentUsageSample[];
  chartDays: number;
}

function openHistoryDraft(): HistoryDraft {
  const history = store.get('history');
  return {
    dailyUsage: history.dailyUsage,
    recentSamples: history.recentSamples,
    chartDays: store.get('ui').chartRange === 'month' ? 30 : 7,
  };
}

// Samples are kept for the whole current day (the working span comes from the day's
// samples, budget.todayActivitySpan) and at least this long (margin above the 1h
// lookback of budget.instantaneousRate and its anchor, also right after midnight).
// Still small: one append per fetch, every 5 min at most while consumption rises.
const RECENT_SAMPLES_MIN_AGE_MS = 4 * 60 * 60 * 1000;

// Prunes and writes the draft in a single store write. The rest of `history` is read
// again here, so what was written meanwhile (lastGood, during the fetches) is kept.
function commitHistoryDraft(draft: HistoryDraft, now: Date): void {
  const history = store.get('history');
  const dailyCutoff = new Date(now);
  dailyCutoff.setDate(dailyCutoff.getDate() - history.retentionDays);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sampleCutoff = Math.min(startOfToday, now.getTime() - RECENT_SAMPLES_MIN_AGE_MS);
  store.set('history', {
    ...history,
    dailyUsage: draft.dailyUsage.filter((h) => new Date(h.date) >= dailyCutoff),
    recentSamples: draft.recentSamples.filter((s) => new Date(s.timestamp).getTime() >= sampleCutoff),
  });
}

// Returns today's point (with its baseline and first activity, see
// budget.updateDailyPoint), or null when utilization cannot be computed.
function recordDailyUsage(draft: HistoryDraft, accountId: AccountId, window: QuotaWindow, periodStart: Date, now: Date): DailyUsagePoint | null {
  const utilization = budget.normalizedUtilization(window);
  if (utilization === null) return null;

  const todayKey = budget.localDateKey(now);
  const history = draft.dailyUsage;
  const own = history
    .filter((h) => h.accountId === accountId && h.windowId === window.id)
    .sort((a, b) => a.date.localeCompare(b.date));
  // First point stored with the wrong baseline on the period start day (see
  // budget.repairFirstDayBaseline): fixed in place before today's point is computed.
  const repaired = budget.repairFirstDayBaseline(own, periodStart);
  if (repaired) {
    const at = history.findIndex((h) => h.date === repaired.date && h.accountId === accountId && h.windowId === window.id);
    if (at >= 0) history[at] = repaired;
    const ownAt = own.findIndex((h) => h.date === repaired.date);
    if (ownAt >= 0) own[ownAt] = repaired;
  }
  const today = own.find((h) => h.date === todayKey);
  const previous = own.filter((h) => h.date < todayKey).at(-1);
  // Same rounding as the recent samples (recordRecentSample): a baseline rounded to 0.1
  // against samples rounded to 0.01 read as activity (budget.todayActivitySpan).
  const entry = budget.updateDailyPoint({
    today, previous, accountId, windowId: window.id, used: Math.round(utilization * 100) / 100, periodStart, now,
  });
  const idx = history.findIndex((h) => h.date === todayKey && h.accountId === accountId && h.windowId === window.id);
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);
  return entry;
}

function getDailyHistory(draft: HistoryDraft, accountId: AccountId, windowId: string, days: number): DailyUsagePoint[] {
  return draft.dailyUsage
    .filter((h) => h.accountId === accountId && h.windowId === windowId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days);
}

function recordRecentSample(draft: HistoryDraft, accountId: AccountId, window: QuotaWindow, now: Date): void {
  const utilization = budget.normalizedUtilization(window);
  if (utilization === null) return;
  draft.recentSamples.push({ timestamp: now.toISOString(), accountId, windowId: window.id, used: Math.round(utilization * 100) / 100 });
}

function getRecentSamples(draft: HistoryDraft, accountId: AccountId, windowId: string): RecentUsageSample[] {
  return draft.recentSamples
    .filter((s) => s.accountId === accountId && s.windowId === windowId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ---------------------------------------------------------------------------
// Local insights from Claude Code sessions (services/claudeLocalSessions.ts, see
// RESEARCH.md §5): opt-in per account (ClaudeAccountSettings.localInsights, at most
// one Claude account — the caller decides which), cached because more expensive than
// a regular refresh (scanning files on disk, not a network poll) — recomputed at most
// every LOCAL_INSIGHTS_RECOMPUTE_INTERVAL_MS.
// ---------------------------------------------------------------------------
// The scan runs in an Electron utility process (services/claudeLocalSessions.worker.ts):
// parsing the session files on the main process could freeze the app for seconds at
// startup with many or long sessions. A stale cache is shown meanwhile and the widget refreshed
// once the new result arrives; with no usable cache the refresh waits for it.
// Analysis window = the view chosen for the chart (7/30 days, +1 day as for the
// daily deltas): insights, yield and chart look at the same period.
const LOCAL_INSIGHTS_TIMEOUT_MS = 2 * 60 * 1000;
let localInsightsRunning: Promise<ClaudeLocalInsights | null> | null = null;

async function computeLocalInsightsIfNeeded(): Promise<ClaudeLocalInsights | null> {
  const windowDays = (store.get('ui').chartRange === 'month' ? 30 : 7) + 1;
  const cached = store.get('localInsightsCache').claudeCode;
  const cacheAgeMs = cached ? Date.now() - new Date(cached.computedAt).getTime() : Infinity;
  // Previous cache without `daily` (before point 4) or `firstSessionStartByDay`, or for
  // another window: recompute.
  const usable = cached !== null && Array.isArray(cached.daily) && cached.firstSessionStartByDay !== undefined
    && typeof cached.totalOutputTokens === 'number'
    && typeof cached.highContextOutputTokens === 'number'
    && typeof cached.longSessionOutputTokens === 'number'
    && cached.windowDays === windowDays;
  if (usable && cacheAgeMs < LOCAL_INSIGHTS_RECOMPUTE_INTERVAL_MS) return cached;

  const running = localInsightsRunning ?? startLocalInsights(windowDays, usable);
  return usable ? cached : running;
}

function startLocalInsights(windowDays: number, refreshWhenDone: boolean): Promise<ClaudeLocalInsights | null> {
  const cached = store.get('localInsightsCache').claudeCode;
  const startedAt = Date.now();
  localInsightsRunning = computeLocalInsightsInProcess(windowDays)
    .then((result) => {
      timings.lastLocalInsights = { at: new Date().toISOString(), ms: Date.now() - startedAt };
      store.set('localInsightsCache.claudeCode', result);
      // The refresh that started this used the stale cache: show the new insights.
      if (refreshWhenDone) runDetached('refresh usage', refreshAndBroadcast('manual'));
      return result;
    })
    .catch((err: unknown) => {
      // Never block the account refresh because of a problem with the optional local
      // source: log it and fall back to the last valid cache (even if expired), if any.
      console.error('[main] Claude Code local insights computation failed:', err instanceof Error ? err.message : String(err));
      return cached;
    })
    .finally(() => { localInsightsRunning = null; });
  return localInsightsRunning;
}

function computeLocalInsightsInProcess(windowDays: number): Promise<ClaudeLocalInsights | null> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'services', 'claudeLocalSessions.worker.js'), [], {
      serviceName: 'IA Hypermiler local insights',
    });
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      action();
    };
    const timer = setTimeout(() => { settle(() => { reject(new Error('local insights: timed out')); }); }, LOCAL_INSIGHTS_TIMEOUT_MS);
    child.once('message', (message: unknown) => {
      settle(() => {
        if (isPlainRecord(message) && message.ok === true) resolve((message.result ?? null) as ClaudeLocalInsights | null);
        else reject(new Error(`local insights: ${isPlainRecord(message) && typeof message.message === 'string' ? message.message : 'invalid reply'}`));
      });
    });
    child.once('exit', (code) => { settle(() => { reject(new Error(`local insights: process exited (${String(code)})`)); }); });
    child.postMessage({ windowDays });
  });
}

// ---------------------------------------------------------------------------
// Period bounds for efficiency/projection/reset:
// - the period end is the window's own resetsAt when it has one (Claude rolling
//   windows, Copilot quotas and billing report), then the renewal date reported by
//   the provider (subscriptionRenewsAt), and only then the renewal day entered by hand
//   (renewalRule — e.g. the Claude spend limit, which carries no date);
// - the period start subtracts the window length from the end: hours or days for
//   rolling windows, calendar months for a billing cycle (months differ in length).
// NOTE: for Claude's "five_hour" window the day/half-day granularity of budget.ts is
// too coarse for a truly meaningful efficiency — the value stays consistent, but it
// should be read mostly as a current indicator, not as reliable pacing on such a short
// window.
// ---------------------------------------------------------------------------
function resolvePeriodBounds(
  criticalWindow: QuotaWindow | null,
  subscription: { renewalRule: RenewalRule },
  providerRenewsAt: Date | string | null,
  now: Date,
): { periodStart: Date; periodEnd: Date } {
  const providerEnd = criticalWindow?.resetsAt ?? providerRenewsAt;
  const periodEnd = providerEnd
    ? new Date(providerEnd)
    : budget.resolveRenewalDate(subscription.renewalRule, now);
  if (criticalWindow && criticalWindow.periodType !== 'billing-cycle') {
    const spanMs = criticalWindow.periodType === 'rolling-hours'
      ? (criticalWindow.periodLength ?? 0) * 3600 * 1000
      : (criticalWindow.periodLength ?? 0) * 24 * 3600 * 1000;
    return { periodStart: new Date(periodEnd.getTime() - spanMs), periodEnd };
  }
  const periodStart = new Date(periodEnd);
  periodStart.setMonth(periodStart.getMonth() - (criticalWindow?.periodLength ?? 1));
  return { periodStart, periodEnd };
}

// Below this many working units elapsed, projection and autonomy are extrapolated from
// too little data: the widget marks them as a preliminary estimate.
const PRELIMINARY_WORKING_UNITS = 2;

function computeWindowSnapshot(
  draft: HistoryDraft,
  accountId: AccountId,
  window: QuotaWindow,
  subscription: { renewalRule: RenewalRule },
  providerRenewsAt: Date | string | null,
  workSchedule: WorkSchedule,
  now: Date,
  localInsights: ClaudeLocalInsights | null,
  fresh: boolean,
): QuotaWindowSnapshot {
  const { periodStart, periodEnd } = resolvePeriodBounds(window, subscription, providerRenewsAt, now);
  const todayPoint = recordDailyUsage(draft, accountId, window, periodStart, now);
  // Only a value just read from the provider is a sample: last known data repeated
  // after a failed or skipped fetch would flatten the instant pace.
  if (fresh) recordRecentSample(draft, accountId, window, now);
  const { chartDays } = draft;
  // chartDays + 1 points: N+1 cumulative values are needed for N daily deltas
  // (consumption-per-day chart and rating) — the rating used to see only N-1.
  const dailyHistory = getDailyHistory(draft, accountId, window.id, chartDays + 1);
  const recentSamples = getRecentSamples(draft, accountId, window.id);

  const pacingAvailable = budget.hasPacing(window);
  const totalPeriodWorkingUnits = budget.workingUnitsBetween(periodStart, periodEnd, workSchedule);
  const isRollingHours = window.periodType === 'rolling-hours';
  // Same gate as the rating: on a window of a few hours a "daily" delta spans several
  // resets and measures nothing. Without pacing the deltas remain, but with no ideal
  // share (idealShare null).
  const dailyDeltasForWindow = isRollingHours
    ? []
    : budget.dailyDeltas(dailyHistory, workSchedule, pacingAvailable ? totalPeriodWorkingUnits : 0);
  // Actual working hours: today's span from the first to the last increase among the
  // day's samples, started earlier by today's first local Claude Code session when
  // known (budget.todayActivitySpan); the recent pace sharpens projection and autonomy
  // (budget.recentPacePerUnit).
  const sessionStartIso = localInsights?.firstSessionStartByDay?.[budget.localDateKey(now)];
  const span = budget.todayActivitySpan(
    recentSamples, todayPoint?.dayStartUsed ?? null, now, sessionStartIso ? new Date(sessionStartIso) : null,
  );
  const workedHours = span ? (span.end.getTime() - span.start.getTime()) / (3600 * 1000) : null;
  const todayElapsedUnits = budget.todayElapsedUnits(now, workedHours, workSchedule);
  const ctx = {
    window, workSchedule, periodStart, periodEnd, now, todayElapsedUnits,
    recentPacePerUnit: budget.recentPacePerUnit(dailyDeltasForWindow, workSchedule, now),
  };
  // The star rating is based on daily deltas over a window of `chartDays` days (7/30,
  // the same view chosen by the user for the chart — consistency between indicators): it
  // makes no sense for a window renewing every few hours (e.g. Claude's "five_hour", see
  // the note above resolvePeriodBounds) — there the consumption of "one day" can span
  // several resets, so an ideal/actual daily ratio is no longer meaningful. In that case
  // only the %/h gauge remains (instantRate/sustainableRate below), consistent at any
  // time scale.
  const ratingAvailable = pacingAvailable && window.periodType !== 'rolling-hours';

  // A window of a few hours is read in hours (budget.hourlyOutlook): the working-day
  // metrics (days to reset, autonomy in days, "preliminary") mean nothing there.
  const instantRate = budget.instantaneousRate(recentSamples, now);
  const hourly = isRollingHours ? budget.hourlyOutlook(window, now, instantRate) : null;
  const efficiencyIndex = pacingAvailable && !isRollingHours ? budget.efficiencyIndex(ctx) : null;
  const projectedUsage = isRollingHours
    ? hourly?.projectedAtReset ?? null
    : pacingAvailable ? budget.projectedUsage(ctx) : null;
  const daysUntilReset = isRollingHours ? null : budget.daysUntilReset(periodEnd, now);
  const workingDaysUntilReset = isRollingHours ? null : budget.workingDaysUntilReset(periodEnd, workSchedule, now, todayElapsedUnits);
  const estimatedAutonomyWorkingDays = pacingAvailable && !isRollingHours ? budget.estimatedAutonomyWorkingDays(ctx) : null;
  // Not gated by pacingAvailable when the window has its own resetsAt: knowing the
  // reset is enough, even with an unknown period start (e.g. one-off credits) — see
  // budget.sustainableHourlyRate. Without one, the renewal-rule period end is used
  // only for windows known to follow the billing cycle (pacingAvailable). Spread over
  // the remaining WORKING hours (not on the 5-hour window): working units × hours per
  // day also with the schedule disabled, where every day is a working day — over 24
  // calendar hours a day the target was several times below any pace measured while
  // working, so the gauge was always red.
  const workingHoursLeft = isRollingHours
    ? null
    : budget.remainingWorkingUnits(periodEnd, now, workSchedule, todayElapsedUnits) * workSchedule.hoursPerDay;
  const sustainableRate = budget.sustainableHourlyRate(window, window.resetsAt ?? (pacingAvailable ? periodEnd : null), now, workingHoursLeft);
  const efficiencyRating = ratingAvailable
    ? budget.efficiencyRating(dailyHistory, workSchedule, totalPeriodWorkingUnits, now, chartDays)
    : null;
  // Value per token (EVOLUTION.md point 4): only when the account has local insights
  // enabled — crosses tokens per day with this window's deltas.
  const localDaily = localInsights?.daily ?? null;
  const todayBudget = pacingAvailable && !isRollingHours
    ? budget.todayBudget(ctx, todayPoint?.dayStartUsed ?? null)
    : null;
  // The remaining quota redistributed per working day: the verdict and the hint under
  // today's budget rest on it (same scope as todayBudget: no daily budget on rolling hours).
  const redistribution = pacingAvailable && !isRollingHours ? budget.redistributedQuota(ctx) : null;
  const preliminary = pacingAvailable && !isRollingHours
    && budget.elapsedWorkingUnits(periodStart, periodEnd, now, workSchedule, todayElapsedUnits) < PRELIMINARY_WORKING_UNITS;
  const pacePerUnit = pacingAvailable && !isRollingHours ? budget.currentPacePerUnit(ctx) : null;

  return {
    window,
    dailyHistory,
    // Not on rolling-hours windows (no daily reading there, see dailyDeltasForWindow).
    chart: isRollingHours ? [] : budget.chartDays({
      dailyHistory, workSchedule, periodStart, periodEnd, now, todayBudget, redistribution,
      totalPeriodWorkingUnits: pacingAvailable ? totalPeriodWorkingUnits : 0,
      pastDays: chartDays,
      upcomingDays: chartDays === 30 ? 5 : 2,
    }),
    deltaStats: budget.deltaStats(dailyDeltasForWindow, now),
    verdict: budget.windowVerdict({
      window, projectedUsage, workingDaysUntilReset, estimatedAutonomyWorkingDays, redistribution, pacePerUnit, preliminary, hourly,
    }),
    efficiencyIndex,
    projectedUsage,
    daysUntilReset,
    workingDaysUntilReset,
    estimatedAutonomyWorkingDays,
    todayBudget,
    redistribution,
    hourly,
    preliminary,
    instantRate,
    sustainableRate,
    efficiencyRating,
    tokenYield: localDaily ? budget.tokenYield(localDaily, dailyDeltasForWindow) : null,
    dailyTip: budget.generateDailyTip({
      window,
      daysUntilReset,
      workingDaysUntilReset,
      estimatedAutonomyWorkingDays,
      efficiencyRating,
      consumptionCause: localDaily ? budget.consumptionCause(localDaily, dailyDeltasForWindow) : null,
      preliminary,
    }),
  };
}

function computeAccountSnapshot(
  draft: HistoryDraft,
  raw: RawAccountUsage & { accountId: AccountId; lastUpdatedAt?: string; stale?: boolean; lastError?: string },
  cfg: AccountConfig,
  now: Date,
  localInsights: ClaudeLocalInsights | null,
  fresh: boolean,
): AccountSnapshot {
  const { subscription, workSchedule } = cfg;
  const identity = { accountId: cfg.id, provider: cfg.provider, label: cfg.label };
  const windows = raw.quotaWindows.map((w) => computeWindowSnapshot(draft, cfg.id, w, subscription, raw.subscriptionRenewsAt, workSchedule, now, localInsights, fresh));
  // The window needing attention first (at risk/exhausted), then the most used.
  const criticalSnapshot = budget.pickCriticalSnapshot(windows) ?? undefined;
  const criticalWindow = criticalSnapshot?.window ?? null;

  if (!criticalWindow || !criticalSnapshot) {
    return {
      ...raw,
      ...identity,
      windows,
      criticalWindow: null,
      dailyHistory: [],
      efficiencyIndex: null,
      projectedUsage: null,
      daysUntilReset: null,
      workingDaysUntilReset: null,
      estimatedAutonomyWorkingDays: null,
    };
  }

  return {
    ...raw,
    ...identity,
    windows,
    criticalWindow,
    dailyHistory: criticalSnapshot.dailyHistory,
    efficiencyIndex: criticalSnapshot.efficiencyIndex,
    projectedUsage: criticalSnapshot.projectedUsage,
    daysUntilReset: criticalSnapshot.daysUntilReset,
    workingDaysUntilReset: criticalSnapshot.workingDaysUntilReset,
    estimatedAutonomyWorkingDays: criticalSnapshot.estimatedAutonomyWorkingDays,
  };
}

// Always a valid array: the store is normalized at startup and on every write from
// IPC (store/normalize.ts). A copy, because callers modify it.
function getAccounts(): AccountConfig[] {
  return [...store.get('accounts')];
}

function findAccount(id: AccountId): AccountConfig | undefined {
  return getAccounts().find((a) => a.id === id);
}

function updateAccount(id: AccountId, update: (cfg: AccountConfig) => AccountConfig): AccountConfig {
  const accounts = getAccounts();
  const idx = accounts.findIndex((a) => a.id === id);
  const current = accounts[idx];
  if (!current) throw new Error(`Account not found: ${id}`);
  const updated = update(current);
  accounts[idx] = updated;
  store.set('accounts', accounts);
  return updated;
}

type StampedUsage = RawAccountUsage & { accountId: AccountId; lastUpdatedAt: string; stale: boolean; lastError?: string };

// 401/403 from a service (expired or revoked sessionKey/PAT) is the only case where
// we can give practical advice instead of the service's raw message — see CLAUDE.md,
// progress log, session about the account_session_invalid error.
function friendlyErrorMessage(err: unknown): string {
  const error = err as Error & { status?: number };
  if (error.status === 401 || error.status === 403) {
    return t('error.sessionExpired', { detail: error.message });
  }
  if (err instanceof copilotService.CopilotUsageUnavailableError) {
    return t('error.copilotEnterpriseManaged');
  }
  return error.message;
}

// Main-process language (tray, notifications, dialogs): same rule as the
// renderer — ui.language, or the system language for 'auto'. Re-applied after
// every settings:set, which also rebuilds the tray menu.
function applyMainLocale(): void {
  setLocale(resolveLocale(store.get('ui').language, app.getLocale()));
  trayHandle?.refreshMenu();
}

// Per-account fetch attempts, in memory (main/refreshPolicy.ts): the backoff of a
// failing provider and the short cache of manual refreshes. Lost on restart, which
// simply means the first refresh fetches everything.
const accountFetchStates = new Map<AccountId, AccountFetchState>();
// Last fetch error of each account, until a fetch succeeds: a refresh that skips a
// failing account (backoff) still shows its data as stale, with the reason.
const accountFetchErrors = new Map<AccountId, string>();

async function fetchAccountOrFallback(
  accountId: AccountId,
  provider: ProviderId,
  fetchFn: () => Promise<RawAccountUsage>,
  lastGoodKey: string,
): Promise<StampedUsage> {
  try {
    const raw = await fetchFn();
    accountFetchStates.set(accountId, refreshPolicy.recordFetchAttempt(accountFetchStates.get(accountId), Date.now(), true));
    accountFetchErrors.delete(accountId);
    const stamped: StampedUsage = { ...raw, accountId, lastUpdatedAt: new Date().toISOString(), stale: false };
    store.set(lastGoodKey, stamped);
    return stamped;
  } catch (err) {
    accountFetchStates.set(accountId, refreshPolicy.recordFetchAttempt(accountFetchStates.get(accountId), Date.now(), false));
    const error = err as Error;
    console.error(`[main] refresh ${accountId} failed:`, error.message);
    // Reported here (not only in the caller) because a fallback to valid previous data
    // "absorbs" the error below — without this call a format drift appearing AFTER the
    // first successful fetch would never be detected.
    maybeReportFormatDrift(provider, err);
    const lastGood = store.get('history').lastGood?.[accountId];
    accountFetchErrors.set(accountId, friendlyErrorMessage(err));
    if (!lastGood) throw err; // no previous data: propagate, the caller decides how to show it
    return { ...lastGood, stale: true, lastError: friendlyErrorMessage(err) };
  }
}

// Placeholder shown when an account is connected/enabled but the fetch failed and
// there is no previous data yet (store.history.lastGood.*): without it, the renderer
// cannot tell "not connected" from "connected but the sync just failed", and shows the
// wrong message ("No account connected") even when the account IS connected — see
// CLAUDE.md, "never a blank screen or silent failure".
// ---------------------------------------------------------------------------
// Automatic "format drift" report (user feedback, Day 3): when a service detects that
// an endpoint format is no longer the expected one (FormatDriftError, see
// services/_shape.ts), we open a pre-filled GitHub issue draft in the browser — NEVER
// real values, only structure (field names/types) — that the user must review and
// submit by hand. Deduplicated by structure signature: the same draft is not reopened
// on every refresh (every 30 minutes).
// ---------------------------------------------------------------------------
function maybeReportFormatDrift(provider: ProviderId, err: unknown): void {
  if (!(err instanceof FormatDriftError)) return;
  const diagnostics = store.get('diagnostics');
  if (!diagnostics.autoReportFormatDrift) return;

  const signature = shapeSignature(err.shape);
  const reported = { ...diagnostics.reportedSignatures };
  if (reported[signature]) return; // already reported for this shape: do not reopen

  const url = buildFormatDriftIssueUrl({ provider, endpointLabel: err.endpointLabel, shape: err.shape });
  shell.openExternal(url).catch((openErr: unknown) => {
    console.error('[main] could not open the report draft in the browser:', openErr);
  });

  if (Notification.isSupported()) {
    new Notification({
      title: 'IA Hypermiler',
      body: t('notify.formatDrift', { provider: providers.providerDisplayName(provider) }),
    }).show();
  }

  reported[signature] = new Date().toISOString();
  store.set('diagnostics.reportedSignatures', reported);
}

function emptyAccountSnapshot(cfg: AccountConfig, lastError: string): AccountSnapshot {
  return {
    accountId: cfg.id,
    provider: cfg.provider,
    label: cfg.label,
    planTier: null,
    subscriptionRenewsAt: null,
    quotaWindows: [],
    windows: [],
    criticalWindow: null,
    dailyHistory: [],
    efficiencyIndex: null,
    projectedUsage: null,
    daysUntilReset: null,
    workingDaysUntilReset: null,
    estimatedAutonomyWorkingDays: null,
    stale: true,
    lastError,
  };
}

// The last result of an account not fetched in this refresh: stale with the reason
// while it is in backoff after a failure.
function cachedUsage(lastGood: Omit<StampedUsage, 'stale'>, lastError: string | undefined): StampedUsage {
  return lastError === undefined ? { ...lastGood, stale: false } : { ...lastGood, stale: true, lastError };
}

// Whether any window of a freshly fetched account rose since its last sample: the
// next refresh then comes at the fast pace (main/refreshPolicy.ts).
function windowsRose(draft: HistoryDraft, accountId: AccountId, windows: QuotaWindow[]): boolean {
  return windows.some((window) => {
    const utilization = budget.normalizedUtilization(window);
    const last = getRecentSamples(draft, accountId, window.id).at(-1);
    return utilization !== null && last !== undefined && utilization - last.used > budget.ACTIVITY_EPSILON;
  });
}

// `consumptionRose` is null when no account was fetched (all reused from the last
// refresh): nothing new is known, the pace stays as it was.
async function buildUsageSnapshot(mode: RefreshMode): Promise<{ snapshot: UsageSnapshot; consumptionRose: boolean | null }> {
  const now = new Date();
  const snapshot: UsageSnapshot = { generatedAt: now.toISOString(), accounts: [] };
  const intervalMs = configuredRefreshIntervalMs();
  let consumptionRose: boolean | null = null;

  // Read once here, written once at the end (see HistoryDraft).
  const draft = openHistoryDraft();
  for (const cfg of getAccounts()) {
    if (!cfg.enabled || !providers.isConnected(cfg)) continue;
    // Local source independent of the account fetch: computed first (the per-window
    // yield needs it) and shown even if the provider did not answer.
    const localInsights = cfg.provider === 'claude' && cfg.localInsights ? await computeLocalInsightsIfNeeded() : null;
    let account: AccountSnapshot;
    try {
      // An account in backoff, or fetched moments ago, keeps its last result: nothing
      // new is learned, so no sample is recorded (a repeated old value at a new time
      // would read as a pause in the instant pace).
      const lastGood = store.get('history').lastGood?.[cfg.id];
      const fetchNow = !lastGood || refreshPolicy.shouldFetchAccount(accountFetchStates.get(cfg.id), mode, now.getTime(), intervalMs);
      const raw = fetchNow
        ? await fetchAccountOrFallback(cfg.id, cfg.provider, () => providers.fetchUsage(cfg), `history.lastGood.${cfg.id}`)
        : cachedUsage(lastGood, accountFetchErrors.get(cfg.id));
      const fresh = fetchNow && !raw.stale;
      if (fetchNow) consumptionRose = consumptionRose === true || (fresh && windowsRose(draft, cfg.id, raw.quotaWindows));
      account = computeAccountSnapshot(draft, raw, cfg, now, localInsights, fresh);
    } catch (err) {
      const message = friendlyErrorMessage(err);
      console.error(`[main] ${cfg.label} unavailable and no previous data:`, message);
      account = emptyAccountSnapshot(cfg, message);
    }
    if (localInsights) account.localInsights = localInsights;
    snapshot.accounts.push(account);
  }
  commitHistoryDraft(draft, now);

  return { snapshot, consumptionRose };
}

// ---------------------------------------------------------------------------
// Diagnostic report sections (see diagnostics:createReport). Built WITHOUT account
// labels, ids, credentials or tenant names: only what affects pacing and parsing.
// ---------------------------------------------------------------------------
function reportConfig(cfg: AccountConfig): Record<string, unknown> {
  const common = {
    renewalRule: cfg.subscription.renewalRule,
    workSchedule: cfg.workSchedule,
  };
  switch (cfg.provider) {
    case 'claude':
      return { ...common, authMethod: cfg.authMethod, localInsights: cfg.localInsights };
    case 'copilot':
      return {
        ...common,
        authMethod: cfg.authMethod,
        accountScope: cfg.accountScope,
        host: cfg.host === DEFAULT_GITHUB_HOST ? DEFAULT_GITHUB_HOST : 'a .ghe.com tenant',
        // Read only by the personal-scope fallback: on a company seat it is not used.
        ...(cfg.accountScope === 'personal' ? { manualQuota: cfg.manualQuota } : {}),
      };
  }
}

// What helps diagnose this app on this machine, and nothing that identifies it: time
// zone (day boundaries), screens (widget layout and scaling), memory/CPU of the app's
// own processes, internal timings, core count and RAM rounded to GB. Never CPU/GPU
// models, computer or user names, paths, display or process ids.
function reportSystem(now: Date): Record<string, unknown> {
  const primary = screen.getPrimaryDisplay();
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -now.getTimezoneOffset(),
    cpuCores: os.cpus().length,
    totalMemoryGB: Math.round(os.totalmem() / 1024 ** 3),
    displays: screen.getAllDisplays().map((d) => ({
      primary: d.id === primary.id,
      size: { width: d.size.width, height: d.size.height },
      workArea: { width: d.workArea.width, height: d.workArea.height },
      scaleFactor: d.scaleFactor,
    })),
    widgetSize: { width: store.get('ui').bounds.width, height: store.get('ui').bounds.height },
    // workingSetSize is in KB.
    appProcesses: app.getAppMetrics().map((m) => ({
      type: m.type,
      ...(m.serviceName ? { service: m.serviceName } : {}),
      cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
      memoryMB: Math.round(m.memory.workingSetSize / 1024),
    })),
    uptimeMinutes: Math.round(process.uptime() / 60),
    lastRefresh: timings.lastRefresh,
    lastLocalInsights: timings.lastLocalInsights,
  };
}

// Last 7 days of daily points and today's samples, per window.
function reportHistory(accountId: AccountId, now: Date): unknown {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffKey = budget.localDateKey(cutoff);
  const todayKey = budget.localDateKey(now);
  const history = store.get('history');
  return {
    daily: history.dailyUsage
      .filter((h) => h.accountId === accountId && h.date >= cutoffKey)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(({ date, windowId, used, dayStartUsed }) => ({ date, windowId, used, dayStartUsed })),
    samplesToday: history.recentSamples
      .filter((s) => s.accountId === accountId && budget.localDateKey(new Date(s.timestamp)) === todayKey)
      .map(({ timestamp, windowId, used }) => ({ timestamp, windowId, used })),
  };
}

// How the app read the account in the last refresh: windows and their metrics.
function reportInterpretation(accountId: AccountId, accounts: Pick<ReportAccount, 'name' | 'label' | 'id'>[]): unknown {
  const account = lastSnapshot?.accounts.find((a) => a.accountId === accountId);
  if (!account) return null;
  return {
    lastUpdatedAt: account.lastUpdatedAt ?? null,
    stale: account.stale ?? false,
    lastError: account.lastError ? neutralize(account.lastError, accounts) : null,
    criticalWindow: account.criticalWindow?.id ?? null,
    windows: account.windows.map((w) => ({
      id: w.window.id,
      periodType: w.window.periodType,
      periodLength: w.window.periodLength,
      unit: w.window.unit,
      used: w.window.used,
      total: w.window.total,
      resetsAt: w.window.resetsAt,
      verdict: w.verdict,
      redistribution: w.redistribution,
      todayBudget: w.todayBudget,
      preliminary: w.preliminary,
      efficiencyIndex: w.efficiencyIndex,
      projectedUsage: w.projectedUsage,
      estimatedAutonomyWorkingDays: w.estimatedAutonomyWorkingDays,
      workingDaysUntilReset: w.workingDaysUntilReset,
      deltaStats: w.deltaStats,
      efficiencyRating: w.efficiencyRating,
      dailyTip: w.dailyTip,
    })),
  };
}

// Per-day notification flags ("<account>:<day>", "<account>:pace:<day>"): only
// today's are kept, older ones are dropped instead of piling up in the store.
function flagsOfToday(todayKey: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(store.get('meta').notifiedToday).filter(([key]) => key.endsWith(`:${todayKey}`)));
}

// ---------------------------------------------------------------------------
// Threshold notifications (default 80%, configurable) — at most once a day
// ---------------------------------------------------------------------------
function maybeNotifyThreshold(snapshot: UsageSnapshot): void {
  const threshold = store.get('ui').notificationThresholdPercent;
  const todayKey = budget.localDateKey(new Date());
  const notifiedToday = flagsOfToday(todayKey);

  for (const account of snapshot.accounts) {
    // The most used window, not the one shown first (that one may be chosen for being
    // at risk while another is past the threshold).
    const mostUsed = budget.pickCriticalWindow(account.windows.map((w) => w.window));
    if (!mostUsed) continue;
    const utilization = budget.normalizedUtilization(mostUsed);
    if (utilization === null || utilization < threshold) continue;

    const flagKey = `${account.accountId}:${todayKey}`;
    if (notifiedToday[flagKey]) continue;

    if (Notification.isSupported()) {
      new Notification({
        title: 'IA Hypermiler',
        body: t('notify.threshold', { account: account.label, threshold }),
      }).show();
    }
    notifiedToday[flagKey] = true;
  }
  store.set('meta.notifiedToday', notifiedToday);
}

// ---------------------------------------------------------------------------
// Pace notification — today's consumption well above today's budget
// (budget.PACE_ALERT_RATIO), at most once a day per account. The absolute threshold
// above fires only near the end of the quota; this one fires on the day the pace
// goes wrong, while there is still time to adjust.
// ---------------------------------------------------------------------------
function maybeNotifyPace(snapshot: UsageSnapshot): void {
  const todayKey = budget.localDateKey(new Date());
  const notifiedToday = flagsOfToday(todayKey);

  for (const account of snapshot.accounts) {
    const flagKey = `${account.accountId}:pace:${todayKey}`;
    if (notifiedToday[flagKey]) continue;
    const over = account.windows
      .map((w) => w.todayBudget)
      .find((b) => b !== null && b.budget > 0 && b.usedToday > b.budget * budget.PACE_ALERT_RATIO);
    if (!over) continue;

    if (Notification.isSupported()) {
      new Notification({
        title: 'IA Hypermiler',
        body: t('notify.pace', { account: account.label, used: formatNumber(over.usedToday), budget: formatNumber(over.budget) }),
      }).show();
    }
    notifiedToday[flagKey] = true;
  }
  store.set('meta.notifiedToday', notifiedToday);
}

// One refresh at a time: the startup refresh, the widget's own request and the timer
// used to overlap, each repeating the same fetches and store writes. A request
// arriving during a refresh queues exactly one more run (it may follow a settings
// change the running one did not see), with the stronger of the queued modes.
let refreshRunning: Promise<void> | null = null;
let refreshQueued: RefreshMode | null = null;

function refreshAndBroadcast(mode: RefreshMode): Promise<void> {
  if (refreshRunning) {
    refreshQueued = refreshQueued ? refreshPolicy.strongerMode(refreshQueued, mode) : mode;
    return refreshRunning;
  }
  refreshQueued = null;
  refreshRunning = (async () => {
    let next: RefreshMode | null = mode;
    while (next) {
      await refreshOnce(next);
      next = takeQueuedRefresh();
    }
  })().finally(() => { refreshRunning = null; });
  return refreshRunning;
}

// Read-and-clear in a function: set by another IPC call while refreshOnce awaits.
function takeQueuedRefresh(): RefreshMode | null {
  const queued = refreshQueued;
  refreshQueued = null;
  return queued;
}

async function refreshOnce(mode: RefreshMode): Promise<void> {
  let built: { snapshot: UsageSnapshot; consumptionRose: boolean | null };
  const startedAt = Date.now();
  try {
    built = await buildUsageSnapshot(mode);
  } catch (err) {
    console.error('[main] usage refresh failed:', err);
    scheduleRefreshLoop();
    return;
  }
  const { snapshot } = built;
  lastConsumptionRose = built.consumptionRose ?? lastConsumptionRose;
  scheduleNextRefresh(refreshPolicy.nextRefreshDelayMs(lastConsumptionRose, configuredRefreshIntervalMs()));
  timings.lastRefresh = { at: new Date().toISOString(), ms: Date.now() - startedAt };
  lastSnapshot = snapshot;
  maybeNotifyThreshold(snapshot);
  maybeNotifyPace(snapshot);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usage:update', snapshot);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
// The renderer must never receive real secrets (sessionKey, PAT) — see CLAUDE.md
// "Electron security". `store.store` holds them in clear (the main process needs them
// to authenticate calls), so every time it crosses the IPC boundary towards the
// renderer they are replaced with a placeholder: it keeps the "is connected?" boolean
// (used by renderer/settings.ts for "Connected"/"Not connected") without ever exposing
// the real value.
function redactSecretsForRenderer(settings: AppSettings): AppSettings {
  const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
  return { ...settings, accounts: accounts.map(providers.redactSecrets) };
}

// The renderer always receives the placeholder version (never the real value): when
// it saves the settings after editing ANOTHER field (e.g. planTier), it sends back the
// whole `accounts` array as is, placeholder included. Without this defence, that
// placeholder would silently overwrite the real sessionKey/token in the store. Secrets
// change ONLY through the dedicated flows (accounts:connect*/accounts:disconnect),
// never through the generic save — see providers.preserveSecrets.
// ---------------------------------------------------------------------------
// IPC input validation: values come from the renderer, i.e. from outside the main
// process — TypeScript types guarantee nothing there at runtime. Every handler
// receives `unknown` and validates it before use.
// ---------------------------------------------------------------------------
function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${what}: invalid value`);
  return value;
}

function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: invalid value`);
  return value;
}

const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'copilot'];
const WINDOW_STYLES: readonly WindowStyle[] = ['filled', 'filled-dark', 'transparent-digital'];

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`${what}: unsupported value (${String(value)})`);
  return match;
}

// The token is sent to this host: only github.com or <tenant>.ghe.com (user input, so
// the message is translated).
function requireGithubHost(value: unknown): string {
  const host = normalizeGithubHost(value ?? DEFAULT_GITHUB_HOST);
  if (!host) throw new Error(t('error.invalidGithubHost'));
  return host;
}

// Sections the Settings window may write via settings:set: history, meta, caches
// and the like are owned by the main process only (schema validation: Day 3 backlog).
const RENDERER_EDITABLE_KEYS = new Set<string>(['accounts', 'ui', 'diagnostics', 'updates']);

function preserveRealSecretsOnWrite(key: string, value: unknown): unknown {
  // `updates` is owned by the main process (check results): from the renderer only
  // the autoCheck preference is accepted, otherwise a draft opened before an automatic
  // check would overwrite its result on the first "Save".
  if (key === 'updates') {
    const incoming = isPlainRecord(value) ? value : {};
    return { ...getUpdateSettings(), autoCheck: incoming.autoCheck !== false };
  }
  // Same principle for diagnostics: already reported signatures are written only by the main process.
  if (key === 'diagnostics') {
    const incoming = isPlainRecord(value) ? value : {};
    return { ...store.get('diagnostics'), autoReportFormatDrift: incoming.autoReportFormatDrift !== false };
  }
  if (key !== 'accounts' || !Array.isArray(value)) return value;
  const current = getAccounts();
  // Validated before being touched: the renderer may send any value.
  const merged = normalizeAccounts(value)
    .map((incoming) => providers.preserveSecrets(incoming, current.find((c) => c.id === incoming.id)))
    .filter((a): a is AccountConfig => a !== null);
  // An account present in the store but missing from the patch is not removed here:
  // removal goes only through accounts:remove (which also clears the partition).
  for (const cur of current) {
    if (!merged.some((m) => m.id === cur.id)) merged.push(cur);
  }
  return enforceSingleLocalInsights(merged);
}

// ---------------------------------------------------------------------------
// Updates (issue #5, services/updates.ts): only check + download in the browser, no
// automatic installation (unsigned packages, no extra dependency — user's choice).
// The state lives in store.updates, so the Settings window and the tray read it like
// any other setting.
// ---------------------------------------------------------------------------
function getUpdateSettings(): UpdateSettings {
  return store.get('updates');
}

function openSettingsWindow(): void {
  settingsWindow = createSettingsWindow(settingsWindow);
}

async function checkForUpdates(source: 'auto' | 'manual'): Promise<UpdateSettings> {
  const current = getUpdateSettings();
  if (source === 'auto' && !current.autoCheck) return current;

  let next: UpdateSettings;
  try {
    const available = await fetchLatestUpdate(app.getVersion(), {
      platform: process.platform,
      arch: process.arch,
      isAppImage: !!process.env.APPIMAGE,
    });
    next = { ...current, available, lastCheckedAt: new Date().toISOString(), lastError: null };
  } catch (err) {
    // Never blocking: the last known result (available) stays valid, the error is shown
    // in Settings next to "Check now".
    console.error('[main] update check failed:', (err as Error).message);
    next = { ...current, lastCheckedAt: new Date().toISOString(), lastError: (err as Error).message };
  }

  if (next.available && next.available.version !== next.notifiedVersion && Notification.isSupported()) {
    const notification = new Notification({
      title: 'IA Hypermiler',
      body: t('notify.updateAvailable', { version: next.available.version }),
    });
    notification.on('click', openSettingsWindow);
    notification.show();
    next.notifiedVersion = next.available.version;
  }

  store.set('updates', next);
  broadcastSettings();
  trayHandle?.refreshMenu();
  return next;
}

function startUpdateChecks(): void {
  // In development (`npm start`, unpackaged app) no automatic check: the local version
  // does not match an installed build. The "Check now" button still works. `autoCheck`
  // is re-read on every round, so toggling it in Settings takes effect without a restart.
  if (!app.isPackaged) return;
  setTimeout(() => { runDetached('controllo aggiornamenti', checkForUpdates('auto')); }, UPDATE_FIRST_CHECK_DELAY_MS);
  updateTimer = setInterval(() => { runDetached('controllo aggiornamenti', checkForUpdates('auto')); }, UPDATE_CHECK_INTERVAL_MS);
}

function broadcastSettings(): void {
  const redacted = redactSecretsForRenderer(store.store);
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('settings:update', redacted);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => redactSecretsForRenderer(store.store));

  ipcMain.handle('settings:set', (_event: IpcMainInvokeEvent, patch: unknown) => {
    if (!isPlainRecord(patch)) throw new Error('Settings: invalid patch');
    let next: AppSettings = store.store;
    for (const [key, value] of Object.entries(patch)) {
      if (!RENDERER_EDITABLE_KEYS.has(key)) throw new Error(`Settings: section not editable from the renderer: ${key}`);
      next = { ...next, [key]: preserveRealSecretsOnWrite(key, value) };
    }
    // Same normalization as at startup (store/normalize.ts): a value of the wrong type
    // or a field missing from the patch never reaches the store.
    store.store = normalizeSettings(next, DEFAULTS);
    applyMainLocale();
    scheduleRefreshLoop();
    const redacted = redactSecretsForRenderer(store.store);
    // Propagates the change to the widget if open: some fields (e.g. accent color) have
    // no dedicated IPC like ui.windowStyle/ui.alwaysOnTop and would otherwise apply only
    // after the next window restart (user feedback).
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings:update', redacted);
    }
    return redacted;
  });

  ipcMain.on('usage:refreshRequest', () => { runDetached('refresh usage', refreshAndBroadcast('manual')); });

  ipcMain.on('window:openSettings', () => {
    settingsWindow = createSettingsWindow(settingsWindow);
  });

  ipcMain.handle('window:setAlwaysOnTop', (_event: IpcMainInvokeEvent, rawValue: unknown) => {
    const value = requireBoolean(rawValue, 'Always on top');
    store.set('ui.alwaysOnTop', value);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(value, 'floating');
    // Also propagates to the Settings window if open (e.g. toggled from the pin in the
    // widget title bar): same logic as settings:set above, so that the "Always on top"
    // checkbox does not drift.
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('settings:update', redactSecretsForRenderer(store.store));
    }
    return value;
  });

  ipcMain.handle('window:setStyle', (_event: IpcMainInvokeEvent, rawStyle: unknown) => {
    const style = requireOneOf(rawStyle, WINDOW_STYLES, 'Window style');
    store.set('ui.windowStyle', style);
    const wasVisible = mainWindow ? mainWindow.isVisible() : true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    const newWindow = createMainWindow(store);
    mainWindow = newWindow;
    if (!wasVisible) newWindow.hide();
    return style;
  });

  ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.on('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });

  ipcMain.handle('accounts:add', (_event: IpcMainInvokeEvent, rawProvider: unknown) => {
    const provider = requireOneOf(rawProvider, PROVIDER_IDS, 'Provider');
    const accounts = getAccounts();
    const id = `${provider}-${randomUUID().slice(0, 8)}`;
    accounts.push(defaultAccountFor(provider, id, nextAccountLabel(provider, accounts)));
    store.set('accounts', accounts);
    broadcastSettings();
    return id;
  });

  ipcMain.handle('accounts:remove', async (_event: IpcMainInvokeEvent, rawId: unknown) => {
    const id = requireString(rawId, 'Account');
    const cfg = findAccount(id);
    if (!cfg) return;
    // Full disconnect before removing the row: for Claude it also clears the partition,
    // otherwise the cookies would stay on disk with no owner.
    await providers.disconnect(cfg);
    store.set('accounts', getAccounts().filter((a) => a.id !== id));
    broadcastSettings();
    runDetached('refresh usage', refreshAndBroadcast('forced'));
  });

  ipcMain.handle('accounts:connectClaude', async (_event: IpcMainInvokeEvent, rawId: unknown) => {
    const id = requireString(rawId, 'Account');
    const cfg = findAccount(id);
    if (!cfg || cfg.provider !== 'claude') throw new Error(`Claude account not found: ${id}`);
    const { sessionKey, capturedAt } = await captureClaudeSession(cfg.partition);
    let organizationId: string | null = null;
    try {
      const cookieHeader = await buildClaudeCookieHeader(cfg.partition);
      const orgs = await claudeService.listOrganizations(sessionKey, cookieHeader);
      organizationId = orgs[0]?.id ?? null;
    } catch (err) {
      console.error('[main] could not resolve the Claude organizationId:', (err as Error).message);
    }
    updateAccount(id, (a) => (a.provider === 'claude'
      ? { ...a, enabled: true, session: { sessionKey, organizationId, capturedAt, expiresAt: null } }
      : a));
    broadcastSettings();
    runDetached('refresh usage', refreshAndBroadcast('forced'));
    return { organizationId };
  });

  ipcMain.handle('accounts:connectCopilot', async (_event: IpcMainInvokeEvent, rawId: unknown, rawToken: unknown, rawHost: unknown) => {
    const id = requireString(rawId, 'Account');
    const token = requireString(rawToken, 'Token').trim();
    const host = requireGithubHost(rawHost);
    const username = await copilotService.resolveUsername(token, host);
    updateAccount(id, (a) => (a.provider === 'copilot'
      ? { ...a, enabled: true, authMethod: 'pat', host, credentials: { token, username } }
      : a));
    broadcastSettings();
    runDetached('refresh usage', refreshAndBroadcast('forced'));
    return { username };
  });

  // Alternative to a hand-pasted PAT, through an OAuth App registered by the user on the
  // account's GitHub domain. Verified on a personal Free account (2026-10-01): with an
  // OAuth token copilot_internal/user returns the quota snapshots — see RESEARCH.md §2.2.
  ipcMain.handle('accounts:connectCopilotOAuth', async (_event: IpcMainInvokeEvent, rawId: unknown, rawPayload: unknown) => {
    const id = requireString(rawId, 'Account');
    const payloadRecord = isPlainRecord(rawPayload) ? rawPayload : {};
    const payload = {
      clientId: requireString(payloadRecord.clientId, 'Client ID'),
      clientSecret: requireString(payloadRecord.clientSecret, 'Client Secret'),
      host: requireGithubHost(payloadRecord.host),
    };
    const { accessToken } = await captureGithubOAuthToken(payload);
    const username = await copilotService.resolveUsername(accessToken, payload.host);
    updateAccount(id, (a) => (a.provider === 'copilot'
      ? { ...a, enabled: true, authMethod: 'oauth', host: payload.host, credentials: { token: accessToken, username }, oauthApp: { clientId: payload.clientId } }
      : a));
    broadcastSettings();
    runDetached('refresh usage', refreshAndBroadcast('forced'));
    return { username };
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('updates:check', () => checkForUpdates('manual'));

  // The URL to open comes from the store (written only by checkForUpdates), never
  // from the renderer, and is restricted to the project repository anyway.
  const openTrustedUpdateUrl = async (pick: (a: NonNullable<UpdateSettings['available']>) => string) => {
    const available = getUpdateSettings().available;
    const url = available ? pick(available) : null;
    if (!url || !url.startsWith(TRUSTED_DOWNLOAD_PREFIX)) throw new Error('No update available');
    await shell.openExternal(url);
  };
  ipcMain.handle('updates:download', () => openTrustedUpdateUrl((a) => a.downloadUrl));
  ipcMain.handle('updates:openReleaseNotes', () => openTrustedUpdateUrl((a) => a.releaseUrl));
  // The user guide (README on GitHub) in the interface language; fixed URL.
  ipcMain.handle('app:openGuide', () => shell.openExternal(guideUrl(getLocale())));

  // Manual diagnostic report (Settings → Diagnostics, diagnostics/report.ts): after an
  // explicit confirmation listing what goes in, one text file in Downloads with the
  // redacted responses, pacing settings, the app's reading of the data, recent
  // history and log of every connected account; the folder is shown and a short
  // GitHub issue draft opens, to which the user may attach it. Nothing is sent by the
  // app. The URL is built here with the fixed repository prefix.
  ipcMain.handle('diagnostics:createReport', async (): Promise<{ created: boolean; fileName: string | null }> => {
    const connected = getAccounts().filter((cfg) => providers.isConnected(cfg));
    if (connected.length === 0) throw new Error(t('error.reportNoAccounts'));
    const confirmOptions = {
      type: 'question' as const,
      buttons: [t('report.confirm'), t('report.cancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'IA Hypermiler',
      message: t('report.confirmTitle'),
      detail: t('report.confirmDetail', { accounts: connected.length }),
    };
    const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
    const { response } = parent ? await dialog.showMessageBox(parent, confirmOptions) : await dialog.showMessageBox(confirmOptions);
    if (response !== 0) return { created: false, fileName: null };

    const now = new Date();
    const counters = new Map<ProviderId, number>();
    const accounts = await Promise.all(connected.map(async (cfg): Promise<ReportAccount> => {
      const n = (counters.get(cfg.provider) ?? 0) + 1;
      counters.set(cfg.provider, n);
      const name = `${providers.providerDisplayName(cfg.provider)} #${String(n)}`;
      const base = {
        name, provider: cfg.provider, enabled: cfg.enabled, label: cfg.label, id: cfg.id,
        config: reportConfig(cfg), interpretation: null as unknown, history: reportHistory(cfg.id, now),
      };
      try {
        const raw = await providers.fetchRawResponse(cfg);
        return { ...base, endpointLabel: raw.endpointLabel, response: raw.response };
      } catch (err) {
        return { ...base, endpointLabel: null, readError: err instanceof Error ? err.message : String(err) };
      }
    }));
    // The app's reading of the data, once every name is known (errors are neutralized).
    for (const account of accounts) account.interpretation = reportInterpretation(account.id, accounts);

    const text = buildDiagnosticReport({
      generatedAt: now,
      environment: {
        app: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        electron: process.versions.electron,
        node: process.versions.node,
      },
      settings: {
        language: store.get('ui').language,
        locale: resolveLocale(store.get('ui').language, app.getLocale()),
        chartRange: store.get('ui').chartRange,
        notificationThresholdPercent: store.get('ui').notificationThresholdPercent,
        windowStyle: store.get('ui').windowStyle,
      },
      system: reportSystem(now),
      accounts,
      log: logBuffer.list(),
    });
    const fileName = `ia-hypermiler-report-${budget.localDateKey(now)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.txt`;
    const filePath = path.join(app.getPath('downloads'), fileName);
    await writeFile(filePath, text, 'utf8');
    shell.showItemInFolder(filePath);
    await shell.openExternal(buildReportIssueUrl({ appVersion: app.getVersion(), fileName, accounts: accounts.map((a) => a.name) }));
    return { created: true, fileName };
  });

  ipcMain.handle('accounts:disconnect', async (_event: IpcMainInvokeEvent, rawId: unknown) => {
    const id = requireString(rawId, 'Account');
    const cfg = findAccount(id);
    if (!cfg) return;
    const cleared = await providers.disconnect(cfg);
    updateAccount(id, () => cleared);
    broadcastSettings();
    runDetached('refresh usage', refreshAndBroadcast('forced'));
  });
}

// Before per-account partitions (issue #4) claude.ai cookies lived in
// session.defaultSession: once, we move them into the partition of the migrated
// Claude account (id 'claude', see store/migrate.ts) so the user does not have to log
// in again after the update.
async function migrateLegacyClaudeCookies(): Promise<void> {
  if (store.get('meta').claudeCookiesMigrated === true) return;
  const legacy = findAccount('claude');
  try {
    if (legacy?.provider === 'claude') {
      const moved = await migrateDefaultSessionCookies(legacy.partition);
      console.log(`[main] moved ${moved} claude.ai cookies into the partition of account '${legacy.label}'`);
    }
    store.set('meta.claudeCookiesMigrated', true);
  } catch (err) {
    // Not blocking: the account will show "session not valid" and reconnecting it is enough.
    console.error('[main] Claude cookie migration failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // It is a widget, not a document app: Electron's default menu bar
  // (File/Edit/View/Window/Help) is not needed and weighed down the "filled" skin (user
  // feedback — see also setMenuBarVisibility(false) on every window in main/windows.ts
  // as an extra per-window defence).
  Menu.setApplicationMenu(null);

  registerIpcHandlers();
  applyMainLocale();
  await migrateLegacyClaudeCookies();

  const win = createMainWindow(store);
  mainWindow = win;
  trayHandle = createTray({
    getMainWindow: () => mainWindow,
    openSettings: openSettingsWindow,
    refreshNow: () => { runDetached('refresh usage', refreshAndBroadcast('manual')); },
    store,
  });

  // The refresh on first load is already triggered by the renderer itself
  // (renderer/app.ts calls requestUsageRefresh() on DOMContentLoaded, both at first
  // start and after a skin change that recreates the window) — a second trigger here
  // would duplicate the Claude/Copilot API call every time the widget opens.

  scheduleRefreshLoop();
  startWindowHoverPolling();
  startUpdateChecks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(store);
    }
  });
}).catch((err: unknown) => {
  // Startup failed (window, tray, migration…): without this the app would stay alive
  // in the background with no UI and no message at all. Better to say so and quit.
  console.error('[main] startup failed:', err);
  dialog.showErrorBox(t('startup.failedTitle'), err instanceof Error ? err.message : String(err));
  app.quit();
});

app.on('window-all-closed', () => {
  // The app stays alive in the tray even with the window closed (background refresh);
  // it quits only from the "Quit" entry of the tray menu.
});

app.on('before-quit', () => {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (hoverPollTimer) clearInterval(hoverPollTimer);
  if (updateTimer) clearInterval(updateTimer);
});
