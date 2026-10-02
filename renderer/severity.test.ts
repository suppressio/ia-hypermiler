// renderer/severity.test.ts — warning colour thresholds of percent-of-quota values (issue #13).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityLevel } from './severity.js';

test('severityLevel: orange 5 points below the threshold, red from the threshold', () => {
  assert.equal(severityLevel(74.9, 80), 'none');
  assert.equal(severityLevel(75, 80), 'caution');
  assert.equal(severityLevel(79.9, 80), 'caution');
  assert.equal(severityLevel(80, 80), 'warning');
  assert.equal(severityLevel(250, 80), 'warning'); // a projection far over the limit
});

test('severityLevel follows a custom threshold and ignores missing values', () => {
  assert.equal(severityLevel(66, 70), 'caution');
  assert.equal(severityLevel(70, 70), 'warning');
  assert.equal(severityLevel(null, 80), 'none');
  assert.equal(severityLevel(undefined, 80), 'none');
  assert.equal(severityLevel(Number.NaN, 80), 'none');
});
