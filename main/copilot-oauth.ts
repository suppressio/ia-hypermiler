// main/copilot-oauth.ts — cattura di un token OAuth App di GitHub per Copilot, in
// alternativa al PAT incollato a mano (renderer/settings.ts, btn-connect-copilot).
//
// Differenza deliberata rispetto a main/claude-auth.ts: Copilot non ha una pagina di
// login integrabile in una BrowserWindow con cattura cookie. Serve una vera GitHub
// OAuth App (l'utente la registra una volta su github.com/settings/developers, con
// Authorization callback URL http://127.0.0.1:8123/callback) e un flusso Authorization
// Code + PKCE via loopback locale. Usiamo il browser di sistema (shell.openExternal),
// non una webview dell'app: l'utente autentica su github.com nel proprio browser reale,
// più corretto lato sicurezza di una BrowserWindow controllata da noi.
//
// Ipotesi da verificare (vedi CLAUDE.md/RESEARCH.md §2.2): un token OAuth App potrebbe
// ricevere da copilot_internal/user una risposta con quota_snapshots completo (come
// l'estensione Copilot Chat di VS Code), a differenza di quanto osservato con un PAT.
// Non è confermato: questo file implementa solo l'ottenimento del token, la verifica
// del contenuto della risposta resta in services/copilot.ts (nessuna modifica lì:
// un token OAuth si usa esattamente come un PAT, Authorization: Bearer <token>).

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { shell } from 'electron';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const REDIRECT_PORT = 8123;
const SCOPES = ['read:user'];
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minuti, stessa soglia di main/claude-auth.ts

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

/** PKCE (RFC 7636): estratta come funzione pura, testabile senza rete. */
export function createPkcePair(): PkcePair {
  const codeVerifier = toBase64Url(randomBytes(48));
  const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/** Costruisce l'URL di autorizzazione GitHub: estratta a parte per essere testabile senza rete. */
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
<html lang="it">
  <head><meta charset="utf-8" /><title>${escapedTitle}</title></head>
  <body>
    <h1>${escapedTitle}</h1>
    <p>${escapedMessage}</p>
    <p>Puoi chiudere questa scheda e tornare all'app.</p>
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
    throw new Error(`Scambio del code OAuth GitHub fallito con stato ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'GitHub non ha restituito un access_token');
  }
  return payload.access_token;
}

/**
 * Apre il browser di sistema sulla pagina di autorizzazione GitHub e risolve con
 * l'access_token non appena l'utente completa il consenso (loopback su 127.0.0.1).
 */
export function captureGithubOAuthToken(config: GithubOAuthConfig): Promise<{ accessToken: string }> {
  return new Promise((resolve, reject) => {
    const clientId = config.clientId.trim();
    const clientSecret = config.clientSecret.trim();
    if (!clientId) return reject(new Error('Copilot OAuth: Client ID mancante'));
    if (!clientSecret) return reject(new Error('Copilot OAuth: Client Secret mancante'));

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
        finishWithHtml('Accesso GitHub non riuscito', errorDescription ?? error);
        finish(reject, new Error(errorDescription ?? `Autorizzazione GitHub fallita: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        finishWithHtml('Accesso GitHub non riuscito', 'Callback OAuth non valida o scaduta.');
        finish(reject, new Error('Validazione della callback OAuth GitHub fallita'));
        return;
      }

      exchangeCodeForToken({ clientId, clientSecret, code, codeVerifier, redirectUri })
        .then((accessToken) => {
          finishWithHtml('Accesso GitHub completato', 'Autenticazione riuscita.');
          finish(resolve, { accessToken });
        })
        .catch((exchangeError: unknown) => {
          const message = exchangeError instanceof Error ? exchangeError.message : 'Scambio del token fallito.';
          finishWithHtml('Accesso GitHub non riuscito', message);
          finish(reject, exchangeError instanceof Error ? exchangeError : new Error(message));
        });
    });

    const safetyTimer = setTimeout(() => {
      finish(reject, new Error('Login GitHub scaduto: nessuna autorizzazione entro 5 minuti'));
    }, MAX_WAIT_MS);

    server.on('error', (err) => {
      finish(reject, new Error(`Impossibile avviare il server di callback OAuth (porta ${REDIRECT_PORT}): ${err.message}`));
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      shell.openExternal(authorizationUrl).catch((err: Error) => {
        finish(reject, new Error(`Impossibile aprire la pagina di accesso GitHub: ${err.message}`));
      });
    });
  });
}
