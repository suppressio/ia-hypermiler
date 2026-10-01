// renderer/schedule.test.ts — one-line summary of an account's work schedule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWorkSchedule } from './schedule.js';
import { setLocale } from './i18n/index.js';
import type { AccountConfig } from './types.js';

type Schedule = AccountConfig['workSchedule'];

const WEEK: Schedule['days'] = { mon: 'full', tue: 'full', wed: 'full', thu: 'full', fri: 'full', sat: 'off', sun: 'off' };

function schedule(days: Partial<Schedule['days']>, enabled = true): Schedule {
  return { enabled, days: { ...WEEK, ...days }, hoursPerDay: 8 };
}

test('summarizeWorkSchedule: disabled schedule means no constraints', () => {
  setLocale('en');
  assert.equal(summarizeWorkSchedule(schedule({}, false)), 'No constraints: every day counts');
});

test('summarizeWorkSchedule: consecutive full days become a range', () => {
  setLocale('en');
  assert.equal(summarizeWorkSchedule(schedule({})), 'Mon–Fri');
});

test('summarizeWorkSchedule: half days are listed after the full ones', () => {
  setLocale('en');
  assert.equal(summarizeWorkSchedule(schedule({ fri: 'half' })), 'Mon–Thu, half day: Fri');
});

test('summarizeWorkSchedule: non-consecutive days are separated', () => {
  setLocale('en');
  assert.equal(summarizeWorkSchedule(schedule({ wed: 'off', sat: 'half' })), 'Mon–Tue, Thu–Fri, half day: Sat');
});

test('summarizeWorkSchedule: no working day at all', () => {
  setLocale('en');
  const none = schedule({ mon: 'off', tue: 'off', wed: 'off', thu: 'off', fri: 'off' });
  assert.equal(summarizeWorkSchedule(none), 'No working days');
});

test('summarizeWorkSchedule: Italian day names and texts', () => {
  setLocale('it');
  assert.equal(summarizeWorkSchedule(schedule({ fri: 'half' })), 'Lun–Gio, mezza giornata: Ven');
  assert.equal(summarizeWorkSchedule(schedule({}, false)), 'Nessun vincolo: conta ogni giorno');
  setLocale('en');
});
