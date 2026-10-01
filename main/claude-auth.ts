// main/claude-auth.ts — Claude session capture through an embedded login window.
// See RESEARCH.md v3 §1 and CLAUDE.md: never ask the user to paste a cookie by hand.
// Works with classic login (email/password, Google) and with company SSO: in both
// cases, at the end of the login claude.ai sets the same session cookie
// (`sessionKey`), which we intercept here.
//
// Each Claude account has its own Electron partition (`persist:account-<id>`, see
// store/migrate.ts): cookies of two accounts never mix, and "Disconnect" can really
// delete them (clearClaudePartition). Everything used to live in
// session.defaultSession — the login after a disconnect found the old cookie and
// resumed the same session (issue #4).

import { BrowserWindow, session } from 'electron';
import { t } from './i18n/index';

const LOGIN_URL = 'https://claude.ai/login';
const COOKIE_DOMAIN = '.claude.ai';
const COOKIE_NAME = 'sessionKey';
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes: beyond that, the user probably abandoned the login

export interface CapturedClaudeSession {
  sessionKey: string;
  capturedAt: string;
}

/**
 * Rebuilds the full Cookie header a real browser would send to claude.ai right now —
 * not only `sessionKey`, but also `cf_clearance` and the other Cloudflare/session
 * cookies set during the real login in main/claude-auth.ts. Without them claude.ai
 * answers with the "Just a moment..." challenge page instead of the data (403,
 * non-JSON HTML) — found while testing with a real account, see the CLAUDE.md progress
 * log. Read fresh on every call (not persisted): cf_clearance has a limited lifetime
 * and Cloudflare renews it while the user stays logged in.
 */
export async function buildClaudeCookieHeader(partition: string): Promise<string> {
  const cookies = await session.fromPartition(partition).cookies.get({ url: 'https://claude.ai' });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Clears cookies and storage of the account partition (disconnect/removal, and before a new login). */
export async function clearClaudePartition(partition: string): Promise<void> {
  await session.fromPartition(partition).clearStorageData();
}

/**
 * One-off copy of the claude.ai cookies from session.defaultSession (where they
 * lived before per-account partitions) into the partition of the migrated Claude
 * account, then removes them from defaultSession. Avoids a new login after the
 * update; if it fails, reconnecting the account from Settings is enough.
 */
export async function migrateDefaultSessionCookies(targetPartition: string): Promise<number> {
  const source = session.defaultSession;
  const target = session.fromPartition(targetPartition);
  const cookies = await source.cookies.get({ url: 'https://claude.ai' });
  for (const c of cookies) {
    const host = (c.domain ?? 'claude.ai').replace(/^\./, '');
    await target.cookies.set({
      url: `https://${host}${c.path ?? '/'}`,
      name: c.name,
      value: c.value,
      // A host-only cookie must not become a domain cookie: `domain` is passed only if it was one.
      // Optional fields are copied only when present (exactOptionalPropertyTypes).
      ...(!c.hostOnly && c.domain !== undefined ? { domain: c.domain } : {}),
      ...(c.path !== undefined ? { path: c.path } : {}),
      ...(c.secure !== undefined ? { secure: c.secure } : {}),
      ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
      ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
      sameSite: c.sameSite,
    });
  }
  for (const c of cookies) {
    const host = (c.domain ?? 'claude.ai').replace(/^\./, '');
    await source.cookies.remove(`https://${host}${c.path ?? '/'}`, c.name);
  }
  return cookies.length;
}

/**
 * Opens a login window towards claude.ai, in the account partition, and resolves
 * with the session cookie as soon as the user completes the sign-in (with any
 * method). The partition is cleared first: the login always starts clean, never from
 * a leftover session.
 */
export async function captureClaudeSession(partition: string): Promise<CapturedClaudeSession> {
  await clearClaudePartition(partition);
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 480,
      height: 720,
      title: t('login.claudeWindowTitle'),
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        // No preload: this window only loads claude.ai, there is no need to expose
        // contextBridge channels inside it.
      },
    });

    let settled = false;
    const ses = authWindow.webContents.session;

    const finish = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      if (!authWindow.isDestroyed()) authWindow.close();
      fn(value);
    };

    const safetyTimer = setTimeout(() => {
      finish(reject, new Error('Claude login timed out: no session detected within 5 minutes'));
    }, MAX_WAIT_MS);

    const checkForSessionCookie = async () => {
      try {
        const cookies = await ses.cookies.get({ domain: COOKIE_DOMAIN, name: COOKIE_NAME });
        const cookie = cookies[0] || (await ses.cookies.get({ url: 'https://claude.ai', name: COOKIE_NAME }))[0];
        if (cookie?.value) {
          finish(resolve, { sessionKey: cookie.value, capturedAt: new Date().toISOString() });
        }
      } catch (err) {
        // Not fatal: we will retry on the next navigation event.
        console.error('[claude-auth] cookie read error:', err);
      }
    };

    // checkForSessionCookie handles its own errors (internal try/catch): the promise
    // cannot reject, `void` states that there is no need to await it.
    const onPageEvent = () => { void checkForSessionCookie(); };
    authWindow.webContents.on('did-navigate', onPageEvent);
    authWindow.webContents.on('did-navigate-in-page', onPageEvent);
    authWindow.webContents.on('did-finish-load', onPageEvent);

    authWindow.on('closed', () => {
      finish(reject, new Error('Claude login cancelled: window closed before completion'));
    });

    authWindow.loadURL(LOGIN_URL).catch((err: unknown) => {
      finish(reject, new Error(`Could not open the Claude login page: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
    });
  });
}
