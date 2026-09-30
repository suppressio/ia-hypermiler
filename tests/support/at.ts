// tests/support/at.ts — accesso per indice nei test con noUncheckedIndexedAccess:
// verifica con un assert che l'elemento esista e lo restituisce tipizzato. Un
// indice sbagliato fallisce con un messaggio esplicito invece di un TypeError.

import assert from 'node:assert/strict';

export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `atteso un elemento all'indice ${index} (lunghezza ${items.length})`);
  return item;
}
