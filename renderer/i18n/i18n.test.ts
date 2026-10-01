// renderer/i18n/i18n.test.ts — renderer dictionaries and helpers. Key parity is
// already enforced by the compiler (it.ts is Record<MessageKey, string>); these
// tests also check placeholders, which the compiler cannot see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, interpolate, placeholdersOf, resolveLocale, setLocale, t } from './index.js';

test('every Italian message uses exactly the same placeholders as the English one', () => {
  for (const [key, english] of Object.entries(dictionaries.en)) {
    const italian = (dictionaries.it as Record<string, string>)[key];
    assert.ok(italian !== undefined, `missing Italian key: ${key}`);
    assert.deepEqual(placeholdersOf(italian), placeholdersOf(english), `placeholders differ for ${key}`);
  }
  assert.equal(Object.keys(dictionaries.it).length, Object.keys(dictionaries.en).length);
});

test('no message is empty', () => {
  for (const locale of ['en', 'it'] as const) {
    for (const [key, value] of Object.entries(dictionaries[locale])) {
      assert.ok(value.trim().length > 0, `${locale}: empty message ${key}`);
    }
  }
});

test('resolveLocale: explicit choice wins, auto follows the system language', () => {
  assert.equal(resolveLocale('en', 'it-IT'), 'en');
  assert.equal(resolveLocale('it', 'en-US'), 'it');
  assert.equal(resolveLocale('auto', 'it-IT'), 'it');
  assert.equal(resolveLocale('auto', 'it'), 'it');
  assert.equal(resolveLocale('auto', 'IT-ch'), 'it');
  assert.equal(resolveLocale('auto', 'en-GB'), 'en');
  assert.equal(resolveLocale('auto', 'de-DE'), 'en');
});

test('interpolate fills known placeholders and leaves unknown ones visible', () => {
  assert.equal(interpolate('{a} and {b}', { a: 1, b: 'two' }), '1 and two');
  assert.equal(interpolate('{a} and {missing}', { a: 1 }), '1 and {missing}');
});

test('t() follows the active locale', () => {
  setLocale('it');
  assert.equal(t('settings.updates.download', { version: '1.0.0' }), 'Scarica 1.0.0');
  setLocale('en');
  assert.equal(t('settings.updates.download', { version: '1.0.0' }), 'Download 1.0.0');
});
