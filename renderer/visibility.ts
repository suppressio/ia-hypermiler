// renderer/visibility.ts — which widget indicators say something right now (user
// feedback: "a rich dashboard is not useful if it repeats information"; a streak of
// 0 days is only confusing). An indicator without a meaningful value is hidden, not
// shown as "--" or 0.

import type { ChartDay } from './types.js';

/**
 * Autonomy only when the quota would run out BEFORE the reset (same unit for both:
 * working days, or hours on a rolling-hours window). Otherwise it only restates the
 * projection ("beyond the renewal" = projection under 100%).
 */
export function showAutonomy(autonomy: number | null, timeLeft: number | null): boolean {
  return autonomy !== null && timeLeft !== null && autonomy < timeLeft;
}

/** The streak of days under budget, from the first such day on. */
export function showStreak(streak: number | null): boolean {
  return streak !== null && streak > 0;
}

/** Completed days (before today) with a measured consumption, from the chart slots. */
export function completedDaysWithData(chart: ChartDay[], todayKey: string): number {
  return chart.filter((d) => !d.upcoming && d.date < todayKey && d.delta !== null).length;
}

/** Peak and average say something different from a single day's value from two days on. */
export function showPeakAvg(chart: ChartDay[], todayKey: string): boolean {
  return completedDaysWithData(chart, todayKey) >= 2;
}
