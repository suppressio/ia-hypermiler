// main/codex-session-cookie.test.ts — imports only the pure helper; tests run in plain Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCodexSessionCookie } from './codex-session-cookie';

test('isCodexSessionCookie recognizes unchunked and chunked session cookies', () => {
  for (const name of [
    '__Secure-next-auth.session-token',
    '__Secure-next-auth.session-token.0',
    '__Secure-next-auth.session-token.1',
  ]) {
    assert.equal(isCodexSessionCookie(name), true, name);
  }
});

test('isCodexSessionCookie ignores unrelated cookies and requires the exact prefix', () => {
  for (const name of ['', 'cf_clearance', '__cf_bm', '__Secure-next-auth.csrf-token',
    'next-auth.session-token', 'prefix__Secure-next-auth.session-token',
    '__secure-next-auth.session-token']) {
    assert.equal(isCodexSessionCookie(name), false, name);
  }
});
