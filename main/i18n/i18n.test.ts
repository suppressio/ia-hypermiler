// main/i18n/i18n.test.ts — main-process dictionaries and helpers (same checks as
// renderer/i18n/i18n.test.ts: placeholders are invisible to the compiler).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, interpolate, resolveLocale, setLocale, t } from './index';

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}

test('main: every Italian message uses exactly the same placeholders as the English one', () => {
  for (const [key, english] of Object.entries(dictionaries.en)) {
    const italian = (dictionaries.it as Record<string, string>)[key];
    assert.ok(italian !== undefined, `missing Italian key: ${key}`);
    assert.deepEqual(placeholdersOf(italian), placeholdersOf(english), `placeholders differ for ${key}`);
  }
  assert.equal(Object.keys(dictionaries.it).length, Object.keys(dictionaries.en).length);
});

test('main: resolveLocale matches the renderer rule', () => {
  assert.equal(resolveLocale('auto', 'it-IT'), 'it');
  assert.equal(resolveLocale('auto', 'fr-FR'), 'en');
  assert.equal(resolveLocale('it', 'en-US'), 'it');
});

test('main: t() interpolates in the active locale', () => {
  setLocale('it');
  assert.equal(t('tray.updateAvailable', { version: '1.2.3' }), 'Aggiornamento disponibile (1.2.3)…');
  setLocale('en');
  assert.equal(t('notify.threshold', { account: 'Work', threshold: 80 }), 'Work: you have passed 80% of the budget.');
  assert.equal(interpolate('{x}', {}), '{x}');
});
