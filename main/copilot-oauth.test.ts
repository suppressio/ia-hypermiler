// main/copilot-oauth.test.ts — test unitari sulle sole funzioni pure (PKCE, URL di
// autorizzazione). Il flusso interattivo (loopback HTTP + shell.openExternal) non è
// testabile senza rete/UI, coerente con main/claude-auth.ts (verificato solo a mano).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPkcePair, buildAuthorizationUrl } from './copilot-oauth';

test('createPkcePair genera un code_verifier in base64url e il code_challenge corrispondente (SHA-256)', () => {
  const { codeVerifier, codeChallenge } = createPkcePair();

  assert.match(codeVerifier, /^[A-Za-z0-9_-]+$/);
  assert.match(codeChallenge, /^[A-Za-z0-9_-]+$/);

  const expectedChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  assert.equal(codeChallenge, expectedChallenge);
});

test('createPkcePair genera coppie diverse ad ogni chiamata', () => {
  const first = createPkcePair();
  const second = createPkcePair();
  assert.notEqual(first.codeVerifier, second.codeVerifier);
});

test('buildAuthorizationUrl include tutti i parametri richiesti da GitHub OAuth + PKCE', () => {
  const url = new URL(
    buildAuthorizationUrl({
      clientId: 'client-123',
      redirectUri: 'http://127.0.0.1:8123/callback',
      state: 'state-abc',
      codeChallenge: 'challenge-xyz',
    }),
  );

  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8123/callback');
  assert.equal(url.searchParams.get('scope'), 'read:user');
  assert.equal(url.searchParams.get('state'), 'state-abc');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-xyz');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});
