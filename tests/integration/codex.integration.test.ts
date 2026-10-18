// Real HTTP test, enabled only by local credentials in .env.test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUsage } from '../../services/codex';

const cookieHeader = process.env.HYPERMILER_TEST_CODEX_COOKIE_HEADER;
const userAgent = process.env.HYPERMILER_TEST_CODEX_USER_AGENT;
test('Codex account returns recognizable quota windows', {
  skip: cookieHeader && userAgent ? false : 'Codex cookie header and partition User-Agent not set',
}, async () => {
  assert.ok(cookieHeader && userAgent);
  const usage = await fetchUsage({ cookieHeader, userAgent });
  assert.ok(usage.quotaWindows.length > 0);
  for (const window of usage.quotaWindows) {
    assert.equal(window.unit, 'percentage');
    assert.ok(window.used >= 0 && window.used <= 100);
  }
});
