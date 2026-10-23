import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompactTransition, createLayoutAnimation, fadeSlide, flipDelta } from './layoutMotion.js';
import { motionState } from './motion.js';

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve = (): void => {};
  let reject = (_error: Error): void => {};
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function compactFixture(initial = false, effects = (): boolean => true) {
  let compact = initial;
  const events: string[] = [];
  const exit = deferred();
  let exiting = false;
  const resized = deferred();
  const resize = deferred();
  const transition = createCompactTransition({
    isCompact: () => compact,
    effects,
    animate: async (expanding) => {
      events.push(expanding ? 'enter' : 'exit');
      if (!expanding) { exiting = true; await exit.promise; exiting = false; }
    },
    finish: () => { if (exiting) exit.resolve(); },
    resize: async (value) => {
      events.push(`resize:${value}`);
      resized.resolve();
      await resize.promise;
    },
    apply: (value) => { compact = value; events.push(`apply:${value}`); },
  });
  return { transition, events, exit, resized, resize, compact: () => compact };
}

test('FLIP: translations invert layout displacement in both directions without scaling', () => {
  const collapsed = { left: 14, top: 500 };
  const expanded = { left: 14, top: 560 };
  assert.deepEqual(flipDelta(collapsed, expanded), { x: 0, y: -60 });
  assert.deepEqual(flipDelta(expanded, collapsed), { x: 0, y: 60 });
  assert.deepEqual(flipDelta(expanded, expanded), { x: 0, y: 0 });
  assert.deepEqual(flipDelta({ left: 10, top: 20 }, { left: 15, top: 30 }), { x: -5, y: -10 });
});

test('fade/slide: preserves the CSS opacity and animates only opacity and transform for 200 ms', (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ opacity: '0.75' }) });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'getComputedStyle', previous);
    else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  });
  const calls: { frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
  const element = {
    animate: (frames: Keyframe[], options: KeyframeAnimationOptions) => {
      calls.push({ frames, options });
      return {} as Animation;
    },
  } as unknown as HTMLElement;
  fadeSlide(element, true);
  fadeSlide(element, false);
  const hidden = { opacity: 0, transform: 'translateY(-6px)' };
  const visible = { opacity: '0.75', transform: 'translateY(0)' };
  const options = { duration: 200, easing: 'ease-out', fill: 'both' };
  assert.deepEqual(calls, [{ frames: [hidden, visible], options }, { frames: [visible, hidden], options }]);
});

test('compact sequence: exit precedes shrinking; expansion resizes and applies layout before entry', async () => {
  for (const initial of [false, true]) {
    const fixture = compactFixture(initial);
    const done = fixture.transition.toggle();
    if (!initial) assert.deepEqual(fixture.events, ['exit']);
    fixture.exit.resolve();
    await fixture.resized.promise;
    assert.equal(fixture.compact(), initial);
    assert.deepEqual(fixture.events, initial ? ['resize:false'] : ['exit', 'resize:true']);
    fixture.resize.resolve();
    await done;
    assert.deepEqual(fixture.events, initial
      ? ['resize:false', 'apply:false', 'enter']
      : ['exit', 'resize:true', 'apply:true']);
  }
});

test('compact sequence: disabled, reduced-motion and hidden policies skip effects', async () => {
  for (const [enabled, reduced, visible] of [[false, false, true], [true, true, true], [true, false, false]] as const) {
    for (const initial of [false, true]) {
      const fixture = compactFixture(initial, () => motionState(enabled, reduced, visible).effects);
      fixture.resize.resolve();
      await fixture.transition.toggle();
      assert.deepEqual(fixture.events, [`resize:${!initial}`, `apply:${!initial}`]);
    }
  }
});

test('compact sequence: a second click during exit cancels the pending resize', async () => {
  const fixture = compactFixture();
  const first = fixture.transition.toggle();
  const second = fixture.transition.toggle();
  assert.equal(first, second);
  await first;
  assert.equal(fixture.compact(), false);
  assert.deepEqual(fixture.events, ['exit']);
});

test('compact sequence: three rapid clicks settle in compact mode with only one resize', async () => {
  const fixture = compactFixture();
  const done = fixture.transition.toggle();
  assert.equal(fixture.transition.toggle(), done);
  assert.equal(fixture.transition.toggle(), done);
  fixture.resize.resolve();
  await done;
  assert.equal(fixture.compact(), true);
  assert.deepEqual(fixture.events, ['exit', 'resize:true', 'apply:true']);
});

test('compact sequence: clicks during resize are serialized and the latest choice wins', async () => {
  const fixture = compactFixture(true);
  const done = fixture.transition.toggle();
  await fixture.resized.promise;
  assert.equal(fixture.transition.toggle(), done);
  fixture.resize.resolve();
  fixture.exit.resolve();
  await done;
  assert.equal(fixture.compact(), true);
  assert.deepEqual(fixture.events, ['resize:false', 'apply:false', 'exit', 'resize:true', 'apply:true']);
});

test('compact sequence: failed IPC leaves layout unchanged and the next click can retry', async () => {
  let attempts = 0;
  let compact = false;
  const transition = createCompactTransition({
    isCompact: () => compact, effects: () => false,
    animate: async () => {}, finish: () => {},
    resize: async () => { if (++attempts === 1) throw new Error('Resize failed'); },
    apply: (value) => { compact = value; },
  });
  await assert.rejects(transition.toggle(), /Resize failed/);
  assert.equal(compact, false);
  await transition.toggle();
  assert.equal(compact, true);
});

test('layout batch: finishing early cancels all effects and cleans up exactly once', async () => {
  const animation = deferred();
  let cancelled = 0;
  let cleaned = 0;
  const batch = createLayoutAnimation();
  const done = batch.play([{ finished: animation.promise, cancel: () => { cancelled++; animation.reject(new Error('Cancelled')); } }],
    () => { cleaned++; });
  batch.finish();
  batch.finish();
  await done;
  assert.equal(cancelled, 1);
  assert.equal(cleaned, 1);
});

test('layout batch: normal completion cleans up; compact exit holds its final frame until resize finishes', async () => {
  for (const hold of [false, true]) {
    const animation = deferred();
    let cleaned = 0;
    const batch = createLayoutAnimation(hold);
    const done = batch.play([{ finished: animation.promise, cancel: () => {} }], () => { cleaned++; });
    animation.resolve();
    await done;
    assert.equal(cleaned, hold ? 0 : 1);
    batch.finish();
    assert.equal(cleaned, 1);
  }
});
