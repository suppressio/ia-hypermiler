// services/githubHost.test.ts — unit tests for services/githubHost.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GITHUB_HOST, githubApiBase, githubOAuthBase, normalizeGithubHost } from './githubHost';

test('normalizeGithubHost accepts github.com and <tenant>.ghe.com', () => {
  assert.equal(normalizeGithubHost('github.com'), 'github.com');
  assert.equal(normalizeGithubHost('acme.ghe.com'), 'acme.ghe.com');
  assert.equal(normalizeGithubHost('my-company2.ghe.com'), 'my-company2.ghe.com');
});

test('normalizeGithubHost tolerates scheme, case, spaces and a trailing path', () => {
  assert.equal(normalizeGithubHost('  https://Acme.GHE.com/  '), 'acme.ghe.com');
  assert.equal(normalizeGithubHost('https://github.com/settings/copilot'), 'github.com');
  assert.equal(normalizeGithubHost('api.acme.ghe.com'), 'acme.ghe.com');
  assert.equal(normalizeGithubHost('api.github.com'), 'github.com');
});

test('normalizeGithubHost rejects anything else (the token is sent to this host)', () => {
  for (const value of ['', 'evil.com', 'github.com.evil.com', 'acme.ghe.com.evil.com', 'a.b.ghe.com', 'http://acme.ghe.com',
    '-acme.ghe.com', 'acme.ghe.com:8443', 'user@acme.ghe.com', 'ghe.com', 42, null, undefined]) {
    assert.equal(normalizeGithubHost(value), null, `should reject ${String(value)}`);
  }
});

test('githubApiBase / githubOAuthBase follow the github.com and ghe.com layouts', () => {
  assert.equal(DEFAULT_GITHUB_HOST, 'github.com');
  assert.equal(githubApiBase('github.com'), 'https://api.github.com');
  assert.equal(githubApiBase('acme.ghe.com'), 'https://api.acme.ghe.com');
  assert.equal(githubOAuthBase('github.com'), 'https://github.com/login/oauth');
  assert.equal(githubOAuthBase('acme.ghe.com'), 'https://acme.ghe.com/login/oauth');
});

test('githubApiBase refuses an invalid host instead of building a URL from it', () => {
  assert.throws(() => githubApiBase('evil.com'), /not a supported GitHub host/);
});
