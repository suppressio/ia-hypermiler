// services/githubHost.ts — which GitHub a Copilot account lives on: github.com or a
// GitHub Enterprise Cloud tenant with data residency (<tenant>.ghe.com), where the
// company Copilot seat and its usage data are (RESEARCH.md §2.2 addendum 2026-10-01).
// The account token is sent to this host, so only these two shapes are accepted.
// Layout as in VS Code (src/vs/platform/github/common/githubEndpoints.ts): API on
// api.<host>, OAuth on <host>/login/oauth.

export const DEFAULT_GITHUB_HOST = 'github.com';

const GHE_TENANT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/;

/**
 * User input → canonical host ("github.com" or "<tenant>.ghe.com"), or null when it is
 * not one. Tolerates an https:// prefix, a trailing path, upper case, spaces and the
 * "api." prefix; refuses http, ports, credentials and any other domain.
 */
export function normalizeGithubHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let host = value.trim().toLowerCase();
  if (host.startsWith('https://')) host = host.slice('https://'.length);
  const slash = host.indexOf('/');
  if (slash !== -1) host = host.slice(0, slash);
  if (host.startsWith('api.')) host = host.slice('api.'.length);
  if (host === DEFAULT_GITHUB_HOST) return host;
  return GHE_TENANT_HOST.test(host) ? host : null;
}

function requireHost(host: string): string {
  const normalized = normalizeGithubHost(host);
  if (!normalized) throw new Error(`"${host}" is not a supported GitHub host (github.com or <tenant>.ghe.com)`);
  return normalized;
}

export function githubApiBase(host: string): string {
  return `https://api.${requireHost(host)}`;
}

export function githubOAuthBase(host: string): string {
  return `https://${requireHost(host)}/login/oauth`;
}
