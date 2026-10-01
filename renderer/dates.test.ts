// renderer/dates.test.ts — local day keys of the daily history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateKey, parseDateKey } from './dates.js';

test('localDateKey uses the local day, also right after local midnight', () => {
  assert.equal(localDateKey(new Date(2026, 9, 1, 0, 30)), '2026-10-01');
  assert.equal(localDateKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('parseDateKey returns local midnight of the key (round trip)', () => {
  const date = parseDateKey('2026-10-01');
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 9);
  assert.equal(date.getDate(), 1);
  assert.equal(date.getHours(), 0);
  assert.equal(localDateKey(date), '2026-10-01');
});
