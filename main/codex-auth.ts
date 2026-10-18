// main/codex-auth.ts — Codex session capture through an embedded ChatGPT login window.
// See docs/RESEARCH.md §6.2: each account has its own Electron partition, so
// cookies never mix and disconnect/removal can delete the complete session.
// Session cookies stay in the partition; capture returns only a timestamp.

import { BrowserWindow, session } from 'electron';
import { t } from './i18n/index';
import { isCodexSessionCookie } from './codex-session-cookie';

const LOGIN_URL = 'https://chatgpt.com/auth/login';
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes: beyond that, the user probably abandoned the login

export interface CapturedCodexSession {
  capturedAt: string;
}

/** Rebuilds the full Cookie header, including Cloudflare cookies, fresh on every call. */
export async function buildCodexCookieHeader(partition: string): Promise<string> {
  const cookies = await session.fromPartition(partition).cookies.get({ url: 'https://chatgpt.com' });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Returns the same User-Agent used at login: cf_clearance is tied to it. */
export function codexUserAgent(partition: string): string {
  return session.fromPartition(partition).getUserAgent();
}

/** Clears cookies and storage of the account partition (disconnect/removal, and before a new login). */
export async function clearCodexPartition(partition: string): Promise<void> {
  await session.fromPartition(partition).clearStorageData();
}

/**
 * Opens ChatGPT in the account partition and closes on the first page event with
 * a session cookie. Clearing the partition first prevents a leftover session from
 * completing the login. Never change the window or session User-Agent: Google
 * refuses sign-in when it contradicts Electron's client hints (RESEARCH.md §6.2).
 */
export async function captureCodexSession(partition: string): Promise<CapturedCodexSession> {
  await clearCodexPartition(partition);
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 480,
      height: 720,
      title: t('login.codexWindowTitle'),
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        // No preload: this window only loads chatgpt.com, there is no need to expose
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
      finish(reject, new Error('Codex login timed out: no session detected within 5 minutes'));
    }, MAX_WAIT_MS);

    const checkForSessionCookie = async () => {
      try {
        if (settled) return;
        const cookies = await ses.cookies.get({ url: 'https://chatgpt.com' });
        if (cookies.some((cookie) => isCodexSessionCookie(cookie.name))) {
          finish(resolve, { capturedAt: new Date().toISOString() });
        }
      } catch (err) {
        // Not fatal: we will retry on the next navigation event.
        console.error('[codex-auth] cookie read error:', err);
      }
    };

    // checkForSessionCookie handles its own errors (internal try/catch): the promise
    // cannot reject, `void` states that there is no need to await it.
    const onPageEvent = () => { void checkForSessionCookie(); };
    authWindow.webContents.on('did-navigate', onPageEvent);
    authWindow.webContents.on('did-navigate-in-page', onPageEvent);
    authWindow.webContents.on('did-finish-load', onPageEvent);

    authWindow.on('closed', () => {
      finish(reject, new Error('Codex login cancelled: window closed before completion'));
    });

    authWindow.loadURL(LOGIN_URL).catch((err: unknown) => {
      finish(reject, new Error(`Could not open the Codex login page: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
    });
  });
}
