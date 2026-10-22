import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instantFlow, isWorkingDay } from './instantFlow.js';
import type { WorkSchedule } from '../types/index';

test('instant flow: account schedule uses local full/half/off days; disabled means unrestricted', () => {
  const schedule: WorkSchedule = {
    enabled: true,
    days: { mon: 'full', tue: 'full', wed: 'full', thu: 'full', fri: 'half', sat: 'off', sun: 'off' },
    hoursPerDay: 8,
  };
  for (const hour of [0, 9, 23]) {
    assert.equal(isWorkingDay(schedule, new Date(2026, 9, 19, hour)), true);
    assert.equal(isWorkingDay(schedule, new Date(2026, 9, 23, hour)), true);
    assert.equal(isWorkingDay(schedule, new Date(2026, 9, 24, hour)), false);
    assert.equal(isWorkingDay(schedule, new Date(2026, 9, 25, hour)), false);
    assert.equal(isWorkingDay({ ...schedule, enabled: false }, new Date(2026, 9, 25, hour)), true);
  }
  const weekendAccount: WorkSchedule = { ...schedule, days: { ...schedule.days, mon: 'off', sun: 'full' } };
  assert.equal(isWorkingDay(weekendAccount, new Date(2026, 9, 19)), false);
  assert.equal(isWorkingDay(weekendAccount, new Date(2026, 9, 25)), true);
});

test('instant flow: the ±15% dead zone includes both boundaries', () => {
  for (const average of [8.5, 9, 10, 11, 11.5]) {
    assert.equal(instantFlow(average, 10, true), null);
  }
  assert.equal(instantFlow(8.49, 10, true)?.direction, 'right');
  assert.equal(instantFlow(11.51, 10, true)?.direction, 'left');
});

test('instant flow: spare quota points right only while working; excess pace always points left', () => {
  assert.equal(instantFlow(5, 10, true)?.direction, 'right');
  assert.equal(instantFlow(5, 10, false), null);
  assert.equal(instantFlow(20, 10, true)?.direction, 'left');
  assert.equal(instantFlow(20, 10, false)?.direction, 'left');
  assert.equal(instantFlow(0, 10, true)?.direction, 'right');
});

test('instant flow: speed is proportional to the relative gap in either direction and capped', () => {
  const slow = instantFlow(12.5, 10, true);
  const fast = instantFlow(15, 10, true);
  assert.ok(slow && fast);
  assert.equal(slow.durationSeconds, fast.durationSeconds * 2);
  assert.equal(instantFlow(5, 10, true)?.durationSeconds, fast.durationSeconds);
  assert.equal(instantFlow(150, 100, true)?.durationSeconds, fast.durationSeconds);
  assert.equal(instantFlow(30, 10, true)?.durationSeconds, 4);
  assert.equal(instantFlow(1000, 10, true)?.durationSeconds, 4);
});

test('instant flow: no samples, missing targets and invalid rates show no arrows', () => {
  assert.equal(instantFlow(null, 10, true), null);
  assert.equal(instantFlow(10, null, true), null);
  for (const invalid of [NaN, Infinity, -Infinity, -1]) {
    assert.equal(instantFlow(invalid, 10, true), null);
    assert.equal(instantFlow(10, invalid, true), null);
  }
});

test('instant flow: exhausted quota has capped left flow only when consumption is positive', () => {
  assert.equal(instantFlow(0, 0, true), null);
  assert.deepEqual(instantFlow(1, 0, false), { direction: 'left', durationSeconds: 4 });
});
