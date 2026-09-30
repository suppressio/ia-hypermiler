// services/updates.test.ts — controllo nuova versione (issue #5), fetch mockato,
// nessuna rete. Nomi degli asset presi da una release reale prodotta dalla CI.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, fetchLatestUpdate, pickDownloadAsset, pickLatestRelease, RELEASES_API_URL } from './updates';
import type { GithubRelease, GithubReleaseAsset } from './updates';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function asset(name: string): GithubReleaseAsset {
  return { name, browser_download_url: `https://github.com/suppressio/ia-hypermiler/releases/download/v0.3.0-beta/${name}` };
}

const CI_ASSETS = [
  asset('ia-hypermiler-0.3.0-beta-arm64.dmg'),
  asset('ia-hypermiler-0.3.0-beta-arm64.dmg.blockmap'),
  asset('ia-hypermiler-0.3.0-beta.AppImage'),
  asset('ia-hypermiler-Setup-0.3.0-beta.exe'),
  asset('ia-hypermiler-Setup-0.3.0-beta.exe.blockmap'),
  asset('ia-hypermiler_0.3.0-beta_amd64.deb'),
  asset('latest.yml'),
];

function release(tag: string, overrides: Partial<GithubRelease> = {}): GithubRelease {
  return {
    tag_name: tag,
    html_url: `https://github.com/suppressio/ia-hypermiler/releases/tag/${tag}`,
    draft: false,
    published_at: '2026-10-01T10:00:00Z',
    assets: CI_ASSETS,
    ...overrides,
  };
}

test('compareVersions: semver con pre-release e prefisso v', () => {
  assert.ok(compareVersions('0.2.1-beta', '0.2.0-beta') > 0);
  assert.ok(compareVersions('0.2.1-beta', '0.2.1') < 0);
  assert.ok(compareVersions('v0.3.0-beta', '0.2.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0);
  assert.equal(compareVersions('v0.2.1-beta', '0.2.1-beta'), 0);
  assert.throws(() => compareVersions('latest', '0.2.1'), /Versione non valida/);
});

test('pickLatestRelease: la più alta, bozze e tag non semver esclusi', () => {
  const releases = [release('v0.2.1-beta'), release('v0.4.0-beta', { draft: true }), release('v0.3.0-beta'), release('nightly')];
  assert.equal(pickLatestRelease(releases, '0.2.1-beta')?.tag_name, 'v0.3.0-beta');
});

test('pickLatestRelease: nessuna versione più recente → null', () => {
  assert.equal(pickLatestRelease([release('v0.2.1-beta'), release('v0.2.0-beta')], '0.2.1-beta'), null);
  assert.equal(pickLatestRelease([], '0.2.1-beta'), null);
});

test('pickDownloadAsset: pacchetto giusto per ogni OS', () => {
  assert.equal(pickDownloadAsset(CI_ASSETS, 'win32', 'x64', false)?.name, 'ia-hypermiler-Setup-0.3.0-beta.exe');
  assert.equal(pickDownloadAsset(CI_ASSETS, 'darwin', 'arm64', false)?.name, 'ia-hypermiler-0.3.0-beta-arm64.dmg');
  assert.equal(pickDownloadAsset(CI_ASSETS, 'linux', 'x64', true)?.name, 'ia-hypermiler-0.3.0-beta.AppImage');
  assert.equal(pickDownloadAsset(CI_ASSETS, 'linux', 'x64', false)?.name, 'ia-hypermiler_0.3.0-beta_amd64.deb');
});

test('pickDownloadAsset: nessun pacchetto adatto → null (Mac Intel con solo dmg arm64, linux arm64 senza deb)', () => {
  assert.equal(pickDownloadAsset(CI_ASSETS, 'darwin', 'x64', false), null);
  assert.equal(pickDownloadAsset(CI_ASSETS, 'linux', 'arm64', false), null);
  assert.equal(pickDownloadAsset(CI_ASSETS, 'freebsd', 'x64', false), null);
});

test('fetchLatestUpdate: interroga l\'elenco release (non /latest) e propone il pacchetto per l\'OS', async () => {
  let calledUrl = '';
  globalThis.fetch = (async (input: string) => {
    calledUrl = input;
    return new Response(JSON.stringify([release('v0.3.0-beta'), release('v0.2.1-beta')]), { status: 200 });
  }) as typeof fetch;

  const update = await fetchLatestUpdate('0.2.1-beta', { platform: 'win32', arch: 'x64', isAppImage: false });
  assert.equal(calledUrl, RELEASES_API_URL);
  assert.deepEqual(update, {
    version: '0.3.0-beta',
    publishedAt: '2026-10-01T10:00:00Z',
    releaseUrl: 'https://github.com/suppressio/ia-hypermiler/releases/tag/v0.3.0-beta',
    downloadUrl: 'https://github.com/suppressio/ia-hypermiler/releases/download/v0.3.0-beta/ia-hypermiler-Setup-0.3.0-beta.exe',
    assetName: 'ia-hypermiler-Setup-0.3.0-beta.exe',
  });
});

test('fetchLatestUpdate: senza pacchetto adatto ripiega sulla pagina della release', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify([release('v0.3.0-beta')]), { status: 200 })) as typeof fetch;
  const update = await fetchLatestUpdate('0.2.1-beta', { platform: 'darwin', arch: 'x64', isAppImage: false });
  assert.equal(update?.downloadUrl, 'https://github.com/suppressio/ia-hypermiler/releases/tag/v0.3.0-beta');
  assert.equal(update?.assetName, null);
});

test('fetchLatestUpdate: già aggiornato → null', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify([release('v0.2.1-beta')]), { status: 200 })) as typeof fetch;
  assert.equal(await fetchLatestUpdate('0.2.1-beta', { platform: 'linux', arch: 'x64', isAppImage: true }), null);
});

test('fetchLatestUpdate: errore HTTP o risposta inattesa → errore esplicito', async () => {
  globalThis.fetch = (async () => new Response('rate limited', { status: 403, statusText: 'Forbidden' })) as typeof fetch;
  await assert.rejects(fetchLatestUpdate('0.2.1-beta', { platform: 'linux', arch: 'x64', isAppImage: true }), /GitHub Releases ha risposto 403/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'x' }), { status: 200 })) as typeof fetch;
  await assert.rejects(fetchLatestUpdate('0.2.1-beta', { platform: 'linux', arch: 'x64', isAppImage: true }), /non un elenco/);
});
