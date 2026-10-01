// services/_shape.test.ts — unit tests for the "structure only" reduction used by the
// automatic format-drift report (see CLAUDE.md). It is critical to check that no real
// value (percentages, amounts, dates) survives extractShape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractShape, shapeSignature, FormatDriftError } from './_shape';

test('extractShape reduces scalar values to their typeof', () => {
  const shape = extractShape({ used_dollars: 389.19, label: 'Cinder Cove', active: true, resets_at: null });
  assert.deepEqual(shape, {
    active: 'boolean',
    label: 'string',
    resets_at: 'null',
    used_dollars: 'number',
  });
});

test('extractShape never contains the real value, only the type', () => {
  const shape = extractShape({ used_dollars: 389.19, limit_dollars: 1000 });
  const json = JSON.stringify(shape);
  assert.ok(!json.includes('389.19'));
  assert.ok(!json.includes('1000'));
});

test('extractShape sorts keys for a stable signature independent of the original order', () => {
  const a = extractShape({ b: 1, a: 2 });
  const b = extractShape({ a: 2, b: 1 });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { a: 'number', b: 'number' });
});

test('extractShape reduces arrays to a single representative element', () => {
  const shape = extractShape({ items: [{ quantity: 1 }, { quantity: 2 }, { quantity: 3 }] });
  assert.deepEqual(shape, { items: [{ quantity: 'number' }] });
});

test('extractShape handles empty arrays', () => {
  assert.deepEqual(extractShape({ items: [] }), { items: [] });
});

test('extractShape stops after a maximum depth (no stack overflow on nested payloads)', () => {
  let deep: unknown = { leaf: 1 };
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  const shape = extractShape(deep);
  assert.equal(JSON.stringify(shape).includes('truncated'), true);
});

test('extractShape handles multi-level nested objects', () => {
  const shape = extractShape({ quota_snapshots: { five_hour: { percent_remaining: 61.5 } } });
  assert.deepEqual(shape, { quota_snapshots: { five_hour: { percent_remaining: 'number' } } });
});

test('shapeSignature is deterministic for the same shape', () => {
  const shape = extractShape({ a: 1, b: 'x' });
  assert.equal(shapeSignature(shape), shapeSignature(extractShape({ b: 'y', a: 2 })));
});

test('shapeSignature changes when the structure changes', () => {
  const sigA = shapeSignature(extractShape({ a: 1 }));
  const sigB = shapeSignature(extractShape({ a: 1, b: 2 }));
  assert.notEqual(sigA, sigB);
});

test('FormatDriftError carries endpointLabel and shape, never the original payload', () => {
  const shape = extractShape({ used_dollars: 42 });
  const err = new FormatDriftError('test message', 'claude.ai/api/organizations/{id}/usage', shape);
  assert.equal(err.name, 'FormatDriftError');
  assert.equal(err.endpointLabel, 'claude.ai/api/organizations/{id}/usage');
  assert.deepEqual(err.shape, { used_dollars: 'number' });
  assert.ok(err instanceof Error);
});
