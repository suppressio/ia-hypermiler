// diagnostics/githubIssue.test.ts — checks that the automatically generated GitHub
// issue draft never contains real values, only the response structure (see
// services/_shape.ts, CLAUDE.md). No network call: buildFormatDriftIssueUrl is a pure
// function that only builds the URL, opening the browser stays in main.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormatDriftIssueUrl, buildResponseReportIssueUrl, redactResponse } from './githubIssue';
import { extractShape } from '../services/_shape';

test('buildFormatDriftIssueUrl points to the right repo with new issue', () => {
  const url = buildFormatDriftIssueUrl({ provider: 'claude', endpointLabel: 'x', shape: {} });
  assert.match(url, /^https:\/\/github\.com\/suppressio\/ia-hypermiler\/issues\/new\?/);
});

test('buildFormatDriftIssueUrl includes a title with the readable service name', () => {
  const urlClaude = buildFormatDriftIssueUrl({ provider: 'claude', endpointLabel: 'ep', shape: {} });
  const urlCopilot = buildFormatDriftIssueUrl({ provider: 'copilot', endpointLabel: 'ep', shape: {} });
  const titleClaude = new URL(urlClaude).searchParams.get('title') || '';
  const titleCopilot = new URL(urlCopilot).searchParams.get('title') || '';
  assert.match(titleClaude, /Claude/);
  assert.match(titleCopilot, /Copilot/);
});

test('buildFormatDriftIssueUrl sets the expected labels', () => {
  const url = buildFormatDriftIssueUrl({ provider: 'claude', endpointLabel: 'ep', shape: {} });
  assert.equal(new URL(url).searchParams.get('labels'), 'api-drift,auto-generated');
});

test('buildFormatDriftIssueUrl never contains real values, only the reduced shape', () => {
  const shape = extractShape({ used_dollars: 389.19, limit_dollars: 1000, resets_at: '2026-09-13T14:38:47.107149+00:00' });
  const url = buildFormatDriftIssueUrl({
    provider: 'claude',
    endpointLabel: 'claude.ai/api/organizations/{id}/usage',
    shape,
  });
  const body = new URL(url).searchParams.get('body') || '';
  assert.ok(!body.includes('389.19'));
  assert.ok(!body.includes('1000'));
  assert.ok(!body.includes('2026-09-13'));
  assert.ok(body.includes('"used_dollars": "number"'));
});

test('buildFormatDriftIssueUrl includes a manual review reminder in the body', () => {
  const url = buildFormatDriftIssueUrl({ provider: 'copilot', endpointLabel: 'ep', shape: {} });
  const body = new URL(url).searchParams.get('body') || '';
  assert.match(body, /review the content before submitting/i);
});

// ---------------------------------------------------------------------------
// Manual response report: values kept, strings redacted.
// ---------------------------------------------------------------------------

test('redactResponse keeps numbers, booleans, null, dates and enum-like fields; redacts other strings', () => {
  const response = {
    extra_usage: { utilization: 33.3, is_enabled: true, monthly_limit: null, resets_at: '2026-11-01T00:00:00+00:00' },
    spend: { percent: 33.3, used: { amount_minor: 3330, currency: 'USD', exponent: 2 }, severity: 'normal', disclaimer: 'Some long free text' },
    organization_uuid: '0b8c1d2e-aaaa-bbbb-cccc-1234567890ab',
    limits: [{ name: 'Jane Doe', value: 3 }],
  };
  assert.deepEqual(redactResponse(response), {
    extra_usage: { is_enabled: true, monthly_limit: null, resets_at: '2026-11-01T00:00:00+00:00', utilization: 33.3 },
    limits: [{ name: '<string, 8 chars>', value: 3 }],
    organization_uuid: '<string, 36 chars>',
    spend: {
      disclaimer: '<string, 19 chars>',
      percent: 33.3,
      severity: 'normal',
      used: { amount_minor: 3330, currency: 'USD', exponent: 2 },
    },
  });
  // An enum-like key with a long value is redacted all the same.
  assert.equal(redactResponse('x'.repeat(40), 'type'), '<string, 40 chars>');
});

test('buildResponseReportIssueUrl: one section per account, values kept, strings redacted, errors shortened', () => {
  const url = buildResponseReportIssueUrl({
    accounts: [
      { name: 'Claude #1', endpointLabel: 'claude.ai/api/organizations/{id}/usage', response: { spend: { percent: 33.3 }, account_email: 'someone@example.com' } },
      { name: 'Copilot #1', endpointLabel: '{api}/copilot_internal/user', error: 'copilot_internal/user answered 401 Unauthorized — <html>secret page</html>' },
    ],
    appVersion: '0.4.10-beta',
  });
  assert.match(url, /^https:\/\/github\.com\/suppressio\/ia-hypermiler\/issues\/new\?/);
  const params = new URL(url).searchParams;
  const body = params.get('body') ?? '';
  assert.ok(body.includes('### Claude #1'));
  assert.ok(body.includes('### Copilot #1'));
  assert.ok(body.includes('33.3'));
  assert.ok(!body.includes('someone@example.com'));
  assert.ok(body.includes('Could not be read: copilot_internal/user answered 401 Unauthorized'));
  assert.ok(!body.includes('secret page'));
  assert.match(body, /real usage values/);
  assert.equal(params.get('title'), 'Usage response report (Claude #1, Copilot #1)');
  assert.equal(params.get('labels'), 'response-report');
});

test('buildResponseReportIssueUrl truncates very long responses to fit a link', () => {
  const response = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field_${String(i)}`, i]));
  const url = buildResponseReportIssueUrl({
    accounts: [{ name: 'Claude #1', endpointLabel: 'ep', response }, { name: 'Copilot #1', endpointLabel: 'ep2', response }],
    appVersion: '0',
  });
  const body = new URL(url).searchParams.get('body') ?? '';
  assert.match(body, /Truncated to fit/);
  assert.ok(url.length <= 7500);
  assert.ok(body.includes('### Copilot #1'));
});
