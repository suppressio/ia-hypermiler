// scripts/probe-copilot-shape.js — prints the STRUCTURE of the copilot_internal/user
// response (field names + types, never values) for the token in .env.test, to check
// whether GitHub exposes AI credits for company seats again (see RESEARCH.md §2.2
// addenda). Run locally, never paste the token anywhere:
//
//   node --env-file=.env.test scripts/probe-copilot-shape.js
//
// Uses HYPERMILER_TEST_COPILOT_TOKEN. Output is safe to share: same rule as
// services/_shape.ts (no numbers, strings or dates), plus the HTTP status.

const ENDPOINT = 'https://api.github.com/copilot_internal/user';
const TIMEOUT_MS = 10_000;
const MAX_DEPTH = 8;
const CREDIT_HINT = /credit|quota|budget|spend|usage|limit|entitlement|remaining|consum/i;

function shapeOf(value, depth = 0) {
  if (depth > MAX_DEPTH) return 'truncated';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0], depth + 1)] : [];
  if (typeof value === 'object') {
    const shape = {};
    for (const key of Object.keys(value).sort()) shape[key] = shapeOf(value[key], depth + 1);
    return shape;
  }
  return typeof value;
}

function hintedPaths(shape, prefix = '') {
  if (Array.isArray(shape)) return shape.length > 0 ? hintedPaths(shape[0], `${prefix}[]`) : [];
  if (shape === null || typeof shape !== 'object') return [];
  return Object.entries(shape).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [...(CREDIT_HINT.test(key) ? [path] : []), ...hintedPaths(child, path)];
  });
}

async function main() {
  const token = process.env.HYPERMILER_TEST_COPILOT_TOKEN;
  if (!token) {
    console.error('Missing HYPERMILER_TEST_COPILOT_TOKEN — fill .env.test and run with --env-file=.env.test');
    process.exitCode = 1;
    return;
  }
  const response = await fetch(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  console.log(`HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  const shape = shapeOf(body);
  console.log(JSON.stringify(shape, null, 2));
  const hints = hintedPaths(shape);
  console.log(`\nFields whose name suggests credits/quota (${hints.length}):`);
  for (const path of hints) console.log(`  ${path}`);
}

main().catch((error) => {
  console.error(`Request failed: ${error instanceof Error ? error.name : 'unknown error'}`);
  process.exitCode = 1;
});
