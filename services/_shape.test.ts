// services/_shape.test.ts — test unitari per la riduzione a "solo struttura" usata
// dalla segnalazione automatica di format-drift (vedi CLAUDE.md). Critico verificare
// che nessun valore reale (percentuali, importi, date) sopravviva a extractShape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractShape, shapeSignature, FormatDriftError } from './_shape';

test('extractShape riduce valori scalari al loro typeof', () => {
  const shape = extractShape({ used_dollars: 389.19, label: 'Cinder Cove', active: true, resets_at: null });
  assert.deepEqual(shape, {
    active: 'boolean',
    label: 'string',
    resets_at: 'null',
    used_dollars: 'number',
  });
});

test('extractShape non contiene mai il valore reale, solo il tipo', () => {
  const shape = extractShape({ used_dollars: 389.19, limit_dollars: 1000 });
  const json = JSON.stringify(shape);
  assert.ok(!json.includes('389.19'));
  assert.ok(!json.includes('1000'));
});

test('extractShape ordina le chiavi per una firma stabile indipendente dall\'ordine originale', () => {
  const a = extractShape({ b: 1, a: 2 });
  const b = extractShape({ a: 2, b: 1 });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { a: 'number', b: 'number' });
});

test('extractShape riduce gli array a un solo elemento rappresentativo', () => {
  const shape = extractShape({ items: [{ quantity: 1 }, { quantity: 2 }, { quantity: 3 }] });
  assert.deepEqual(shape, { items: [{ quantity: 'number' }] });
});

test('extractShape gestisce array vuoti', () => {
  assert.deepEqual(extractShape({ items: [] }), { items: [] });
});

test('extractShape si ferma dopo una profondità massima (niente stack overflow su payload annidati)', () => {
  let deep: unknown = { leaf: 1 };
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  const shape = extractShape(deep);
  assert.equal(JSON.stringify(shape).includes('truncated'), true);
});

test('extractShape gestisce oggetti annidati a più livelli', () => {
  const shape = extractShape({ quota_snapshots: { five_hour: { percent_remaining: 61.5 } } });
  assert.deepEqual(shape, { quota_snapshots: { five_hour: { percent_remaining: 'number' } } });
});

test('shapeSignature è deterministica per la stessa shape', () => {
  const shape = extractShape({ a: 1, b: 'x' });
  assert.equal(shapeSignature(shape), shapeSignature(extractShape({ b: 'y', a: 2 })));
});

test('shapeSignature cambia se la struttura cambia', () => {
  const sigA = shapeSignature(extractShape({ a: 1 }));
  const sigB = shapeSignature(extractShape({ a: 1, b: 2 }));
  assert.notEqual(sigA, sigB);
});

test('FormatDriftError porta endpointLabel e shape, mai il payload originale', () => {
  const shape = extractShape({ used_dollars: 42 });
  const err = new FormatDriftError('messaggio di test', 'claude.ai/api/organizations/{id}/usage', shape);
  assert.equal(err.name, 'FormatDriftError');
  assert.equal(err.endpointLabel, 'claude.ai/api/organizations/{id}/usage');
  assert.deepEqual(err.shape, { used_dollars: 'number' });
  assert.ok(err instanceof Error);
});
