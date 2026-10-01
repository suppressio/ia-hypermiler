// diagnostics/githubIssue.test.ts — checks that the automatically generated GitHub
// issue draft never contains real values, only the response structure (see
// services/_shape.ts, CLAUDE.md). No network call: buildFormatDriftIssueUrl is a pure
// function that only builds the URL, opening the browser stays in main.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFormatDriftIssueUrl } from './githubIssue';
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
