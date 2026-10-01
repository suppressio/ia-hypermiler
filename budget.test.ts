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

test('efficiencyIndex ~1 when the actual pace equals the ideal one', () => {
  // Period of 10 working days (2 Mon-Fri weeks), halfway (5 working days elapsed) at
  // 50% usage: pace exactly on track.
  const periodStart = new Date(2026, 6, 13); // Monday
  const periodEnd = new Date(2026, 6, 27); // two Mondays later (10 working days)
  const now = new Date(2026, 6, 20); // middle Monday (5 working days elapsed)
  const result = budget.efficiencyIndex({ window: pctWindow(50), workSchedule: FULL_WEEK_SCHEDULE, periodStart, periodEnd, now });
  assert.equal(result, 1);
});

test('efficiencyIndex < 1 when consuming faster than sustainable', () => {
  const periodStart = new Date(2026, 6, 13);
  const periodEnd = new Date(2026, 6, 27);
  const now = new Date(2026, 6, 20);
  const result = budget.efficiencyIndex({ window: pctWindow(90), workSchedule: FULL_WEEK_SCHEDULE, periodStart, periodEnd, now });
  assert.ok(result !== null && result < 1);
});

test('efficiencyIndex returns null when the period has not started yet', () => {
  const periodStart = new Date(2026, 6, 20);
  const periodEnd = new Date(2026, 6, 27);
  const now = new Date(2026, 6, 13); // before the start of the period
  const result = budget.efficiencyIndex({ window: pctWindow(10), workSchedule: FULL_WEEK_SCHEDULE, periodStart, periodEnd, now });
  assert.equal(result, null);
});

test('projectedUsage extrapolates linearly and caps at 100', () => {
  const periodStart = new Date(2026, 6, 13);
  const periodEnd = new Date(2026, 6, 27);
  const now = new Date(2026, 6, 20);
  const result = budget.projectedUsage({ window: pctWindow(90), workSchedule: FULL_WEEK_SCHEDULE, periodStart, periodEnd, now });
  assert.equal(result, 100); // 90% halfway => would project above 100, must be capped
});

test('daysUntilReset is never negative', () => {
  const past = new Date(2026, 6, 1);
  const now = new Date(2026, 6, 20);
  assert.equal(budget.daysUntilReset(past, now), 0);
});

test('estimatedAutonomyWorkingDays returns 0 when already at 100%', () => {
  const periodStart = new Date(2026, 6, 13);
  const now = new Date(2026, 6, 20);
  const result = budget.estimatedAutonomyWorkingDays({ window: pctWindow(100), workSchedule: FULL_WEEK_SCHEDULE, periodStart, now });
  assert.equal(result, 0);
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
  assert.equal(budget.sustainableHourlyRate(win, now), 5); // 50% residuo / 10h
});

test('sustainableHourlyRate returns null when resetsAt is missing', () => {
  const win = pctWindow(50, { resetsAt: null });
  assert.equal(budget.sustainableHourlyRate(win, new Date(2026, 6, 20)), null);
});

test('sustainableHourlyRate returns 0 when already at 100% or the reset has passed', () => {
  const now = new Date(2026, 6, 20, 12, 0, 0);
  const past = new Date(2026, 6, 20, 0, 0, 0);
  assert.equal(budget.sustainableHourlyRate(pctWindow(100, { resetsAt: new Date(2026, 6, 21) }), now), 0);
  assert.equal(budget.sustainableHourlyRate(pctWindow(50, { resetsAt: past }), now), 0);
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
