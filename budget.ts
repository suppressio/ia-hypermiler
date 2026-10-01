// budget.ts — budget/efficiency/projection logic (see ARCHITECTURE.md §0 and §3)
//
// Model: every account (Claude/Copilot) exposes one or more QuotaWindow:
//   { id, label, periodType, periodLength, unit: 'percentage'|'count', used, total, resetsAt }
// - unit 'percentage': used is already 0-100 (Claude case: no known total in tokens).
// - unit 'count': used/total are absolute values (Copilot case: premium requests/credits).
//
// All functions are pure (no I/O), testable from the terminal/test runner.

import { addDays, differenceInCalendarDays, isBefore, startOfDay, setDate, addMonths } from 'date-fns';
import type {
  QuotaWindow,
  WorkSchedule,
  RenewalRule,
  DailyUsagePoint,
  EfficiencyRating,
  DailyDelta,
  DeltaStats,
  WindowVerdict,
  LocalDailyTokens,
  TokenYield,
  DailyTip,
  ConsumptionCause,
} from './types/index';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Calendar-day key (YYYY-MM-DD) in LOCAL time — the key of history.dailyUsage and of
 * the per-day notification flags. Not `toISOString().slice(0, 10)`: that is the UTC
 * day, so a refresh between local midnight and the UTC offset landed on the previous
 * day, while every pacing function reasons in local days.
 */
export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/**
 * Local midnight of a YYYY-MM-DD key. Not `new Date(key)`, which parses a date-only
 * string as UTC midnight: west of Greenwich that is the previous local day (wrong
 * weekday, wrong working unit).
 */
export function parseDateKey(key: string): Date {
  const [year = NaN, month = NaN, day = NaN] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Working unit of a single calendar day: 1 (full), 0.5 (half), 0 (off).
 * When `workSchedule.enabled` is false (schedule disabled, e.g. a personal account
 * with no days/hours to respect), every day counts as 1 regardless of `days` — pacing
 * goes back to treating calendar days uniformly. The field is always present: older
 * stores get it from store/normalize.ts.
 */
export function getDayUnit(date: Date, workSchedule: WorkSchedule): number {
  if (!workSchedule.enabled) return 1;
  const key = DAY_KEYS[date.getDay()];
  if (!key) return 0;
  const status = workSchedule.days[key];
  if (status === 'full') return 1;
  if (status === 'half') return 0.5;
  return 0;
}

/**
 * Sums the working units over the calendar days in [startDate, endDate).
 * If endDate precedes startDate, returns 0 (no negative units).
 */
export function workingUnitsBetween(startDate: Date | string, endDate: Date | string, workSchedule: WorkSchedule): number {
  const start = startOfDay(new Date(startDate));
  const end = startOfDay(new Date(endDate));
  if (!isBefore(start, end)) return 0;

  let units = 0;
  let cursor = start;
  while (isBefore(cursor, end)) {
    units += getDayUnit(cursor, workSchedule);
    cursor = addDays(cursor, 1);
  }
  return units;
}

/** Utilization normalized to a 0-100 percentage, or null when it cannot be computed (count without total). */
export function normalizedUtilization(win: QuotaWindow): number | null {
  if (win.unit === 'percentage') return win.used;
  if (typeof win.total === 'number' && win.total > 0) {
    return (win.used / win.total) * 100;
  }
  return null;
}

/** Picks the most critical quota window (highest normalized utilization). */
export function pickCriticalWindow(quotaWindows: QuotaWindow[]): QuotaWindow | null {
  const [first] = quotaWindows;
  if (!first) return null;
  const [top] = quotaWindows
    .map((w) => ({ window: w, utilization: normalizedUtilization(w) }))
    .filter((x): x is { window: QuotaWindow; utilization: number } => x.utilization !== null)
    .sort((a, b) => b.utilization - a.utilization);
  return top ? top.window : first;
}

/**
 * Working units already spent in the period at `now`: the full days before today plus
 * the current day, counted as elapsed in full. Counting today only once it is over (as
 * `workingUnitsBetween(periodStart, now)` does) left 0 elapsed units on the first day
 * of a period, so projection/autonomy/efficiency ignored a whole day of heavy use.
 * Counting it in full underestimates the pace while the day is still running — the
 * cautious side: it never raises a false alarm. 0 before the period starts or on a
 * non-working day that opens the period.
 */
export function elapsedWorkingUnits(periodStart: Date | string, periodEnd: Date | string, now: Date, workSchedule: WorkSchedule): number {
  const today = startOfDay(now);
  if (isBefore(today, startOfDay(new Date(periodStart)))) return 0;
  const todayUnit = isBefore(today, startOfDay(new Date(periodEnd))) ? getDayUnit(today, workSchedule) : 0;
  return workingUnitsBetween(periodStart, today, workSchedule) + todayUnit;
}

/**
 * Working units left in the period after the current day (see elapsedWorkingUnits:
 * today is already counted as elapsed, so elapsed + remaining = the whole period).
 */
export function remainingWorkingUnits(periodEnd: Date | string, now: Date, workSchedule: WorkSchedule): number {
  return workingUnitsBetween(addDays(startOfDay(now), 1), periodEnd, workSchedule);
}

export interface PeriodContext {
  window: QuotaWindow;
  workSchedule: WorkSchedule;
  periodStart: Date | string;
  periodEnd: Date | string;
  now?: Date;
}

/**
 * Efficiency index: ratio between the ideal pace and the actual pace, computed on
 * working units (not calendar days). ~1 = on budget; >1 = consuming less than planned;
 * <1 = consuming more than sustainable. Returns null when it cannot be computed.
 */
export function efficiencyIndex({ window, workSchedule, periodStart, periodEnd, now = new Date() }: PeriodContext): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null) return null;

  const totalUnits = workingUnitsBetween(periodStart, periodEnd, workSchedule);
  const elapsedUnits = elapsedWorkingUnits(periodStart, periodEnd, now, workSchedule);
  if (totalUnits <= 0 || elapsedUnits <= 0) return null;

  const idealPace = 100 / totalUnits;
  const actualPace = utilization / elapsedUnits;
  if (actualPace === 0) return null;

  return Math.round((idealPace / actualPace) * 100) / 100;
}

/**
 * Projected usage (%) at the end of the period, extrapolating the actual average
 * pace over the remaining working units. Capped at 100.
 */
export function projectedUsage({ window, workSchedule, periodStart, periodEnd, now = new Date() }: PeriodContext): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null) return null;

  const elapsedUnits = elapsedWorkingUnits(periodStart, periodEnd, now, workSchedule);
  const remainingUnits = remainingWorkingUnits(periodEnd, now, workSchedule);
  if (elapsedUnits <= 0) return Math.min(100, utilization);

  const avgPacePerUnit = utilization / elapsedUnits;
  const projected = utilization + avgPacePerUnit * remainingUnits;
  return Math.round(Math.min(100, projected) * 10) / 10;
}

/** Calendar days left until the reset (>= 0). */
export function daysUntilReset(resetsAt: Date | string, now: Date = new Date()): number {
  return Math.max(0, differenceInCalendarDays(new Date(resetsAt), now));
}

/**
 * Working days/units left until the reset (>= 0), after the current day — the same
 * horizon `estimatedAutonomyWorkingDays` is compared with (today counts as elapsed,
 * see elapsedWorkingUnits).
 */
export function workingDaysUntilReset(resetsAt: Date | string, workSchedule: WorkSchedule, now: Date = new Date()): number {
  return remainingWorkingUnits(resetsAt, now, workSchedule);
}

/**
 * Estimated remaining autonomy in working units at the current average pace
 * (how many working units are left before reaching 100%).
 * Returns Infinity when the current pace is ~0 (no consumption observed).
 */
export function estimatedAutonomyWorkingDays({ window, workSchedule, periodStart, periodEnd, now = new Date() }: PeriodContext): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null) return null;
  if (utilization >= 100) return 0;

  const elapsedUnits = elapsedWorkingUnits(periodStart, periodEnd, now, workSchedule);
  if (elapsedUnits <= 0) return Infinity;

  const avgPacePerUnit = utilization / elapsedUnits;
  if (avgPacePerUnit <= 0) return Infinity;

  const remainingPercent = 100 - utilization;
  return Math.round((remainingPercent / avgPacePerUnit) * 10) / 10;
}

/**
 * For count-based windows (e.g. Copilot premium requests): how many remaining
 * units can be afforded per remaining working unit. Null when not applicable.
 */
export function remainingBudgetPerWorkingDay({ window, workSchedule, periodEnd, now = new Date() }: Omit<PeriodContext, 'periodStart'>): number | null {
  if (window.unit !== 'count' || typeof window.total !== 'number') return null;
  const remaining = Math.max(0, window.total - window.used);
  const remainingUnits = workingUnitsBetween(now, periodEnd, workSchedule);
  if (remainingUnits <= 0) return remaining;
  return Math.floor(remaining / remainingUnits);
}

/**
 * Recent consumption pace (%/h), computed between the oldest and the newest sample
 * available within `lookbackMinutes` (default 3h). Not truly instantaneous (refresh
 * runs every 30 min, see CLAUDE.md), but the pace observed in the recent window.
 * Returns null when samples are insufficient or the interval is too short (< 5 min)
 * to be meaningful. A negative delta (quota window reset in between) is clamped to 0
 * instead of showing a negative pace that means nothing to the user.
 */
export function instantaneousRate(
  samples: { timestamp: Date | string; used: number }[],
  now: Date = new Date(),
  lookbackMinutes = 180,
): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;

  const cutoff = now.getTime() - lookbackMinutes * 60 * 1000;
  const points = samples
    .map((s) => ({ time: new Date(s.timestamp).getTime(), used: s.used }))
    .filter((s) => s.time <= now.getTime())
    .sort((a, b) => a.time - b.time);

  const withinLookback = points.filter((s) => s.time >= cutoff);
  const relevant = withinLookback.length >= 2 ? withinLookback : points;
  if (relevant.length < 2) return null;

  const oldest = relevant[0];
  const latest = relevant.at(-1);
  if (!oldest || !latest) return null;
  const elapsedHours = (latest.time - oldest.time) / (3600 * 1000);
  if (elapsedHours < 5 / 60) return null;

  const delta = Math.max(0, latest.used - oldest.used);
  return Math.round((delta / elapsedHours) * 100) / 100;
}

/**
 * Maximum sustainable hourly pace (%/h) to reach exactly 100% at the window
 * reset — the "target" marker of the instant consumption gauge. Needs only the reset
 * moment, not `periodStart`/`workSchedule`: unlike `efficiencyIndex`/`projectedUsage`
 * it also works for windows with an unknown reference period (e.g. one-off credits
 * with their own `resetsAt`, see main.ts canEstimatePacing), because knowing when the
 * period started is not needed to know how much time is left. `resetsAt` is passed
 * explicitly: a window without its own (e.g. a monthly spend limit) resets at the end
 * of the billing period resolved by the caller.
 * Returns null when `resetsAt` is missing or utilization cannot be computed.
 */
export function sustainableHourlyRate(window: QuotaWindow, resetsAt: Date | string | null, now: Date = new Date()): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null || !resetsAt) return null;

  const hoursUntilReset = (new Date(resetsAt).getTime() - now.getTime()) / (3600 * 1000);
  if (hoursUntilReset <= 0) return 0;

  const remainingPercent = Math.max(0, 100 - utilization);
  return Math.round((remainingPercent / hoursUntilReset) * 100) / 100;
}

const EFFICIENCY_RATING_MAX_RATIO = 3;

/**
 * Star efficiency rating (1-5) over the last `days` days: average ratio between the
 * day's ideal share and the consumption observed that day (>1 = consumed less than the
 * ideal). Unlike `efficiencyIndex` (cumulative snapshot since the start of the
 * period), this looks day by day over a moving window — how consistently usage stayed
 * close to the ideal pace lately, not just the total so far. A non-working day is
 * excluded (no ideal share to respect); a negative delta (window reset in between) is
 * excluded as in instantaneousRate, not attributable to that day's usage. Each ratio
 * is capped at EFFICIENCY_RATING_MAX_RATIO so a single zero-consumption day does not
 * dominate the average. Returns null when there is not enough valid data.
 */
export function efficiencyRating(
  dailyHistory: DailyUsagePoint[],
  workSchedule: WorkSchedule,
  totalPeriodWorkingUnits: number,
  days = 7,
): EfficiencyRating | null {
  if (!Array.isArray(dailyHistory) || dailyHistory.length < 2 || totalPeriodWorkingUnits <= 0) return null;

  const sorted = [...dailyHistory].sort((a, b) => a.date.localeCompare(b.date)).slice(-(days + 1));
  const ratios: number[] = [];

  for (const { delta, idealShare } of dailyDeltas(sorted, workSchedule, totalPeriodWorkingUnits)) {
    if (idealShare === null || idealShare <= 0 || delta === null) continue;
    const ratio = delta === 0 ? EFFICIENCY_RATING_MAX_RATIO : Math.min(EFFICIENCY_RATING_MAX_RATIO, idealShare / delta);
    ratios.push(ratio);
  }

  if (ratios.length === 0) return null;
  const avgRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const stars = avgRatio >= 1.5 ? 5 : avgRatio >= 1.1 ? 4 : avgRatio >= 0.9 ? 3 : avgRatio >= 0.6 ? 2 : 1;
  return { stars, avgRatio: Math.round(avgRatio * 100) / 100 };
}

/**
 * Consumption of each day (difference with the previous history point, in quota
 * percentage points) next to that day's ideal share — EVOLUTION.md point 1: the
 * widget chart shows this, no longer the cumulative % per day that mirrored the
 * provider dashboard.
 * - `delta` null: the window was reset in between (negative delta), the value is not
 *   attributable to that day's usage (same rule as instantaneousRate);
 * - `idealShare` null: pacing not available (period of unknown length,
 *   totalPeriodWorkingUnits <= 0); 0 on a non-working day.
 * The first history point has no predecessor and produces no delta.
 */
export function dailyDeltas(
  dailyHistory: DailyUsagePoint[],
  workSchedule: WorkSchedule,
  totalPeriodWorkingUnits: number,
): DailyDelta[] {
  if (!Array.isArray(dailyHistory)) return [];
  const sorted = [...dailyHistory].sort((a, b) => a.date.localeCompare(b.date));
  const result: DailyDelta[] = [];
  let prev: DailyUsagePoint | undefined;
  for (const curr of sorted) {
    if (prev) {
      const rawDelta = curr.used - prev.used;
      const idealShare = totalPeriodWorkingUnits > 0
        ? round2(getDayUnit(parseDateKey(curr.date), workSchedule) * (100 / totalPeriodWorkingUnits))
        : null;
      result.push({ date: curr.date, delta: rawDelta < 0 ? null : round2(rawDelta), idealShare });
    }
    prev = curr;
  }
  return result;
}

/**
 * Daily consumption peak/average and streak of consecutive days (from the most
 * recent) within the ideal share — computed on the `dailyDeltas` deltas, not on the
 * cumulative value: on the cumulative value the "peak" was always the last day and
 * the streak meant nothing. Days with a reset (delta null) are ignored; the streak is
 * null without pacing (no ideal share to compare with).
 */
export function deltaStats(deltas: DailyDelta[]): DeltaStats {
  const valid = deltas.filter((d): d is DailyDelta & { delta: number } => d.delta !== null);
  if (valid.length === 0) return { peak: null, avg: null, streakUnderBudget: null };
  const values = valid.map((d) => d.delta);
  const peak = round2(Math.max(...values));
  const avg = round2(values.reduce((sum, v) => sum + v, 0) / values.length);

  let streakUnderBudget: number | null = null;
  if (valid.some((d) => d.idealShare !== null)) {
    streakUnderBudget = 0;
    for (const { delta, idealShare } of [...valid].reverse()) {
      if (idealShare !== null && delta <= idealShare) streakUnderBudget += 1;
      else break;
    }
  }
  return { peak, avg, streakUnderBudget };
}

export interface WindowVerdictContext {
  window: QuotaWindow;
  projectedUsage: number | null;
  workingDaysUntilReset: number | null;
  estimatedAutonomyWorkingDays: number | null;
}

/**
 * Short verdict of a quota window for the widget window list (EVOLUTION.md point 1:
 * replacing tabs that only lined up the provider's metrics). By severity: exhausted →
 * at risk (autonomy shorter than the time to reset, or projection above 100%) → on
 * track → pacing not available. The text is composed by the renderer (reset date
 * formatting is a UI concern).
 */
export function windowVerdict(ctx: WindowVerdictContext): WindowVerdict {
  const utilization = normalizedUtilization(ctx.window);
  if (utilization !== null && utilization >= 100) return { kind: 'exhausted' };
  if (
    ctx.estimatedAutonomyWorkingDays !== null &&
    ctx.workingDaysUntilReset !== null &&
    ctx.estimatedAutonomyWorkingDays < ctx.workingDaysUntilReset
  ) {
    return { kind: 'at-risk', autonomyWorkingDays: round1(ctx.estimatedAutonomyWorkingDays) };
  }
  if (ctx.projectedUsage !== null && ctx.projectedUsage > 100) {
    return { kind: 'at-risk', projectedUsage: round1(ctx.projectedUsage) };
  }
  if (ctx.projectedUsage !== null) return { kind: 'on-track' };
  return { kind: 'no-pacing' };
}

// ---------------------------------------------------------------------------
// Value per token (EVOLUTION.md point 4): crossing the tokens produced in local Claude
// Code sessions (services/claudeLocalSessions.ts, per day) with the same day's quota
// consumption (dailyDeltas). Only days present in both sources are compared: a day
// with quota used but no local session (e.g. claude.ai in the browser) could not be
// attributed.
// ---------------------------------------------------------------------------

const TOKEN_YIELD_MIN_DAYS = 3;
const TOKEN_YIELD_MIN_TOTAL_DELTA = 1; // quota percentage points: below this the ratio is noise
const CAUSE_MIN_DAYS = 5;
const CAUSE_MIN_RATIO = 1.5;
const CAUSE_MIN_GAP_POINTS = 20;

interface PairedDay { date: string; delta: number; outputTokens: number; highContextOutputTokens: number }

function pairDays(localDaily: LocalDailyTokens[], deltas: DailyDelta[]): PairedDay[] {
  const local = new Map(localDaily.map((d) => [d.date, d]));
  const paired: PairedDay[] = [];
  for (const d of deltas) {
    const l = local.get(d.date);
    if (d.delta === null || d.delta <= 0 || !l || l.outputTokens <= 0) continue;
    paired.push({ date: d.date, delta: d.delta, outputTokens: l.outputTokens, highContextOutputTokens: l.highContextOutputTokens });
  }
  return paired.sort((a, b) => a.date.localeCompare(b.date));
}

function medianOf(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function yieldOf(days: PairedDay[]): number | null {
  const totalDelta = days.reduce((s, d) => s + d.delta, 0);
  if (totalDelta <= 0) return null;
  return days.reduce((s, d) => s + d.outputTokens, 0) / totalDelta;
}

/**
 * "Yield": output tokens produced per percentage point of quota used, on days
 * present in both sources. A measure of value, not of pace: for the same work, a lower
 * yield means each token cost more quota (typically a very large context re-read on
 * every turn). Trend: yield of the second half of the compared days vs the first.
 * null with fewer than TOKEN_YIELD_MIN_DAYS days or a too low total consumption.
 */
export function tokenYield(localDaily: LocalDailyTokens[], deltas: DailyDelta[]): TokenYield | null {
  const paired = pairDays(localDaily, deltas);
  if (paired.length < TOKEN_YIELD_MIN_DAYS) return null;
  if (paired.reduce((s, d) => s + d.delta, 0) < TOKEN_YIELD_MIN_TOTAL_DELTA) return null;
  const overall = yieldOf(paired);
  if (overall === null) return null;

  const half = Math.floor(paired.length / 2);
  const first = yieldOf(paired.slice(0, half));
  const second = yieldOf(paired.slice(paired.length - half));
  const trendPercent = first !== null && second !== null && first > 0 ? round1((second / first - 1) * 100) : null;

  return { tokensPerPercent: Math.round(overall), trendPercent, daysCompared: paired.length };
}

/**
 * Link between quota consumption and large context, stated ONLY when clear: at
 * least CAUSE_MIN_DAYS compared days, and on days above the consumption median the
 * share of tokens produced with context >150k is at least CAUSE_MIN_RATIO times (and
 * CAUSE_MIN_GAP_POINTS points above) that of days below the median. Otherwise null:
 * better no sentence than a weak correlation presented as a cause (EVOLUTION.md, "a bad
 * insight undermines trust more than no insight").
 */
export function consumptionCause(localDaily: LocalDailyTokens[], deltas: DailyDelta[]): ConsumptionCause | null {
  const paired = pairDays(localDaily, deltas);
  if (paired.length < CAUSE_MIN_DAYS) return null;

  const median = medianOf(paired.map((d) => d.delta));
  if (median === null) return null;
  const high = paired.filter((d) => d.delta > median);
  const low = paired.filter((d) => d.delta <= median);
  if (high.length === 0 || low.length === 0) return null;

  const share = (days: PairedDay[]) => {
    const out = days.reduce((s, d) => s + d.outputTokens, 0);
    return out > 0 ? (days.reduce((s, d) => s + d.highContextOutputTokens, 0) / out) * 100 : 0;
  };
  const highShare = share(high);
  const lowShare = share(low);
  if (highShare < lowShare * CAUSE_MIN_RATIO || highShare - lowShare < CAUSE_MIN_GAP_POINTS) return null;

  return { highDaysHighContextPercent: Math.round(highShare), lowDaysHighContextPercent: Math.round(lowShare), daysCompared: paired.length };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface DailyTipContext {
  window: QuotaWindow;
  efficiencyIndex: number | null;
  projectedUsage: number | null;
  daysUntilReset: number | null;
  workingDaysUntilReset: number | null;
  estimatedAutonomyWorkingDays: number | null;
  instantRate: number | null;
  sustainableRate: number | null;
  efficiencyRating: EfficiencyRating | null;
  // Only for the Claude account with local insights enabled — see consumptionCause.
  consumptionCause?: ConsumptionCause | null;
}

export const NO_TIP: DailyTip = { key: 'none', params: {} };

/**
 * Daily tip as DATA, not a sentence: a message key plus the real numbers it
 * states. The renderer turns it into text in the active language
 * (renderer/i18n, keys `tips.<key>`), so the tip follows a language switch
 * without a refresh. Every candidate below has an explicit condition on values
 * already computed in this file — never a generic tip picked at random. When
 * several hold, one is chosen among the applicable ones (variety without ever
 * stating something false); when none holds, `none` says so honestly.
 */
export function generateDailyTip(ctx: DailyTipContext, random: () => number = Math.random): DailyTip {
  const {
    window,
    projectedUsage,
    daysUntilReset,
    workingDaysUntilReset,
    estimatedAutonomyWorkingDays,
    instantRate,
    sustainableRate,
    efficiencyRating,
    consumptionCause: cause,
  } = ctx;
  const utilization = normalizedUtilization(window);
  const candidates: DailyTip[] = [];

  // 1. Estimated autonomy at the current pace is shorter than the time left to
  // the reset: a concrete risk of running out first. Includes the slowdown
  // needed to make it (ratio between the two durations).
  if (
    estimatedAutonomyWorkingDays !== null && Number.isFinite(estimatedAutonomyWorkingDays) &&
    workingDaysUntilReset !== null && workingDaysUntilReset > 0 &&
    estimatedAutonomyWorkingDays < workingDaysUntilReset
  ) {
    candidates.push({
      key: 'autonomy',
      params: {
        autonomyDays: round1(estimatedAutonomyWorkingDays),
        daysToReset: round1(workingDaysUntilReset),
        reductionPercent: Math.round((1 - estimatedAutonomyWorkingDays / workingDaysUntilReset) * 100),
      },
    });
  }

  // 2. The pace of the last hours is above the sustainable one to reach the
  // reset exactly at 100% — see instantaneousRate/sustainableHourlyRate.
  if (instantRate !== null && sustainableRate !== null && instantRate > sustainableRate) {
    candidates.push({
      key: 'instantRate',
      params: { instantRate: round2(instantRate), sustainableRate: round2(sustainableRate) },
    });
  }

  // 3. High rating over the last days: real room for heavier use today.
  if (efficiencyRating !== null && efficiencyRating.stars >= 4) {
    candidates.push({
      key: 'rating',
      params: { stars: efficiencyRating.stars, avgRatio: round2(efficiencyRating.avgRatio) },
    });
  }

  // 4. Few days to the reset and usage already high: better to ration what is left.
  if (daysUntilReset !== null && daysUntilReset <= 2 && utilization !== null && utilization >= 70) {
    candidates.push({
      key: daysUntilReset === 0 ? 'nearResetToday' : 'nearReset',
      params: { days: daysUntilReset, utilization: round1(utilization) },
    });
  }

  // 5. The linear projection to the end of the period exceeds 100%, even though
  // it has not been reached yet — earlier signal than case 1 (which needs autonomy).
  if (projectedUsage !== null && projectedUsage >= 100 && utilization !== null && utilization < 100) {
    candidates.push({ key: 'projected', params: { projectedUsage: round1(projectedUsage) } });
  }

  // 6. Strong link between high-consumption days and large context (local
  // Claude Code sessions) — see consumptionCause: present only when the signal is clear.
  if (cause) {
    candidates.push({
      key: 'cause',
      params: {
        highPercent: cause.highDaysHighContextPercent,
        lowPercent: cause.lowDaysHighContextPercent,
        days: cause.daysCompared,
      },
    });
  }

  // Index capped to the last candidate: an injected random returning 1
  // (Math.random() never does, tests may) would otherwise yield undefined.
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index] ?? NO_TIP;
}

/**
 * Resolves the next subscription renewal date from a renewalRule.
 * Only { type: 'dayOfMonth', day } is supported today. { type: 'rrule', rrule } is not
 * implemented yet (it would need a dedicated library; to be evaluated if a recurrence
 * more complex than a day of the month is ever really needed).
 */
export function resolveRenewalDate(renewalRule: RenewalRule, referenceDate: Date = new Date()): Date {
  if (renewalRule.type === 'dayOfMonth' && typeof renewalRule.day === 'number') {
    const day = renewalRule.day;
    let candidate = setDate(startOfDay(new Date(referenceDate)), day);
    if (!isBefore(referenceDate, candidate)) {
      candidate = setDate(addMonths(candidate, 1), day);
    }
    return candidate;
  }
  throw new Error(`resolveRenewalDate: renewalRule.type "${renewalRule.type}" not supported`);
}
