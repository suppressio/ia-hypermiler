// tests/integration/claude.integration.test.ts — tests against the real claude.ai
// endpoint (RESEARCH.md v3 §1). NOT run in CI or in environments without network
// access to claude.ai: they activate only when the right environment variables are set.
//
// How to provide the credentials (LOCALLY, never in chat, never committed):
//   1. Copy .env.test.example to .env.test (already in .gitignore).
//   2. Fill HYPERMILER_TEST_CLAUDE_SESSION_KEY with the `sessionKey` cookie captured
//      from a real login (readable with the browser developer tools after signing in
//      to claude.ai, or — better — use the app's own "Connect" flow and copy the value
//      from the encrypted store just for the test, never in clear elsewhere).
//   3. (Optional) HYPERMILER_TEST_CLAUDE_ORG_ID to skip the automatic organization
//      resolution.
//   4. Run `npm test` — Node loads .env.test automatically when present (thanks to
//      --env-file-if-exists, see package.json) and these tests activate on their own
//      instead of being skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeService from '../../services/claude';

const sessionKey = process.env.HYPERMILER_TEST_CLAUDE_SESSION_KEY;
const organizationId = process.env.HYPERMILER_TEST_CLAUDE_ORG_ID;

const skipReason = sessionKey
  ? false
  : 'HYPERMILER_TEST_CLAUDE_SESSION_KEY not set — see the file header for how to provide it locally';

test('listOrganizations on a real account returns at least one organization', { skip: skipReason }, async () => {
  const orgs = await claudeService.listOrganizations(sessionKey as string);
  assert.ok(Array.isArray(orgs));
  assert.ok(orgs.length > 0, 'no organization found for this account');
  for (const org of orgs) {
    assert.equal(typeof org.id, 'string');
  }
});

test('fetchUsage on a real account returns valid quota windows', { skip: skipReason }, async () => {
  const result = await claudeService.fetchUsage({ sessionKey: sessionKey as string, organizationId: organizationId ?? null });

  assert.ok(Array.isArray(result.quotaWindows));
  assert.ok(result.quotaWindows.length > 0, 'RESEARCH.md expected at least one window (five_hour/seven_day/seven_day_opus): the endpoint format may have changed');

  for (const win of result.quotaWindows) {
    assert.equal(win.unit, 'percentage');
    assert.equal(typeof win.used, 'number');
    assert.ok(win.used >= 0 && win.used <= 100, `utilization out of range: ${win.used}`);
  }
});
