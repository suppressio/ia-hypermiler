// budget.test.ts — unit tests for the pure logic of budget.ts (no network, no mock
// needed: every function is deterministic).
// Run with: npm test (builds, then runs `node --test` inside dist/).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as budget from './budget';
import type { QuotaWindow, WorkSchedule, DailyUsagePoint } from './types/index';
import { at } from './tests/support/at';

const FULL_WEEK_SCHEDULE: WorkSchedule = {
  enabled: true,
  days: { mon: 'full', tue: 'full', wed: 'full', thu: 'full', fri: 'full', sat: 'off', sun: 'off' },
  hoursPerDay: 8,
};

function pctWindow(used: number, overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'test-window',
    label: 'Test',
    periodType: 'rolling-days',
    periodLength: 7,
    unit: 'percentage',
    used,
    total: null,
    resetsAt: null,
    ...overrides,
  };
}

test('workingUnitsBetween counts only working days (Mon-Fri)', () => {
  // Monday 2026-07-13 -> next Monday: exactly 5 working days.
  const start = new Date(2026, 6, 13);
  const end = new Date(2026, 6, 20);
  assert.equal(budget.workingUnitsBetween(start, end, FULL_WEEK_SCHEDULE), 5);
});

test('workingUnitsBetween returns 0 when end precedes start', () => {
  const start = new Date(2026, 6, 20);
  const end = new Date(2026, 6, 13);
  assert.equal(budget.workingUnitsBetween(start, end, FULL_WEEK_SCHEDULE), 0);
});

test('getDayUnit: with workSchedule.enabled=false every day counts 1, even one marked "off"', () => {
  const disabledSchedule: WorkSchedule = { ...FULL_WEEK_SCHEDULE, enabled: false };
  const saturday = new Date(2026, 6, 18); // sabato, 'off' in FULL_WEEK_SCHEDULE
  assert.equal(budget.getDayUnit(saturday, disabledSchedule), 1);
});

test('workingUnitsBetween: with the schedule disabled counts every calendar day', () => {
  const disabledSchedule: WorkSchedule = { ...FULL_WEEK_SCHEDULE, enabled: false };
  const start = new Date(2026, 6, 13); // Monday
  const end = new Date(2026, 6, 20); // next Monday, 7 calendar days
  assert.equal(budget.workingUnitsBetween(start, end, disabledSchedule), 7);
});

test('normalizedUtilization: percentage returns used directly', () => {
  assert.equal(budget.normalizedUtilization(pctWindow(42)), 42);
});

test('normalizedUtilization: count with total computes the percentage', () => {
  const win = pctWindow(0, { unit: 'count', used: 150, total: 300 });
  assert.equal(budget.normalizedUtilization(win), 50);
});

test('normalizedUtilization: count without total returns null', () => {
  const win = pctWindow(0, { unit: 'count', used: 150, total: null });
  assert.equal(budget.normalizedUtilization(win), null);
});

test('pickCriticalWindow picks the window with the highest utilization', () => {
  const windows = [pctWindow(30, { id: 'a' }), pctWindow(70, { id: 'b' }), pctWindow(0, { id: 'c', unit: 'count', used: 90, total: 100 })];
  const picked = budget.pickCriticalWindow(windows);
  assert.equal(picked?.id, 'c'); // 90% > 70% > 30%
});

test('pickCriticalWindow returns null on an empty list', () => {
  assert.equal(budget.pickCriticalWindow([]), null);
});

// Two Mon-Fri weeks: 10 working days from Monday 13 July 2026 to Monday 27.
const P_START = new Date(2026, 6, 13);
const P_END = new Date(2026, 6, 27);

/** Period context on the two-week period; by default today is fully worked, no recent pace. */
function periodCtx(used: number, now: Date, overrides: Partial<budget.PeriodContext> = {}): budget.PeriodContext {
  return {
    window: pctWindow(used),
    workSchedule: FULL_WEEK_SCHEDULE,
    periodStart: P_START,
    periodEnd: P_END,
    now,
    todayElapsedUnits: 1,
    recentPacePerUnit: null,
    ...overrides,
  };
}

test('efficiencyIndex ~1 when the actual pace equals the ideal one', () => {
  // Halfway (5 working days elapsed, the current one fully worked) at 50%: on track.
  const now = new Date(2026, 6, 17, 18, 0); // first Friday evening
  assert.equal(budget.efficiencyIndex(periodCtx(50, now)), 1);
});

test('efficiencyIndex < 1 when consuming faster than sustainable', () => {
  const result = budget.efficiencyIndex(periodCtx(90, new Date(2026, 6, 20, 18, 0)));
  assert.ok(result !== null && result < 1);
});

test('efficiencyIndex returns null when the period has not started yet', () => {
  const ctx = periodCtx(10, new Date(2026, 6, 13), { periodStart: new Date(2026, 6, 20) });
  assert.equal(budget.efficiencyIndex(ctx), null);
});

test('projectedUsage is NOT capped at 100: it says how far over the pace leads', () => {
  // 90% after 6 working days (15/day) → 90 + 15 × 4 = 150.
  assert.equal(budget.projectedUsage(periodCtx(90, new Date(2026, 6, 20, 18, 0))), 150);
});

test('daysUntilReset is never negative', () => {
  const past = new Date(2026, 6, 1);
  const now = new Date(2026, 6, 20);
  assert.equal(budget.daysUntilReset(past, now), 0);
});

test('estimatedAutonomyWorkingDays returns 0 when already at 100%', () => {
  assert.equal(budget.estimatedAutonomyWorkingDays(periodCtx(100, new Date(2026, 6, 20))), 0);
});

// Real case, 2026-10-01: 10.3% on day one of a monthly period showed no pacing at all,
// because the current day only counted once it was over.
test('first day of the period, fully worked: the day counts as elapsed', () => {
  const now = new Date(2026, 6, 13, 18, 0);
  const ctx = periodCtx(20, now);
  assert.equal(budget.elapsedWorkingUnits(P_START, P_END, now, FULL_WEEK_SCHEDULE, 1), 1);
  assert.equal(budget.remainingWorkingUnits(P_END, now, FULL_WEEK_SCHEDULE, 1), 9);
  assert.equal(budget.efficiencyIndex(ctx), 0.5); // ideal 10%/day, actual 20%/day
  assert.equal(budget.projectedUsage(ctx), 200); // 20 + 20 × 9
  assert.equal(budget.estimatedAutonomyWorkingDays(ctx), 4); // 80% left at 20%/day
  assert.equal(budget.workingDaysUntilReset(P_END, FULL_WEEK_SCHEDULE, now, 1), 9);
});

test('first day of the period, half worked: the pace is measured on the hours worked', () => {
  const now = new Date(2026, 6, 13, 13, 0);
  const ctx = periodCtx(5, now, { todayElapsedUnits: 0.5 });
  assert.equal(budget.efficiencyIndex(ctx), 1); // 5% in half a day = 10%/day = ideal
  assert.equal(budget.workingDaysUntilReset(P_END, FULL_WEEK_SCHEDULE, now, 0.5), 9.5);
  assert.equal(budget.projectedUsage(ctx), 100); // 5 + 10 × 9.5
});

test('elapsed and remaining working units always add up to the whole period', () => {
  const total = budget.workingUnitsBetween(P_START, P_END, FULL_WEEK_SCHEDULE);
  for (let day = 13; day < 27; day++) {
    for (const todayElapsed of [0, 0.25, 1]) {
      const now = new Date(2026, 6, day, 11, 30);
      const sum = budget.elapsedWorkingUnits(P_START, P_END, now, FULL_WEEK_SCHEDULE, todayElapsed)
        + budget.remainingWorkingUnits(P_END, now, FULL_WEEK_SCHEDULE, todayElapsed);
      assert.equal(sum, total, `day ${String(day)}, today ${String(todayElapsed)}`);
    }
  }
});

test('elapsedWorkingUnits: a non-working current day adds nothing, before the period it is 0', () => {
  assert.equal(budget.elapsedWorkingUnits(P_START, P_END, new Date(2026, 6, 18, 12), FULL_WEEK_SCHEDULE, 1), 5); // Saturday
  assert.equal(budget.elapsedWorkingUnits(P_START, P_END, new Date(2026, 6, 10), FULL_WEEK_SCHEDULE, 1), 0);
});

// ---------------------------------------------------------------------------
// todayActivitySpan / todayElapsedUnits — the working day from the day's samples
// ---------------------------------------------------------------------------

function sample(hour: number, minute: number, used: number, day = 13) {
  return { timestamp: new Date(2026, 6, day, hour, minute), used };
}

test('todayActivitySpan: from the sample before the first increase to the last increase', () => {
  const samples = [
    sample(8, 30, 10), sample(9, 0, 10), sample(9, 30, 11), sample(10, 0, 12),
    sample(11, 30, 14), sample(12, 0, 14), sample(15, 0, 14), // flat after 11:30
  ];
  const span = budget.todayActivitySpan(samples, 10, new Date(2026, 6, 13, 20, 0), null);
  assert.deepEqual(span, { start: new Date(2026, 6, 13, 9, 0), end: new Date(2026, 6, 13, 11, 30) });
});

test('todayActivitySpan: nothing rose today → null; a drop (reset) is not activity', () => {
  const now = new Date(2026, 6, 13, 18);
  assert.equal(budget.todayActivitySpan([sample(9, 0, 10), sample(12, 0, 10)], 10, now, null), null);
  assert.equal(budget.todayActivitySpan([sample(9, 0, 80), sample(9, 30, 0)], 80, now, null), null);
});

test('todayActivitySpan: first sample of the day already above the baseline → starts there', () => {
  // App opened at 10:00 after working since earlier: the start is the first sample seen.
  const span = budget.todayActivitySpan([sample(10, 0, 15), sample(12, 0, 18)], 12, new Date(2026, 6, 13, 18), null);
  assert.deepEqual(span, { start: new Date(2026, 6, 13, 10, 0), end: new Date(2026, 6, 13, 12, 0) });
});

test("todayActivitySpan: an earlier local session moves the start back; yesterday's samples are ignored", () => {
  const samples = [sample(17, 0, 5, 12), sample(18, 0, 9, 12), sample(10, 0, 15), sample(12, 0, 18)];
  const now = new Date(2026, 6, 13, 18);
  const span = budget.todayActivitySpan(samples, 12, now, new Date(2026, 6, 13, 8, 45));
  assert.deepEqual(span, { start: new Date(2026, 6, 13, 8, 45), end: new Date(2026, 6, 13, 12, 0) });
  // A session of another day is not today's start.
  const other = budget.todayActivitySpan(samples, 12, now, new Date(2026, 6, 12, 8, 0));
  assert.deepEqual(other?.start, new Date(2026, 6, 13, 10, 0));
});

test('todayElapsedUnits: no activity yet today → 0 (today still entirely ahead)', () => {
  assert.equal(budget.todayElapsedUnits(new Date(2026, 6, 13, 10), null, FULL_WEEK_SCHEDULE), 0);
});

test('todayElapsedUnits: the hours worked over hoursPerDay, capped at the day unit', () => {
  // Worked 9–12, looked at 20:00: 3 hours, not 11 — stopping work stops the clock.
  assert.equal(budget.todayElapsedUnits(new Date(2026, 6, 13, 20, 0), 3, FULL_WEEK_SCHEDULE), 0.375);
  assert.equal(budget.todayElapsedUnits(new Date(2026, 6, 13, 21, 0), 11, FULL_WEEK_SCHEDULE), 1); // capped
  const halfFriday = { ...FULL_WEEK_SCHEDULE, days: { ...FULL_WEEK_SCHEDULE.days, fri: 'half' as const } };
  assert.equal(budget.todayElapsedUnits(new Date(2026, 6, 17, 16, 0), 7, halfFriday), 0.5);
});

test('todayElapsedUnits: at least 2 hours once work started (no absurd pace after one refresh)', () => {
  assert.equal(budget.todayElapsedUnits(new Date(2026, 6, 13, 9, 30), 0.5, FULL_WEEK_SCHEDULE), 0.25);
});

test('todayElapsedUnits: schedule disabled → fraction of the calendar day', () => {
  const calendar = { ...FULL_WEEK_SCHEDULE, enabled: false };
  assert.equal(budget.todayElapsedUnits(new Date(2026, 6, 18, 18, 0), null, calendar), 0.75);
});

// ---------------------------------------------------------------------------
// recentPacePerUnit — projection and autonomy follow the recent pace
// ---------------------------------------------------------------------------

test('recentPacePerUnit: last completed working days only, null with fewer than 2', () => {
  const now = new Date(2026, 6, 16, 12); // Thursday
  const deltas = [
    { date: '2026-07-13', delta: 5, idealShare: 10 },
    { date: '2026-07-14', delta: 20, idealShare: 10 },
    { date: '2026-07-15', delta: 30, idealShare: 10 },
    { date: '2026-07-16', delta: 99, idealShare: 10 }, // today: still running, ignored
  ];
  assert.equal(budget.recentPacePerUnit(deltas, FULL_WEEK_SCHEDULE, now), 55 / 3);
  assert.equal(budget.recentPacePerUnit(deltas.slice(2), FULL_WEEK_SCHEDULE, now), null);
});

test('a heavy recent pace raises projection and lowers autonomy', () => {
  const now = new Date(2026, 6, 17, 18, 0); // 5 working days, 25% → average 5/day
  const calm = periodCtx(25, now);
  const heavy = periodCtx(25, now, { recentPacePerUnit: 15 }); // blended pace 10/day
  assert.equal(budget.projectedUsage(calm), 50);
  assert.equal(budget.projectedUsage(heavy), 75);
  assert.equal(budget.estimatedAutonomyWorkingDays(heavy), 7.5);
});

// ---------------------------------------------------------------------------
// todayBudget — today's allowance vs today's consumption
// ---------------------------------------------------------------------------

test('todayBudget: what was left at the start of the day over the working units from today', () => {
  const now = new Date(2026, 6, 13, 15, 0); // first day: 100% over 10 days
  assert.deepEqual(budget.todayBudget(periodCtx(10.3, now), 0), { budget: 10, usedToday: 10.3 });
  // Day 6 (Monday 20): 40% used before today, 5 days left → 12/day.
  assert.deepEqual(budget.todayBudget(periodCtx(45, new Date(2026, 6, 20, 15)), 40), { budget: 12, usedToday: 5 });
});

test('todayBudget: null on a non-working day or without a baseline; a reset leaves the new count', () => {
  assert.equal(budget.todayBudget(periodCtx(10, new Date(2026, 6, 18, 12)), 5), null); // Saturday
  assert.equal(budget.todayBudget(periodCtx(10, new Date(2026, 6, 13, 12)), null), null);
  assert.deepEqual(budget.todayBudget(periodCtx(3, new Date(2026, 6, 13, 12)), 60), { budget: 4, usedToday: 3 });
});

// ---------------------------------------------------------------------------
// updateDailyPoint — baseline of the day and first activity
// ---------------------------------------------------------------------------

function point(date: string, used: number, extra: Partial<DailyUsagePoint> = {}): DailyUsagePoint {
  return { date, accountId: 'acc', windowId: 'w', used, ...extra };
}

test('updateDailyPoint: new day → baseline from the previous point, kept for the whole day', () => {
  const morning = new Date(2026, 6, 14, 8, 0);
  const created = budget.updateDailyPoint({
    today: undefined, previous: point('2026-07-13', 12), accountId: 'acc', windowId: 'w', used: 12, periodStart: P_START, now: morning,
  });
  assert.equal(created.date, '2026-07-14');
  assert.equal(created.dayStartUsed, 12);

  const later = new Date(2026, 6, 14, 9, 30);
  const active = budget.updateDailyPoint({
    today: created, previous: point('2026-07-13', 12), accountId: 'acc', windowId: 'w', used: 13.5, periodStart: P_START, now: later,
  });
  assert.equal(active.dayStartUsed, 12);

  const evening = budget.updateDailyPoint({
    today: active, previous: point('2026-07-13', 12), accountId: 'acc', windowId: 'w', used: 20, periodStart: P_START, now: new Date(2026, 6, 14, 18),
  });
  assert.equal(evening.dayStartUsed, 12); // set once
  assert.equal(evening.used, 20);
});

test('updateDailyPoint: reset since the previous point → baseline 0; no history → current value', () => {
  const now = new Date(2026, 6, 13, 10);
  const afterReset = budget.updateDailyPoint({
    today: undefined, previous: point('2026-07-10', 80), accountId: 'acc', windowId: 'w', used: 85, periodStart: P_START, now,
  });
  assert.equal(afterReset.dayStartUsed, 0); // period started after the previous point
  const dropped = budget.updateDailyPoint({
    today: undefined, previous: point('2026-07-13', 80), accountId: 'acc', windowId: 'w', used: 4, periodStart: new Date(2026, 6, 1), now: new Date(2026, 6, 14, 10),
  });
  assert.equal(dropped.dayStartUsed, 0); // value dropped: reset in between
  const first = budget.updateDailyPoint({
    today: undefined, previous: undefined, accountId: 'acc', windowId: 'w', used: 30, periodStart: P_START, now,
  });
  assert.equal(first.dayStartUsed, 30);
});

test('dailyDeltas uses the day baseline: the reset day and the first day get a real bar', () => {
  const deltas = budget.dailyDeltas([
    point('2026-07-10', 80),
    point('2026-07-13', 7, { dayStartUsed: 0 }), // reset over the weekend
  ], FULL_WEEK_SCHEDULE, 10);
  assert.deepEqual(deltas.map((d) => d.delta), [7]);
  const firstDay = budget.dailyDeltas([point('2026-07-13', 9, { dayStartUsed: 4 })], FULL_WEEK_SCHEDULE, 10);
  assert.deepEqual(firstDay.map((d) => d.delta), [5]);
});

test('resolveRenewalDate: future dayOfMonth in the current month', () => {
  const ref = new Date(2026, 6, 10); // 10 luglio
  const result = budget.resolveRenewalDate({ type: 'dayOfMonth', day: 20 }, ref);
  assert.equal(result.getFullYear(), 2026);
  assert.equal(result.getMonth(), 6); // luglio (0-based)
  assert.equal(result.getDate(), 20);
});

test('resolveRenewalDate: past dayOfMonth moves to the next month', () => {
  const ref = new Date(2026, 6, 25); // 25 luglio
  const result = budget.resolveRenewalDate({ type: 'dayOfMonth', day: 5 }, ref);
  assert.equal(result.getMonth(), 7); // agosto
  assert.equal(result.getDate(), 5);
});

test('resolveRenewalDate: unsupported rrule throws an explicit error', () => {
  assert.throws(() => budget.resolveRenewalDate({ type: 'rrule', rrule: 'FREQ=WEEKLY' }), /not supported/);
});

// ---------------------------------------------------------------------------
// instantaneousRate — gauge "consumo istantaneo"
// ---------------------------------------------------------------------------

test('instantaneousRate computes the %/h pace between the oldest and the newest sample', () => {
  const now = new Date(2026, 6, 20, 12, 0, 0);
  const samples = [
    { timestamp: new Date(2026, 6, 20, 10, 0, 0), used: 10 },
    { timestamp: new Date(2026, 6, 20, 12, 0, 0), used: 20 },
  ];
  assert.equal(budget.instantaneousRate(samples, now), 5); // 10 points in 2 hours
});

test('instantaneousRate returns null with fewer than 2 samples', () => {
  const now = new Date(2026, 6, 20, 12, 0, 0);
  assert.equal(budget.instantaneousRate([{ timestamp: now, used: 10 }], now), null);
});

test('instantaneousRate returns null when the interval is too short (< 5 min)', () => {
  const now = new Date(2026, 6, 20, 12, 4, 0);
  const samples = [
    { timestamp: new Date(2026, 6, 20, 12, 0, 0), used: 10 },
    { timestamp: now, used: 12 },
  ];
  assert.equal(budget.instantaneousRate(samples, now), null);
});

test('instantaneousRate clamps a negative delta to 0 (window reset in between)', () => {
  const now = new Date(2026, 6, 20, 12, 0, 0);
  const samples = [
    { timestamp: new Date(2026, 6, 20, 10, 0, 0), used: 95 },
    { timestamp: now, used: 5 }, // the window was reset between the two samples
  ];
  assert.equal(budget.instantaneousRate(samples, now), 0);
});

// ---------------------------------------------------------------------------
// sustainableHourlyRate — the gauge "target" marker
// ---------------------------------------------------------------------------

test('sustainableHourlyRate computes the maximum hourly pace to reach 100% at the reset', () => {
  const now = new Date(2026, 6, 20, 0, 0, 0);
  const resetsAt = new Date(2026, 6, 20, 10, 0, 0); // 10 hours to reset
  const win = pctWindow(50, { resetsAt });
  assert.equal(budget.sustainableHourlyRate(win, resetsAt, now, null), 5); // 50% left / 10h
});

test('sustainableHourlyRate uses the reset passed by the caller (window without its own resetsAt)', () => {
  // Monthly spend limit: no resetsAt on the window, the period end comes from the
  // renewal rule.
  const now = new Date(2026, 9, 1, 12, 0, 0);
  const periodEnd = new Date(2026, 9, 2, 12, 0, 0); // 24 hours
  assert.equal(budget.sustainableHourlyRate(pctWindow(52, { resetsAt: null }), periodEnd, now, null), 2);
});

test('sustainableHourlyRate returns null when the reset is unknown', () => {
  const win = pctWindow(50, { resetsAt: null });
  assert.equal(budget.sustainableHourlyRate(win, null, new Date(2026, 6, 20), null), null);
});

test('sustainableHourlyRate on working hours: the remainder spread over the hours actually worked', () => {
  // 90% left, reset in 30 calendar days but only 150 working hours (≈ 19 days × 8h).
  // July: no DST change in any time zone, so exactly 720 calendar hours.
  const now = new Date(2026, 6, 1, 12, 0, 0);
  const periodEnd = new Date(2026, 6, 31, 12, 0, 0);
  assert.equal(budget.sustainableHourlyRate(pctWindow(10), periodEnd, now, null), 0.13); // 90 / 720h
  assert.equal(budget.sustainableHourlyRate(pctWindow(10), periodEnd, now, 150), 0.6); // 90 / 150h
  // No working time left before the reset: back to calendar hours.
  assert.equal(budget.sustainableHourlyRate(pctWindow(10), periodEnd, now, 0), 0.13);
});

test('sustainableHourlyRate returns 0 when already at 100% or the reset has passed', () => {
  const now = new Date(2026, 6, 20, 12, 0, 0);
  const past = new Date(2026, 6, 20, 0, 0, 0);
  assert.equal(budget.sustainableHourlyRate(pctWindow(100), new Date(2026, 6, 21), now, null), 0);
  assert.equal(budget.sustainableHourlyRate(pctWindow(50), past, now, null), 0);
});

// ---------------------------------------------------------------------------
// efficiencyRating — rating a stelle
// ---------------------------------------------------------------------------

function dayPoint(date: string, used: number): DailyUsagePoint {
  return { date, accountId: 'claude', windowId: 'test-window', used };
}

test('efficiencyRating averages the ideal/actual ratios over valid working days', () => {
  const history = [dayPoint('2026-07-13', 10), dayPoint('2026-07-14', 15), dayPoint('2026-07-15', 17)];
  // Period with 20 total working units => ideal share 5% per full day.
  const result = budget.efficiencyRating(history, FULL_WEEK_SCHEDULE, 20);
  assert.ok(result !== null);
  assert.equal(result.avgRatio, 1.75); // rapporti 5/5=1 e 5/2=2.5, media 1.75
  assert.equal(result.stars, 5);
});

test('efficiencyRating drops a day with a negative delta (window reset)', () => {
  const history = [
    dayPoint('2026-07-13', 10),
    dayPoint('2026-07-14', 15),
    dayPoint('2026-07-15', 17),
    dayPoint('2026-07-16', 3), // reset: the value goes down instead of up
  ];
  const result = budget.efficiencyRating(history, FULL_WEEK_SCHEDULE, 20);
  assert.equal(result!.avgRatio, 1.75); // identical to the previous test: the reset day does not change the average
});

test('efficiencyRating excludes non-working days', () => {
  // 2026-07-17 is a Friday, 2026-07-18 a Saturday (off in the test schedule).
  const history = [dayPoint('2026-07-17', 20), dayPoint('2026-07-18', 25)];
  assert.equal(budget.efficiencyRating(history, FULL_WEEK_SCHEDULE, 20), null);
});

test('efficiencyRating returns null with insufficient data', () => {
  assert.equal(budget.efficiencyRating([dayPoint('2026-07-13', 10)], FULL_WEEK_SCHEDULE, 20), null);
  assert.equal(budget.efficiencyRating([dayPoint('2026-07-13', 10), dayPoint('2026-07-14', 15)], FULL_WEEK_SCHEDULE, 0), null);
});

// ---------------------------------------------------------------------------
// generateDailyTip — tip of the day derived from real data
// ---------------------------------------------------------------------------

function baseTipContext(overrides: Partial<budget.DailyTipContext> = {}): budget.DailyTipContext {
  return {
    window: pctWindow(50),
    efficiencyIndex: 1,
    projectedUsage: 50,
    daysUntilReset: 10,
    workingDaysUntilReset: 8,
    estimatedAutonomyWorkingDays: 8,
    instantRate: null,
    sustainableRate: null,
    efficiencyRating: null,
    ...overrides,
  };
}

test('generateDailyTip returns `none` when no condition holds', () => {
  assert.deepEqual(budget.generateDailyTip(baseTipContext()), budget.NO_TIP);
});

test('generateDailyTip flags an estimated autonomy shorter than the time to reset', () => {
  const tip = budget.generateDailyTip(baseTipContext({ estimatedAutonomyWorkingDays: 4, workingDaysUntilReset: 8 }));
  assert.deepEqual(tip, { key: 'autonomy', params: { autonomyDays: 4, daysToReset: 8, reductionPercent: 50 } }); // 1 - 4/8
});

test('generateDailyTip flags a recent pace above the sustainable one', () => {
  const tip = budget.generateDailyTip(baseTipContext({ instantRate: 5, sustainableRate: 2 }));
  assert.deepEqual(tip, { key: 'instantRate', params: { instantRate: 5, sustainableRate: 2 } });
});

test('generateDailyTip reports a high rating as room for more usage', () => {
  const tip = budget.generateDailyTip(baseTipContext({ efficiencyRating: { stars: 5, avgRatio: 1.8 } }));
  assert.deepEqual(tip, { key: 'rating', params: { stars: 5, avgRatio: 1.8 } });
});

test('generateDailyTip does not report a low rating (only >= 4 stars)', () => {
  const tip = budget.generateDailyTip(baseTipContext({ efficiencyRating: { stars: 2, avgRatio: 0.7 } }));
  assert.deepEqual(tip, budget.NO_TIP);
});

test('generateDailyTip flags few days to reset with usage already high', () => {
  const tip = budget.generateDailyTip(baseTipContext({ window: pctWindow(85), daysUntilReset: 1 }));
  assert.deepEqual(tip, { key: 'nearReset', params: { days: 1, utilization: 85 } });
  const today = budget.generateDailyTip(baseTipContext({ window: pctWindow(85), daysUntilReset: 0 }));
  assert.equal(today.key, 'nearResetToday');
});

test('generateDailyTip flags a projection above 100% before it is reached', () => {
  const tip = budget.generateDailyTip(baseTipContext({ window: pctWindow(90), projectedUsage: 130 }));
  assert.deepEqual(tip, { key: 'projected', params: { projectedUsage: 130 } });
});

test('generateDailyTip does not repeat the projection once usage is already 100%', () => {
  const tip = budget.generateDailyTip(baseTipContext({ window: pctWindow(100), projectedUsage: 100 }));
  assert.deepEqual(tip, budget.NO_TIP);
});

test('generateDailyTip picks among applicable candidates using the injected random, never a non-applicable one', () => {
  const ctx = baseTipContext({
    instantRate: 5,
    sustainableRate: 2, // candidate 2 applies
    efficiencyRating: { stars: 5, avgRatio: 1.8 }, // candidate 3 applies
  });
  const first = budget.generateDailyTip(ctx, () => 0);
  const second = budget.generateDailyTip(ctx, () => 0.99);
  assert.deepEqual([first.key, second.key], ['instantRate', 'rating']);
  // A random of exactly 1 must not overflow the candidate list.
  assert.equal(budget.generateDailyTip(ctx, () => 1).key, 'rating');
});

// ---------------------------------------------------------------------------
// dailyDeltas / deltaStats / windowVerdict — "daily consumption vs budget" chart and
// window list with verdicts (EVOLUTION.md point 1)
// ---------------------------------------------------------------------------

test('dailyDeltas: daily consumption = difference with the previous point, with ideal share', () => {
  const history = [dayPoint('2026-07-13', 10), dayPoint('2026-07-14', 15), dayPoint('2026-07-15', 17)];
  assert.deepEqual(budget.dailyDeltas(history, FULL_WEEK_SCHEDULE, 20), [
    { date: '2026-07-14', delta: 5, idealShare: 5 },
    { date: '2026-07-15', delta: 2, idealShare: 5 },
  ]);
});

test('dailyDeltas: reset (negative delta) → null, non-working day → ideal share 0', () => {
  const history = [dayPoint('2026-07-17', 20), dayPoint('2026-07-18', 25), dayPoint('2026-07-20', 4)];
  const result = budget.dailyDeltas(history, FULL_WEEK_SCHEDULE, 20);
  assert.equal(at(result, 0).idealShare, 0); // sabato
  assert.equal(at(result, 0).delta, 5);
  assert.equal(at(result, 1).delta, null); // Monday after a reset
});

test('dailyDeltas: without pacing (0 total units) deltas remain, ideal share is null', () => {
  const history = [dayPoint('2026-07-13', 10), dayPoint('2026-07-14', 12)];
  assert.deepEqual(budget.dailyDeltas(history, FULL_WEEK_SCHEDULE, 0), [{ date: '2026-07-14', delta: 2, idealShare: null }]);
});

test('deltaStats: peak/average on deltas (not on the cumulative value) and streak within the ideal share', () => {
  const stats = budget.deltaStats([
    { date: 'a', delta: 8, idealShare: 5 },
    { date: 'b', delta: null, idealShare: 5 },
    { date: 'c', delta: 2, idealShare: 5 },
    { date: 'd', delta: 4, idealShare: 5 },
  ]);
  assert.deepEqual(stats, { peak: 8, avg: 4.67, streakUnderBudget: 2 });
});

test('deltaStats: no data → all null; without pacing the streak is null', () => {
  assert.deepEqual(budget.deltaStats([]), { peak: null, avg: null, streakUnderBudget: null });
  assert.equal(budget.deltaStats([{ date: 'a', delta: 3, idealShare: null }]).streakUnderBudget, null);
});

test('windowVerdict: exhausted, at risk (autonomy or projection), on track, no pacing', () => {
  const base = { projectedUsage: 80, workingDaysUntilReset: 10, estimatedAutonomyWorkingDays: 12 };
  assert.deepEqual(budget.windowVerdict({ ...base, window: pctWindow(100) }), { kind: 'exhausted' });
  assert.deepEqual(
    budget.windowVerdict({ ...base, window: pctWindow(60), estimatedAutonomyWorkingDays: 3.04 }),
    { kind: 'at-risk', autonomyWorkingDays: 3 },
  );
  assert.deepEqual(
    budget.windowVerdict({ window: pctWindow(60), projectedUsage: 130.44, workingDaysUntilReset: null, estimatedAutonomyWorkingDays: null }),
    { kind: 'at-risk', projectedUsage: 130.4 },
  );
  assert.deepEqual(budget.windowVerdict({ ...base, window: pctWindow(60) }), { kind: 'on-track' });
  assert.deepEqual(
    budget.windowVerdict({ window: pctWindow(60), projectedUsage: null, workingDaysUntilReset: null, estimatedAutonomyWorkingDays: null }),
    { kind: 'no-pacing' },
  );
});

// ---------------------------------------------------------------------------
// tokenYield / consumptionCause — value per token (EVOLUTION.md point 4)
// ---------------------------------------------------------------------------

function localDay(date: string, outputTokens: number, highContextOutputTokens = 0) {
  return { date, outputTokens, highContextOutputTokens };
}

function delta(date: string, value: number | null) {
  return { date, delta: value, idealShare: 5 };
}

test('tokenYield: tokens per 1% of quota on days present in both sources only', () => {
  const local = [localDay('2026-07-13', 10000), localDay('2026-07-14', 20000), localDay('2026-07-15', 30000), localDay('2026-07-16', 99999)];
  // 2026-07-16 has a reset (delta null) → excluded; 2026-07-17 has no local sessions → excluded.
  const deltas = [delta('2026-07-13', 2), delta('2026-07-14', 4), delta('2026-07-15', 4), delta('2026-07-16', null), delta('2026-07-17', 10)];
  const y = budget.tokenYield(local, deltas);
  assert.equal(y?.tokensPerPercent, 6000); // 60000 token / 10 punti
  assert.equal(y.daysCompared, 3);
  // Halves (1 day each): 10000/2=5000 → 30000/4=7500 → +50%.
  assert.equal(y.trendPercent, 50);
});

test('tokenYield: null with fewer than 3 common days or total consumption below 1%', () => {
  assert.equal(budget.tokenYield([localDay('2026-07-13', 1000), localDay('2026-07-14', 1000)], [delta('2026-07-13', 2), delta('2026-07-14', 2)]), null);
  const local = [localDay('a', 1000), localDay('b', 1000), localDay('c', 1000)];
  assert.equal(budget.tokenYield(local, [delta('a', 0.2), delta('b', 0.2), delta('c', 0.2)]), null);
});

test('consumptionCause: clear signal → high-consumption days dominated by large context', () => {
  const local = [
    localDay('d1', 1000, 100), localDay('d2', 1000, 100), localDay('d3', 1000, 150),
    localDay('d4', 1000, 800), localDay('d5', 1000, 900), localDay('d6', 1000, 850),
  ];
  const deltas = [delta('d1', 1), delta('d2', 1.5), delta('d3', 2), delta('d4', 8), delta('d5', 9), delta('d6', 10)];
  assert.deepEqual(budget.consumptionCause(local, deltas), {
    highDaysHighContextPercent: 85,
    lowDaysHighContextPercent: 12,
    daysCompared: 6,
  });
});

test('consumptionCause: weak signal or few days → no sentence (null)', () => {
  const weakLocal = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((d, i) => localDay(d, 1000, i < 3 ? 400 : 500));
  const deltas = [delta('d1', 1), delta('d2', 1.5), delta('d3', 2), delta('d4', 8), delta('d5', 9), delta('d6', 10)];
  assert.equal(budget.consumptionCause(weakLocal, deltas), null);
  assert.equal(budget.consumptionCause(weakLocal.slice(0, 4), deltas.slice(0, 4)), null);
});

test('generateDailyTip: the consumption/context link is a candidate only when present', () => {
  const cause = { highDaysHighContextPercent: 85, lowDaysHighContextPercent: 12, daysCompared: 6 };
  const tip = budget.generateDailyTip({ ...baseTipContext(), consumptionCause: cause });
  assert.deepEqual(tip, { key: 'cause', params: { highPercent: 85, lowPercent: 12, days: 6 } });
  assert.deepEqual(budget.generateDailyTip({ ...baseTipContext(), consumptionCause: null }), budget.NO_TIP);
});

// ---------------------------------------------------------------------------
// Local day keys of the daily history
// ---------------------------------------------------------------------------

test('localDateKey is the LOCAL day, also right after local midnight (not the UTC one)', () => {
  assert.equal(budget.localDateKey(new Date(2026, 9, 1, 0, 30)), '2026-10-01');
  assert.equal(budget.localDateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('parseDateKey returns local midnight, so the weekday matches the key', () => {
  const date = budget.parseDateKey('2026-07-13'); // a Monday
  assert.equal(date.getDay(), 1);
  assert.equal(date.getHours(), 0);
  assert.equal(budget.localDateKey(date), '2026-07-13');
});
