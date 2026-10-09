import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaugePosition } from './gauge.js';

test('gaugePosition: the target sits in the middle, doubling or halving moves a quarter', () => {
  assert.equal(gaugePosition(1, 1), 0.5);
  assert.equal(gaugePosition(2, 1), 0.75);
  assert.equal(gaugePosition(0.5, 1), 0.25);
  assert.equal(gaugePosition(4, 1), 1);
});

test('gaugePosition: the same ratio lands in the same place whatever the target', () => {
  assert.equal(gaugePosition(3, 0.8), gaugePosition(3 * 4, 0.8 * 4));
});

test('gaugePosition: clamped at the ends, tiny consumption still visible', () => {
  assert.equal(gaugePosition(0, 1), 0);
  assert.equal(gaugePosition(100, 1), 1);
  assert.equal(gaugePosition(0.001, 1), 0.02);
  assert.equal(gaugePosition(1, 0), 1); // nothing left to spend: any pace is too much
});
