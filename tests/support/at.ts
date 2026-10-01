// tests/support/at.ts — indexed access in tests under noUncheckedIndexedAccess: checks
// with an assert that the element exists and returns it typed. A wrong index fails
// with an explicit message instead of a TypeError.

import assert from 'node:assert/strict';

export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an element at index ${index} (length ${items.length})`);
  return item;
}
