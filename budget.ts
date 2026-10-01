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
  TodayBudget,
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

// Shortest stretch of work a day is assumed to have covered once activity is seen:
// right after the first refresh with consumption a few minutes of work would turn a
// normal first increment into an absurd pace (2% in 15 min → "out of quota by noon").
const MIN_OBSERVED_WORK_HOURS = 2;

/**
 * Today's working span, from the day's own data (user feedback: "from the first data
 * point of the day to the last"), not from a single recorded start up to `now`:
 * - an increase is a sample whose `used` is above the previous one; the first sample of
 *   the day is compared with `dayStartUsed` (yesterday's value, 0 after a reset). A
 *   drop is a reset, not activity;
 * - `start`: the sample just before the first increase, when it is from today (work
 *   began after it); otherwise the first increase itself (work began before the app
 *   saw it). Moved earlier to `sessionStart` (first local Claude Code session of the
 *   day) when that is earlier;
 * - `end`: the last increase — once work stops the span stops growing.
 * Null when nothing rose today. Samples of other days are ignored.
 */
export function todayActivitySpan(
  samples: { timestamp: Date | string; used: number }[],
  dayStartUsed: number | null,
  now: Date,
  sessionStart: Date | null,
): { start: Date; end: Date } | null {
  const todayKey = localDateKey(now);
  const today = samples
    .map((s) => ({ time: new Date(s.timestamp), used: s.used }))
    .filter((s) => localDateKey(s.time) === todayKey && s.time <= now)
    .sort((a, b) => a.time.getTime() - b.time.getTime());

  let start: Date | null = null;
  let end: Date | null = null;
  for (const [i, sample] of today.entries()) {
    const previous = today[i - 1];
    const base = previous ? previous.used : dayStartUsed;
    if (base === null || sample.used <= base) continue;
    start ??= previous ? previous.time : sample.time;
    end = sample.time;
  }
  if (!start || !end) return null;
  const sessionToday = sessionStart && localDateKey(sessionStart) === todayKey ? sessionStart : null;
  return { start: sessionToday && sessionToday < start ? sessionToday : start, end };
}

/**
 * Working units of TODAY already spent, from the actual working hours:
 * - schedule enabled: the hours worked today (todayActivitySpan) over `hoursPerDay`, at
 *   least MIN_OBSERVED_WORK_HOURS once work started, capped at the day unit (0.5 on a
 *   half day). No activity yet → 0: before work starts, today is still entirely ahead.
 * - schedule disabled (calendar days, e.g. a personal account): the fraction of the
 *   calendar day elapsed, no working hours to infer.
 */
export function todayElapsedUnits(now: Date, workedHours: number | null, workSchedule: WorkSchedule): number {
  if (!workSchedule.enabled) {
    return (now.getTime() - startOfDay(now).getTime()) / (24 * 3600 * 1000);
  }
  const unit = getDayUnit(now, workSchedule);
  if (unit === 0 || workedHours === null) return 0;
  if (workSchedule.hoursPerDay <= 0) return unit;
  return Math.min(unit, Math.max(MIN_OBSERVED_WORK_HOURS, workedHours) / workSchedule.hoursPerDay);
}

/** Working unit of the current day, 0 when the day is outside [periodStart, periodEnd). */
function todayUnitInPeriod(periodStart: Date | string, periodEnd: Date | string, now: Date, workSchedule: WorkSchedule): number {
  const today = startOfDay(now);
  if (isBefore(today, startOfDay(new Date(periodStart)))) return 0;
  if (!isBefore(today, startOfDay(new Date(periodEnd)))) return 0;
  return getDayUnit(today, workSchedule);
}

/**
 * Working units already spent in the period at `now`: the full days before today plus
 * the part of today already worked (`todayElapsed`, see todayElapsedUnits). Counting
 * today only once it is over left 0 elapsed units on the first day of a period, so
 * projection/autonomy/efficiency ignored a whole day of heavy use. 0 before the
 * period starts.
 */
export function elapsedWorkingUnits(periodStart: Date | string, periodEnd: Date | string, now: Date, workSchedule: WorkSchedule, todayElapsed: number): number {
  const today = startOfDay(now);
  if (isBefore(today, startOfDay(new Date(periodStart)))) return 0;
  const todayPart = Math.min(todayElapsed, todayUnitInPeriod(periodStart, periodEnd, now, workSchedule));
  return workingUnitsBetween(periodStart, today, workSchedule) + todayPart;
}

/**
 * Working units left in the period: what remains of today plus the days after it
 * (elapsed + remaining = the whole period, see elapsedWorkingUnits).
 */
export function remainingWorkingUnits(periodEnd: Date | string, now: Date, workSchedule: WorkSchedule, todayElapsed: number): number {
  const today = startOfDay(now);
  const todayUnit = isBefore(today, startOfDay(new Date(periodEnd))) ? getDayUnit(today, workSchedule) : 0;
  const todayLeft = Math.max(0, todayUnit - todayElapsed);
  return todayLeft + workingUnitsBetween(addDays(today, 1), periodEnd, workSchedule);
}

export interface PeriodContext {
  window: QuotaWindow;
  workSchedule: WorkSchedule;
  periodStart: Date | string;
  periodEnd: Date | string;
  now?: Date;
  // Part of today already worked (todayElapsedUnits). Required: a "safe" default
  // would hide a missing wiring (see CLAUDE.md, lessons learned).
  todayElapsedUnits: number;
  // Pace of the last completed working days (recentPacePerUnit), null when there are
  // not enough of them — projection and autonomy blend it with the period average.
  recentPacePerUnit: number | null;
}

/**
 * Efficiency index: ratio between the ideal pace and the actual pace, computed on
 * working units (not calendar days). ~1 = on budget; >1 = consuming less than planned;
 * <1 = consuming more than sustainable. Returns null when it cannot be computed.
 * Cumulative since the period start by definition: no blending with the recent pace.
 */
export function efficiencyIndex({ window, workSchedule, periodStart, periodEnd, now = new Date(), todayElapsedUnits: todayElapsed }: PeriodContext): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null) return null;

  const totalUnits = workingUnitsBetween(periodStart, periodEnd, workSchedule);
  const elapsedUnits = elapsedWorkingUnits(periodStart, periodEnd, now, workSchedule, todayElapsed);
  if (totalUnits <= 0 || elapsedUnits <= 0) return null;

  const idealPace = 100 / totalUnits;
  const actualPace = utilization / elapsedUnits;
  if (actualPace === 0) return null;

  return Math.round((idealPace / actualPace) * 100) / 100;
}

const RECENT_PACE_DAYS = 3;
const RECENT_PACE_MIN_DAYS = 2;

/**
 * Pace (% per working unit) of the last RECENT_PACE_DAYS COMPLETED working days
 * (today excluded: still running), from the daily deltas. Null with fewer than
 * RECENT_PACE_MIN_DAYS usable days (non-working days and resets without a baseline are
 * skipped).
 */
export function recentPacePerUnit(deltas: DailyDelta[], workSchedule: WorkSchedule, now: Date): number | null {
  const todayKey = localDateKey(now);
  const usable = deltas
    .filter((d): d is DailyDelta & { delta: number } => d.delta !== null && d.date < todayKey)
    .map((d) => ({ delta: d.delta, unit: getDayUnit(parseDateKey(d.date), workSchedule) }))
    .filter((d) => d.unit > 0)
    .slice(-RECENT_PACE_DAYS);
  if (usable.length < RECENT_PACE_MIN_DAYS) return null;
  const units = usable.reduce((sum, d) => sum + d.unit, 0);
  return usable.reduce((sum, d) => sum + d.delta, 0) / units;
}

/**
 * Pace used by projection and autonomy: the period average, blended 50/50 with the
 * recent pace when available — the average alone reacts slowly to a change of habit
 * (a heavy week late in the period barely moves it). Null when no pace is measurable
 * yet (nothing elapsed).
 */
function blendedPacePerUnit(ctx: PeriodContext, utilization: number, now: Date): number | null {
  const elapsedUnits = elapsedWorkingUnits(ctx.periodStart, ctx.periodEnd, now, ctx.workSchedule, ctx.todayElapsedUnits);
  if (elapsedUnits <= 0) return ctx.recentPacePerUnit;
  const average = utilization / elapsedUnits;
  return ctx.recentPacePerUnit === null ? average : (average + ctx.recentPacePerUnit) / 2;
}

/**
 * Projected usage (%) at the end of the period, extrapolating the pace
 * (blendedPacePerUnit) over the remaining working units. NOT capped at 100: "227%"
 * says how far over the limit the current pace leads, and windowVerdict needs the
 * value above 100 to flag the risk.
 */
export function projectedUsage(ctx: PeriodContext): number | null {
  const { window, workSchedule, periodEnd, now = new Date(), todayElapsedUnits: todayElapsed } = ctx;
  const utilization = normalizedUtilization(window);
  if (utilization === null) return null;

  const pace = blendedPacePerUnit(ctx, utilization, now);
  if (pace === null) return round1(utilization);
  const remainingUnits = remainingWorkingUnits(periodEnd, now, workSchedule, todayElapsed);
  return round1(utilization + pace * remainingUnits);
}

/** Calendar days left until the reset (>= 0). */
export function daysUntilReset(resetsAt: Date | string, now: Date = new Date()): number {
  return Math.max(0, differenceInCalendarDays(new Date(resetsAt), now));
}

/**
 * Working days/units left until the reset (>= 0): what remains of today plus the days
 * after it — the same horizon `estimatedAutonomyWorkingDays` is compared with.
 */
export function workingDaysUntilReset(resetsAt: Date | string, workSchedule: WorkSchedule, now: Date, todayElapsed: number): number {
  return round1(remainingWorkingUnits(resetsAt, now, workSchedule, todayElapsed));
}

/**
 * Estimated remaining autonomy in working units at the current pace
 * (blendedPacePerUnit, the same one as projectedUsage): how many working units are
 * left before reaching 100%. Returns Infinity when the pace is ~0 (no consumption
 * observed).
 */
export function estimatedAutonomyWorkingDays(ctx: PeriodContext): number | null {
  const utilization = normalizedUtilization(ctx.window);
  if (utilization === null) return null;
  if (utilization >= 100) return 0;

  const pace = blendedPacePerUnit(ctx, utilization, ctx.now ?? new Date());
  if (pace === null || pace <= 0) return Infinity;

  return round1((100 - utilization) / pace);
}

/** Ratio of today's consumption to today's budget above which the pace notification fires. */
export const PACE_ALERT_RATIO = 1.5;

/**
 * Today's budget: the share of the quota today can use so that the rest lasts until
 * the reset — what was left at the START of the day spread over the working units
 * from today on, times today's unit. Fixed for the whole day (consuming does not
 * shrink it while the day runs), recomputed every new day from what is left.
 * `usedToday` is the consumption since the start of the day (a reset during the day
 * leaves the new count only). Null without a baseline, on a non-working day or when
 * no working unit is left.
 */
export function todayBudget(ctx: Omit<PeriodContext, 'todayElapsedUnits' | 'recentPacePerUnit'>, dayStartUsed: number | null): TodayBudget | null {
  const { window, workSchedule, periodStart, periodEnd, now = new Date() } = ctx;
  const utilization = normalizedUtilization(window);
  if (utilization === null || dayStartUsed === null) return null;
  const todayUnit = todayUnitInPeriod(periodStart, periodEnd, now, workSchedule);
  if (todayUnit <= 0) return null;
  const unitsFromToday = remainingWorkingUnits(periodEnd, now, workSchedule, 0);
  if (unitsFromToday <= 0) return null;

  const budget = (Math.max(0, 100 - dayStartUsed) / unitsFromToday) * todayUnit;
  const usedToday = utilization >= dayStartUsed ? utilization - dayStartUsed : utilization;
  return { budget: round2(budget), usedToday: round2(usedToday) };
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
 * moment, not `periodStart`: unlike `efficiencyIndex`/`projectedUsage` it also works
 * for windows with an unknown reference period (e.g. one-off credits with their own
 * `resetsAt`, see main.ts canEstimatePacing), because knowing when the period started
 * is not needed to know how much time is left. `resetsAt` is passed explicitly: a
 * window without its own (e.g. a monthly spend limit) resets at the end of the
 * billing period resolved by the caller.
 * `workingHoursLeft` (remaining working units × hoursPerDay, from the caller) spreads
 * the remainder over the hours actually worked: the instant rate is measured while
 * working, so a target spread over nights and weekends too was several times too
 * strict. Null = calendar hours (5-hour window, schedule disabled); 0 or less also
 * falls back to calendar hours (no working time left before the reset).
 * Returns null when `resetsAt` is missing or utilization cannot be computed.
 */
export function sustainableHourlyRate(
  window: QuotaWindow,
  resetsAt: Date | string | null,
  now: Date,
  workingHoursLeft: number | null,
): number | null {
  const utilization = normalizedUtilization(window);
  if (utilization === null || !resetsAt) return null;

  const calendarHours = (new Date(resetsAt).getTime() - now.getTime()) / (3600 * 1000);
  if (calendarHours <= 0) return 0;
  const hoursUntilReset = workingHoursLeft !== null && workingHoursLeft > 0 ? workingHoursLeft : calendarHours;

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
 * Consumption of each day (difference with the day's baseline `dayStartUsed`, or with
 * the previous history point for older points, in quota percentage points) next to that day's ideal share — EVOLUTION.md point 1: the
 * widget chart shows this, no longer the cumulative % per day that mirrored the
 * provider dashboard.
 * - `delta` null: the window was reset in between (negative delta), the value is not
 *   attributable to that day's usage (same rule as instantaneousRate);
 * - `idealShare` null: pacing not available (period of unknown length,
 *   totalPeriodWorkingUnits <= 0); 0 on a non-working day.
 * The first history point produces a delta only when it carries its own `dayStartUsed`.
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
    // The day's own baseline (updateDailyPoint) when recorded: exact even on the day
    // of a reset, and for the first day of history. Older points: previous point.
    const base = curr.dayStartUsed ?? prev?.used;
    if (base !== undefined) {
      const rawDelta = curr.used - base;
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
 * Next value of TODAY's history point for a window, given the point already recorded
 * today (if any), the last point of an earlier day (if any) and the current
 * utilization (already rounded by the caller):
 * - `dayStartUsed` (set once, when the day's point is created): the previous point's
 *   value when it belongs to the current period; 0 when the period started after it
 *   or the value dropped (reset in between); the current value when there is no
 *   history at all (consumption before the first refresh is unknown).
 * An older point of today without a baseline (recorded before the field existed)
 * gets one computed the same way.
 */
export function updateDailyPoint(args: {
  today: DailyUsagePoint | undefined;
  previous: DailyUsagePoint | undefined;
  accountId: DailyUsagePoint['accountId'];
  windowId: string;
  used: number;
  periodStart: Date | string;
  now: Date;
}): DailyUsagePoint {
  const { today, previous, accountId, windowId, used, periodStart, now } = args;
  let dayStartUsed = today?.dayStartUsed;
  if (dayStartUsed === undefined) {
    if (!previous) dayStartUsed = today?.used ?? used;
    else if (previous.used > used || isBefore(parseDateKey(previous.date), startOfDay(new Date(periodStart)))) dayStartUsed = 0;
    else dayStartUsed = previous.used;
  }
  return { date: localDateKey(now), accountId, windowId, used, dayStartUsed };
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
