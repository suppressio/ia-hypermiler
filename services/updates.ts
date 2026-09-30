// services/updates.ts — controllo di una nuova versione dell'app (issue #5).
// Nessuna dipendenza aggiuntiva (niente electron-updater, scelta esplicita
// dell'utente): si legge l'elenco delle Release GitHub del progetto e si propone
// il pacchetto giusto per l'OS in uso, da scaricare nel browser e installare a
// mano — funziona allo stesso modo sui 3 OS anche con pacchetti non firmati.
//
// Endpoint: GET /repos/{owner}/{repo}/releases (API REST ufficiale GitHub, senza
// autenticazione). NON /releases/latest: esclude le pre-release, e tutte le
// release di questo progetto lo sono (`releaseType: "prerelease"` in package.json).
// Nessun dato dell'utente esce nella richiesta: è una GET anonima a un repo pubblico.
//
// Funzioni pure (compareVersions/pickLatestRelease/pickDownloadAsset) + un solo
// punto di rete (fetchLatestUpdate, via services/_http.ts: timeout 10s, errori espliciti).

import { fetchJson } from './_http';
import type { UpdateInfo } from '../types/index';

const REPO = 'suppressio/ia-hypermiler';
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
/** Ogni URL aperto dal pulsante "Scarica" deve stare sotto questo prefisso (vedi main.ts). */
export const TRUSTED_DOWNLOAD_PREFIX = `https://github.com/${REPO}/`;

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  published_at: string | null;
  assets: GithubReleaseAsset[];
}

interface ParsedVersion {
  core: number[];
  pre: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/**
 * Confronto semver (con pre-release): < 0 se a < b, 0 se uguali, > 0 se a > b.
 * Prefisso "v" ignorato. Una versione senza pre-release vince sulla stessa con
 * pre-release (0.2.1-beta < 0.2.1). Lancia su una versione non semver: meglio un
 * errore esplicito che un aggiornamento proposto (o taciuto) per sbaglio.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Versione non valida: ${!pa ? a : b}`);

  const coreDiff = pa.core.map((value, i) => value - (pb.core[i] ?? 0)).find((diff) => diff !== 0);
  if (coreDiff !== undefined) return coreDiff;
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;

  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Release più recente (bozze e tag non semver esclusi), o null se non è più nuova di `currentVersion`. */
export function pickLatestRelease(releases: GithubRelease[], currentVersion: string): GithubRelease | null {
  let best: GithubRelease | null = null;
  for (const release of releases) {
    if (release.draft || !parseVersion(release.tag_name)) continue;
    if (!best || compareVersions(release.tag_name, best.tag_name) > 0) best = release;
  }
  if (!best || compareVersions(best.tag_name, currentVersion) <= 0) return null;
  return best;
}

/**
 * Pacchetto adatto all'OS in uso, secondo i nomi prodotti dalla CI
 * (.github/workflows/build.yml): Windows `.exe` (NSIS), macOS `.dmg` della stessa
 * architettura (oggi la CI produce solo arm64: su un Mac Intel nessun asset è
 * adatto), Linux `.AppImage` se l'app sta girando come AppImage, altrimenti `.deb`.
 * null = nessun asset adatto → il chiamante ripiega sulla pagina della release.
 */
export function pickDownloadAsset(
  assets: GithubReleaseAsset[],
  platform: string,
  arch: string,
  isAppImage: boolean,
): GithubReleaseAsset | null {
  const byExt = (ext: string) => assets.filter((a) => a.name.toLowerCase().endsWith(ext));
  switch (platform) {
    case 'win32':
      return byExt('.exe')[0] ?? null;
    case 'darwin': {
      const dmgs = byExt('.dmg');
      const archTag = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch;
      // Senza suffisso d'architettura electron-builder produce il dmg x64.
      return dmgs.find((a) => a.name.includes(`-${archTag}.dmg`))
        ?? (archTag === 'x64' ? dmgs.find((a) => !/-(arm64|universal)\.dmg$/.test(a.name)) : undefined)
        ?? dmgs.find((a) => a.name.includes('-universal.dmg'))
        ?? null;
    }
    case 'linux': {
      if (isAppImage) return byExt('.appimage')[0] ?? null;
      const debArch = arch === 'x64' ? 'amd64' : arch;
      return byExt('.deb').find((a) => a.name.includes(`_${debArch}.deb`)) ?? null;
    }
    default:
      return null;
  }
}

export interface UpdateEnvironment {
  platform: string;
  arch: string;
  isAppImage: boolean;
}

/** Controlla le Release GitHub: UpdateInfo se c'è una versione più recente, null altrimenti. Lancia su errore. */
export async function fetchLatestUpdate(currentVersion: string, env: UpdateEnvironment): Promise<UpdateInfo | null> {
  const releases = await fetchJson(RELEASES_API_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ia-hypermiler' },
    label: 'GitHub Releases',
  });
  if (!Array.isArray(releases)) throw new Error('GitHub Releases: risposta inattesa (non un elenco)');

  const latest = pickLatestRelease(releases as GithubRelease[], currentVersion);
  if (!latest) return null;

  const asset = pickDownloadAsset(latest.assets, env.platform, env.arch, env.isAppImage);
  return {
    version: latest.tag_name.replace(/^v/, ''),
    publishedAt: latest.published_at,
    releaseUrl: latest.html_url,
    downloadUrl: asset?.browser_download_url ?? latest.html_url,
    assetName: asset?.name ?? null,
  };
}
