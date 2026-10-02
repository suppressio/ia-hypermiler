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

// ---------------------------------------------------------------------------
// Manual "report response" (Settings, Claude account detail): unlike the automatic
// format-drift draft above it carries the response VALUES, because deciding how to
// read a field (e.g. two objects that may report the same budget) needs them. Still only
// a draft the user opens on purpose, reviews and may never submit; strings are
// redacted (ids, names, free text) except dates and a few enum-like fields.
// ---------------------------------------------------------------------------

// Enum-like string fields whose value says what a field means, not who the user is.
const KEPT_STRING_KEYS = new Set(['currency', 'severity', 'type', 'status', 'kind', 'unit', 'period', 'interval']);
const MAX_KEPT_STRING_LENGTH = 32;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_REDACT_DEPTH = 8;
// GitHub rejects very long new-issue URLs (~8 KB): pretty JSON first, compact JSON
// when that is too long, and cut beyond this length as a last resort.
const MAX_ISSUE_URL_LENGTH = 7500;

/**
 * Copy of a response safe to put in a public issue draft: numbers, booleans, null
 * and ISO dates kept; strings kept only under KEPT_STRING_KEYS and when short; any
 * other string replaced by its length. Field names are kept (they are the format).
 */
export function redactResponse(value: unknown, key = '', depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '<truncated>';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) return value;
    if (KEPT_STRING_KEYS.has(key) && value.length <= MAX_KEPT_STRING_LENGTH) return value;
    return `<string, ${String(value.length)} chars>`;
  }
  if (Array.isArray(value)) return value.map((item) => redactResponse(item, key, depth + 1));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, redactResponse(record[k], k, depth + 1)]));
  }
  return `<${typeof value}>`;
}

/** One account in the report: its raw response, or why it could not be read. */
export interface AccountResponseReport {
  // Neutral name ("Claude #1"): the label the user gave the account may name the company.
  name: string;
  endpointLabel: string;
  response?: unknown;
  error?: string;
}

export interface ResponseReportIssueParams {
  accounts: AccountResponseReport[];
  appVersion: string;
}

// Only the first part of an error message: _http.ts appends the response body after
// " — ", which may be anything (e.g. a Cloudflare page).
function shortError(message: string): string {
  return (message.split(' — ')[0] ?? message).slice(0, 160);
}

export function buildResponseReportIssueUrl({ accounts, appVersion }: ResponseReportIssueParams): string {
  const redacted = accounts.map((a) => ({ ...a, response: a.error === undefined ? redactResponse(a.response) : undefined }));
  // `limit`: maximum characters of each JSON block (Infinity = whole), `pretty`: indented.
  const build = (pretty: boolean, limit: number): string => {
    let truncated = false;
    const sections: string[] = [];
    for (const a of redacted) {
      sections.push(`### ${a.name}`, `Endpoint: \`${a.endpointLabel}\``, '');
      if (a.error !== undefined) {
        sections.push(`Could not be read: ${shortError(a.error)}`, '');
        continue;
      }
      let json = pretty ? JSON.stringify(a.response, null, 2) : JSON.stringify(a.response);
      if (json.length > limit) {
        json = json.slice(0, limit);
        truncated = true;
      }
      sections.push('```json', json, '```', '');
    }
    const body = [
      `Usage responses reported by hand from IA Hypermiler ${appVersion} on ${new Date().toISOString()}.`,
      '',
      '**This draft contains real usage values** (percentages, amounts, reset dates). ' +
        'Strings such as ids and names are redacted. Review it before submitting, or do not submit it at all.',
      '',
      ...sections,
      ...(truncated ? ['_Truncated to fit the maximum length of a new-issue link._'] : []),
    ].join('\n');
    const url = new URL(`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`);
    url.searchParams.set('title', `Usage response report (${accounts.map((a) => a.name).join(', ')})`);
    url.searchParams.set('body', body);
    url.searchParams.set('labels', 'response-report');
    return url.toString();
  };

  const pretty = build(true, Infinity);
  if (pretty.length <= MAX_ISSUE_URL_LENGTH) return pretty;
  const compact = build(false, Infinity);
  if (compact.length <= MAX_ISSUE_URL_LENGTH) return compact;
  // Cut every JSON block to the same length, shrinking until the link fits.
  let limit = Math.max(...redacted.map((a) => (a.error === undefined ? JSON.stringify(a.response).length : 0)));
  let url = compact;
  while (url.length > MAX_ISSUE_URL_LENGTH && limit > 0) {
    limit = Math.floor(limit * (MAX_ISSUE_URL_LENGTH / url.length) * 0.95);
    url = build(false, limit);
  }
  return url;
}
