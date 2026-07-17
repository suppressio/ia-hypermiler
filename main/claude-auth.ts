// main/claude-auth.ts — cattura della sessione Claude via finestra di login embedded.
// Vedi RESEARCH.md v3 §1 e CLAUDE.md: mai chiedere all'utente di incollare un cookie
// a mano. Funziona sia con login classico (email/password, Google) sia con SSO
// aziendale: in entrambi i casi, al termine del login claude.ai deposita lo stesso
// cookie di sessione (`sessionKey`), che qui intercettiamo.

import { BrowserWindow, session } from 'electron';

const LOGIN_URL = 'https://claude.ai/login';
const COOKIE_DOMAIN = '.claude.ai';
const COOKIE_NAME = 'sessionKey';
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minuti: oltre, l'utente ha probabilmente abbandonato il login

export interface CapturedClaudeSession {
  sessionKey: string;
  capturedAt: string;
}

/**
 * Ricostruisce l'header Cookie completo che un vero browser manderebbe a
 * claude.ai in questo momento — non solo `sessionKey`, ma anche `cf_clearance`
 * e gli altri cookie Cloudflare/di sessione depositati durante il login reale
 * in main/claude-auth.ts. Senza questi, claude.ai risponde con la pagina di
 * verifica "Just a moment..." invece dei dati (403, HTML non-JSON) — scoperto
 * testando con un account reale, vedi CLAUDE.md "Stato avanzamento".
 * Letto fresco ad ogni chiamata (non persistito): cf_clearance ha una durata
 * limitata e viene rinnovato da Cloudflare mentre l'utente resta loggato.
 */
export async function buildClaudeCookieHeader(): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Apre una finestra di login verso claude.ai e risolve con il cookie di sessione
 * non appena l'utente completa l'accesso (con qualunque metodo).
 */
export function captureClaudeSession(): Promise<CapturedClaudeSession> {
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 480,
      height: 720,
      title: 'Accedi a Claude',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Nessun preload: questa finestra carica solo claude.ai, nessun bisogno di
        // esporre canali contextBridge al suo interno.
      },
    });

    let settled = false;
    const ses = authWindow.webContents.session ?? session.defaultSession;

    const finish = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      if (!authWindow.isDestroyed()) authWindow.close();
      fn(value);
    };

    const safetyTimer = setTimeout(() => {
      finish(reject, new Error('Login Claude scaduto: nessuna sessione rilevata entro 5 minuti'));
    }, MAX_WAIT_MS);

    const checkForSessionCookie = async () => {
      try {
        const cookies = await ses.cookies.get({ domain: COOKIE_DOMAIN, name: COOKIE_NAME });
        const cookie = cookies[0] || (await ses.cookies.get({ url: 'https://claude.ai', name: COOKIE_NAME }))[0];
        if (cookie?.value) {
          finish(resolve, { sessionKey: cookie.value, capturedAt: new Date().toISOString() });
        }
      } catch (err) {
        // Non fatale: riproveremo al prossimo evento di navigazione.
        console.error('[claude-auth] errore lettura cookie:', err);
      }
    };

    authWindow.webContents.on('did-navigate', checkForSessionCookie);
    authWindow.webContents.on('did-navigate-in-page', checkForSessionCookie);
    authWindow.webContents.on('did-finish-load', checkForSessionCookie);

    authWindow.on('closed', () => {
      finish(reject, new Error('Login Claude annullato: finestra chiusa prima del completamento'));
    });

    authWindow.loadURL(LOGIN_URL).catch((err: Error) => {
      finish(reject, new Error(`Impossibile aprire la pagina di login Claude: ${err.message}`));
    });
  });
}
