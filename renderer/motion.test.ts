import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlarmPulse, motionState } from './motion.js';

test('motion policy: setting off keeps only refresh rotation; reduced motion and hidden windows stop everything', () => {
  assert.deepEqual(motionState(true, false, true), { effects: true, rotateRefresh: false });
  assert.deepEqual(motionState(false, false, true), { effects: false, rotateRefresh: true });
  for (const enabled of [true, false]) {
    assert.deepEqual(motionState(enabled, true, true), { effects: false, rotateRefresh: false });
    assert.deepEqual(motionState(enabled, false, false), { effects: false, rotateRefresh: false });
  }
});

test('alarm pulse: waits 10 seconds, pulses once for 1.5 seconds, then rests', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const changes: boolean[] = [];
  const pulse = createAlarmPulse((active) => { changes.push(active); });
  pulse.setActive(true);
  pulse.setActive(true); // Rendering again must not duplicate or postpone the timer.
  context.mock.timers.tick(9999);
  assert.deepEqual(changes, []);
  context.mock.timers.tick(1);
  assert.deepEqual(changes, [true]);
  context.mock.timers.tick(1500);
  assert.deepEqual(changes, [true, false]);
  context.mock.timers.tick(8500);
  assert.deepEqual(changes, [true, false, true]);
  pulse.setActive(false);
});

test('alarm pulse: stopping clears both timers, including a pulse in progress; restarting waits a full period', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const changes: boolean[] = [];
  const pulse = createAlarmPulse((active) => { changes.push(active); });
  pulse.setActive(true);
  context.mock.timers.tick(10000);
  pulse.setActive(false);
  assert.deepEqual(changes, [true, false]);
  context.mock.timers.tick(30000);
  assert.deepEqual(changes, [true, false]);
  pulse.setActive(true);
  context.mock.timers.tick(9999);
  assert.deepEqual(changes, [true, false]);
  pulse.setActive(false);
  context.mock.timers.tick(30000);
  assert.deepEqual(changes, [true, false]);
});
