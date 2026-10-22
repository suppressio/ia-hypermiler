import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BADGE_SIZE, badgeText, badgeTone, pickBadge, renderBadge } from './trayBadge';
import type { QuotaWindow } from '../types/index';

const window: QuotaWindow = { id: 'any-window', label: 'Limit', periodType: 'rolling-days', periodLength: 7, used: 42, total: 100, unit: 'percentage', resetsAt: null };
const accounts = [
  { accountId: 'a', criticalWindow: { ...window, used: 62 }, stale: false },
  { accountId: 'b', criticalWindow: { ...window, unit: 'count' as const, used: 270, total: 300 }, stale: true },
  { accountId: 'c', criticalWindow: null, stale: false },
];

test('badge: critical picks the highest account, an id picks that account', () => {
  assert.deepEqual(pickBadge(accounts, 'critical'), { percent: 90, stale: true });
  assert.deepEqual(pickBadge(accounts, 'a'), { percent: 62, stale: false });
});

test('badge: off, unknown usage and removed accounts', () => {
  assert.equal(pickBadge(accounts, 'off'), null);
  assert.equal(pickBadge([], 'critical'), null);
  assert.deepEqual(pickBadge(accounts, 'gone'), { percent: 90, stale: true });
  assert.deepEqual(pickBadge(accounts, 'c'), { percent: 90, stale: true });
});

test('badge tone follows the notification threshold, stale wins', () => {
  assert.equal(badgeTone({ percent: 74, stale: false }, 80), 'ok');
  assert.equal(badgeTone({ percent: 75, stale: false }, 80), 'caution');
  assert.equal(badgeTone({ percent: 80, stale: false }, 80), 'warning');
  assert.equal(badgeTone({ percent: 99, stale: true }, 80), 'stale');
});

test('badge text is a rounded 0-100 integer', () => {
  assert.equal(badgeText(61.6), '62');
  assert.equal(badgeText(130), '100');
  assert.equal(badgeText(-3), '0');
});

test('badge bitmap: right size, transparent corners, white digits inside', () => {
  const lit = (pixels: Uint8Array, x: number, y: number) => pixels.slice((y * BADGE_SIZE + x) * 4, (y * BADGE_SIZE + x) * 4 + 4).join(',');
  for (const percent of [0, 7, 62, 100]) {
    const pixels = renderBadge(percent, 'ok');
    assert.equal(pixels.length, BADGE_SIZE * BADGE_SIZE * 4);
    assert.equal(lit(pixels, 0, 0), '0,0,0,0');
    assert.equal(lit(pixels, 16, 1), '22,163,74,255');
    let white = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 255 && pixels[i + 1] === 255 && pixels[i + 2] === 255) white++;
    assert.ok(white > 30, `digits drawn for ${String(percent)}`);
  }
  assert.notDeepEqual(renderBadge(62, 'ok'), renderBadge(63, 'ok'));
});
