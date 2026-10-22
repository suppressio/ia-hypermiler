import { test } from 'node:test';
import assert from 'node:assert/strict';
import { odometerColumns } from './odometer.js';

test('odometer: first render, unchanged values and placeholders stay static', () => {
  assert.equal(odometerColumns(null, '12.3%'), null);
  assert.equal(odometerColumns('12.3%', '12.3%'), null);
  assert.equal(odometerColumns('--%', '12.3%'), null);
  assert.equal(odometerColumns('12.3%', '--%'), null);
});

test('odometer: each changed digit rolls upwards, with carry and a new leading digit', () => {
  assert.deepEqual(odometerColumns('9.9%', '10.0%'), [
    { digits: [0, 1] }, { digits: [9, 0] }, '.', { digits: [9, 0] }, '%',
  ]);
});

test('odometer: unchanged digits and locale punctuation remain literal', () => {
  assert.deepEqual(odometerColumns('1.234,5%', '1.236,5%', ','), [
    '1', '.', '2', '3', { digits: [4, 5, 6] }, ',', '5', '%',
  ]);
});

test('odometer: changing decimal precision keeps integer places aligned', () => {
  assert.deepEqual(odometerColumns('12%', '12.3%'), ['1', '2', '.', { digits: [0, 1, 2, 3] }, '%']);
  assert.deepEqual(odometerColumns('12.9%', '13%'), ['1', { digits: [2, 3] }, '%']);
});

test('odometer: quota resets, shrinking values and zeros end on the exact new value', () => {
  assert.deepEqual(odometerColumns('100%', '0%'), ['0', '%']);
  assert.deepEqual(odometerColumns('8%', '2%'), [{ digits: [8, 9, 0, 1, 2] }, '%']);
  assert.deepEqual(odometerColumns('0%', '0.1%'), ['0', '.', { digits: [0, 1] }, '%']);
});
