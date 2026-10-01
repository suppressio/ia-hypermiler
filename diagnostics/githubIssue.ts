// diagnostics/githubIssue.ts — builds the URL of a pre-filled GitHub issue when a
// service detects that an endpoint format changed (see services/_shape.ts, main.ts).
// Pure function, no Electron dependency: actually opening the browser
// (shell.openExternal) stays in main.ts. The issue goes to a public repository, so its
// text is in English regardless of the UI language.
//
// It deliberately does NOT automate issue creation through the GitHub API: it only
// opens a pre-filled draft that the user must review and submit — an explicit choice
// never to publish real data without a confirming human click (see CLAUDE.md).

import type { ProviderId } from '../types/index';

const REPO_OWNER = 'suppressio';
const REPO_NAME = 'ia-hypermiler';

export interface FormatDriftIssueParams {
  provider: ProviderId;
  endpointLabel: string;
  shape: unknown;
}

export function buildFormatDriftIssueUrl({ provider, endpointLabel, shape }: FormatDriftIssueParams): string {
  const serviceName = provider === 'claude' ? 'Claude' : 'Copilot';
  const title = `Response format changed: ${serviceName} (${endpointLabel})`;

  const body = [
    `Detected automatically by IA Hypermiler on ${new Date().toISOString()}.`,
    '',
    `Service: **${serviceName}**`,
    `Endpoint: \`${endpointLabel}\``,
    '',
    'Structure of the received response — field names and types only, **never real values** ' +
      '(usage percentages, amounts and renewal dates are never included here, see CLAUDE.md):',
    '',
    '```json',
    JSON.stringify(shape, null, 2),
    '```',
    '',
    `Previously expected format: see \`RESEARCH.md\` and \`services/${provider}.ts\`.`,
    '',
    '_Draft generated automatically — review the content before submitting._',
  ].join('\n');

  const url = new URL(`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  url.searchParams.set('labels', 'api-drift,auto-generated');
  return url.toString();
}
