import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedDaysWithData, showAutonomy, showPeakAvg, showStreak } from './visibility.js';
import type { ChartDay } from './types.js';

const day = (date: string, delta: number | null, upcoming = false): ChartDay => ({
  date, delta, fullShare: 5, dayUnit: 1, budget: 5, upcoming,
});

test('showAutonomy: only when the quota runs out before the reset', () => {
  assert.equal(showAutonomy(4.5, 13.8), true);
  assert.equal(showAutonomy(21.2, 13.8), false); // lasts beyond the renewal: the projection says it
  assert.equal(showAutonomy(13.8, 13.8), false);
  assert.equal(showAutonomy(null, 13.8), false);
  assert.equal(showAutonomy(4, null), false);
});

test('showStreak: hidden at 0 and when unknown', () => {
  assert.equal(showStreak(0), false);
  assert.equal(showStreak(null), false);
  assert.equal(showStreak(2), true);
});

test('showPeakAvg: from two completed days with data, today and days to come excluded', () => {
  const chart = [day('2026-10-07', null), day('2026-10-08', 3), day('2026-10-09', 2), day('2026-10-10', null, true)];
  assert.equal(completedDaysWithData(chart, '2026-10-09'), 1);
  assert.equal(showPeakAvg(chart, '2026-10-09'), false);
  assert.equal(showPeakAvg([day('2026-10-07', 0), ...chart], '2026-10-09'), true);
});
