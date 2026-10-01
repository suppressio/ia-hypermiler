// tests/integration/copilot.integration.test.ts — tests against the real GitHub
// endpoints (RESEARCH.md v3 §2). They activate only when the right environment
// variables are set — see .env.test.example and claude.integration.test.ts for the
// full procedure to provide credentials safely, locally.
//
// Expected variables:
//   HYPERMILER_TEST_COPILOT_TOKEN  — fine-grained PAT with "Plan" (read) permission
//   HYPERMILER_TEST_COPILOT_SCOPE  — 'personal' (default) or 'organization'
//                                    to test the best-effort company-seat path

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as copilotService from '../../services/copilot';

const token = process.env.HYPERMILER_TEST_COPILOT_TOKEN;
const scope = (process.env.HYPERMILER_TEST_COPILOT_SCOPE || 'personal') as 'personal' | 'organization';

const skipReason = token
  ? false
  : 'HYPERMILER_TEST_COPILOT_TOKEN not set — see the file header for how to provide it locally';

test('resolveUsername on a real token returns a plausible username', { skip: skipReason }, async () => {
  const username = await copilotService.resolveUsername(token as string);
  assert.equal(typeof username, 'string');
  assert.ok(username.length > 0);
});

test('fetchUsage on a real account returns at least one quota window', { skip: skipReason }, async () => {
  const result = await copilotService.fetchUsage({ token: token as string, accountScope: scope, manualQuota: 300 });

  assert.ok(Array.isArray(result.quotaWindows));
  assert.ok(result.quotaWindows.length > 0);

  for (const win of result.quotaWindows) {
    assert.equal(typeof win.used, 'number');
    if (win.unit === 'percentage') {
      assert.ok(win.used >= 0 && win.used <= 100, `utilization out of range: ${win.used}`);
    }
  }

  if (scope === 'organization') {
    // Best-effort path (RESEARCH.md v3 §2.2): getting here without exceptions means the
    // internal endpoint answered in a recognized format — useful to know right away when
    // GitHub changes something, instead of finding out from the app in production.
    console.log('[integration] Copilot company seat: internal endpoint still compatible.');
  }
});
