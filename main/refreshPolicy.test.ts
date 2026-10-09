// main/refreshPolicy.test.ts — adaptive refresh pace, per-account backoff, manual cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAST_REFRESH_MS,
  MANUAL_REFRESH_CACHE_MS,
  minFetchGapMs,
  nextRefreshDelayMs,
  recordFetchAttempt,
  shouldFetchAccount,
  strongerMode,
} from './refreshPolicy';

const MIN = 60 * 1000;
const INTERVAL = 30 * MIN;

test('nextRefreshDelayMs: fast while consumption rises, the configured interval otherwise', () => {
  assert.equal(nextRefreshDelayMs(true, INTERVAL), FAST_REFRESH_MS);
  assert.equal(nextRefreshDelayMs(false, INTERVAL), INTERVAL);
  // A configured interval already at the fast pace is never slowed down.
  assert.equal(nextRefreshDelayMs(true, 5 * MIN), 5 * MIN);
});

test('minFetchGapMs doubles per consecutive failure, capped at the configured interval', () => {
  assert.equal(minFetchGapMs(0, INTERVAL), 5 * MIN);
  assert.equal(minFetchGapMs(1, INTERVAL), 10 * MIN);
  assert.equal(minFetchGapMs(2, INTERVAL), 20 * MIN);
  assert.equal(minFetchGapMs(3, INTERVAL), INTERVAL);
  assert.equal(minFetchGapMs(10, INTERVAL), INTERVAL);
});

test('shouldFetchAccount: first fetch and forced refreshes always fetch', () => {
  assert.equal(shouldFetchAccount(undefined, 'scheduled', 0, INTERVAL), true);
  const justFailed = { lastAttemptAt: 1000, failures: 5 };
  assert.equal(shouldFetchAccount(justFailed, 'forced', 1001, INTERVAL), true);
});

test('shouldFetchAccount: a scheduled tick respects the backoff of a failing account', () => {
  const failedOnce = recordFetchAttempt(undefined, 0, false);
  assert.equal(failedOnce.failures, 1);
  assert.equal(shouldFetchAccount(failedOnce, 'scheduled', 5 * MIN, INTERVAL), false);
  assert.equal(shouldFetchAccount(failedOnce, 'scheduled', 10 * MIN, INTERVAL), true);
  // A tick a few seconds early still counts.
  assert.equal(shouldFetchAccount(failedOnce, 'scheduled', 10 * MIN - 5000, INTERVAL), true);
  const healthy = recordFetchAttempt(failedOnce, 0, true);
  assert.equal(healthy.failures, 0);
  assert.equal(shouldFetchAccount(healthy, 'scheduled', 5 * MIN, INTERVAL), true);
});

test('shouldFetchAccount: a manual refresh right after a fetch reuses it', () => {
  const state = recordFetchAttempt(undefined, 0, true);
  assert.equal(shouldFetchAccount(state, 'manual', MANUAL_REFRESH_CACHE_MS - 1, INTERVAL), false);
  assert.equal(shouldFetchAccount(state, 'manual', MANUAL_REFRESH_CACHE_MS, INTERVAL), true);
});

test('strongerMode keeps the stronger request', () => {
  assert.equal(strongerMode('scheduled', 'manual'), 'manual');
  assert.equal(strongerMode('forced', 'manual'), 'forced');
  assert.equal(strongerMode('scheduled', 'scheduled'), 'scheduled');
});
