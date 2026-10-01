// main/copilot-oauth.ts — captures a GitHub OAuth App token for Copilot, as an
// alternative to a hand-pasted PAT (renderer/settings.ts, connect-copilot-oauth).
//
// Deliberate difference from main/claude-auth.ts: Copilot has no login page that can
// be embedded in a BrowserWindow with cookie capture. It needs a real GitHub OAuth App
// (registered once by the user on github.com/settings/developers, with Authorization
// callback URL http://127.0.0.1:8123/callback) and an Authorization Code + PKCE flow
// over a local loopback. The system browser is used (shell.openExternal), not an app
// webview: the user authenticates on github.com in their own real browser, safer than
// a BrowserWindow controlled by us.
//
// Hypothesis tested (see CLAUDE.md/RESEARCH.md §2.2): an OAuth App token might receive
// a full quota_snapshots response from copilot_internal/user (like the VS Code Copilot
// Chat extension), unlike what was observed with a PAT. Disproved for company seats.
// This file only obtains the token; the response handling stays in services/copilot.ts
// (no change there: an OAuth token is used exactly like a PAT, Authorization: Bearer
// <token>).

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { shell } from 'electron';
import { getLocale, t } from './i18n/index';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const REDIRECT_PORT = 8123;
const SCOPES = ['read:user'];
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes, same threshold as main/claude-auth.ts

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** PKCE (RFC 7636): extracted as a pure function, testable without network. */
export function createPkcePair(): PkcePair {
  const codeVerifier = toBase64Url(randomBytes(48));
  const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/** Builds the GitHub authorization URL: extracted so it is testable without network. */
export function buildAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderCallbackPage(title: string, message: string): string {
  const escapedTitle = escapeHtml(title);
  const escapedMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="${getLocale()}">
  <head><meta charset="utf-8" /><title>${escapedTitle}</title></head>
  <body>
    <h1>${escapedTitle}</h1>
    <p>${escapedMessage}</p>
    <p>${escapeHtml(t('oauth.closeTab'))}</p>
  </body>
</html>`;
}

async function exchangeCodeForToken(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<string> {
  const response = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'ia-hypermiler',
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub OAuth code exchange failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'GitHub did not return an access_token');
  }
  return payload.access_token;
}

/**
 * Opens the system browser on the GitHub authorization page and resolves with the
 * access_token as soon as the user gives consent (loopback on 127.0.0.1).
 */
export function captureGithubOAuthToken(config: GithubOAuthConfig): Promise<{ accessToken: string }> {
  return new Promise((resolve, reject) => {
    const clientId = config.clientId.trim();
    const clientSecret = config.clientSecret.trim();
    if (!clientId) {
      reject(new Error('Copilot OAuth: missing Client ID'));
      return;
    }
    if (!clientSecret) {
      reject(new Error('Copilot OAuth: missing Client Secret'));
      return;
    }

    const state = randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = createPkcePair();
    const redirectUri = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
    const authorizationUrl = buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge });

    let settled = false;
    const finish = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      server.close();
      fn(value);
    };

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', redirectUri);
      if (requestUrl.pathname !== '/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Not found');
        return;
      }

      const finishWithHtml = (title: string, message: string): void => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(renderCallbackPage(title, message));
      };

      const error = requestUrl.searchParams.get('error');
      const errorDescription = requestUrl.searchParams.get('error_description');
      const returnedState = requestUrl.searchParams.get('state');
      const code = requestUrl.searchParams.get('code');

      if (error) {
        finishWithHtml(t('oauth.failedTitle'), errorDescription ?? error);
        finish(reject, new Error(errorDescription ?? `GitHub authorization failed: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        finishWithHtml(t('oauth.failedTitle'), t('oauth.invalidCallback'));
        finish(reject, new Error('GitHub OAuth callback validation failed'));
        return;
      }

      exchangeCodeForToken({ clientId, clientSecret, code, codeVerifier, redirectUri })
        .then((accessToken) => {
          finishWithHtml(t('oauth.successTitle'), t('oauth.successMessage'));
          finish(resolve, { accessToken });
        })
        .catch((exchangeError: unknown) => {
          const message = exchangeError instanceof Error ? exchangeError.message : t('oauth.exchangeFailed');
          finishWithHtml(t('oauth.failedTitle'), message);
          finish(reject, exchangeError instanceof Error ? exchangeError : new Error(message));
        });
    });

    const safetyTimer = setTimeout(() => {
      finish(reject, new Error('GitHub login timed out: no authorization within 5 minutes'));
    }, MAX_WAIT_MS);

    server.on('error', (err) => {
      finish(reject, new Error(`Could not start the OAuth callback server (port ${REDIRECT_PORT}): ${err.message}`));
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      shell.openExternal(authorizationUrl).catch((err: unknown) => {
        finish(reject, new Error(`Could not open the GitHub sign-in page: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
      });
    });
  });
}
