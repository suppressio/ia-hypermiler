// main/claude-auth.ts — cattura della sessione Claude via finestra di login embedded.
// Vedi RESEARCH.md v3 §1 e CLAUDE.md: mai chiedere all'utente di incollare un cookie
// a mano. Funziona sia con login classico (email/password, Google) sia con SSO
// aziendale: in entrambi i casi, al termine del login claude.ai deposita lo stesso
// cookie di sessione (`sessionKey`), che qui intercettiamo.
//
// Ogni account Claude ha una propria partition Electron (`persist:account-<id>`,
// vedi store/migrate.ts): i cookie di due account non si mescolano, e un
// "Disconnetti" può cancellarli davvero (clearClaudePartition). Prima tutto
// viveva in session.defaultSession — il login successivo a un disconnect
// ritrovava il vecchio cookie e riprendeva la stessa sessione (issue #4).

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
export async function buildClaudeCookieHeader(partition: string): Promise<string> {
  const cookies = await session.fromPartition(partition).cookies.get({ url: 'https://claude.ai' });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Cancella cookie e storage della partition dell'account (disconnect/rimozione, e prima di un nuovo login). */
export async function clearClaudePartition(partition: string): Promise<void> {
  await session.fromPartition(partition).clearStorageData();
}

/**
 * Copia una tantum i cookie claude.ai da session.defaultSession (dove vivevano
 * prima delle partition per account) nella partition dell'account Claude
 * migrato, poi li rimuove da defaultSession. Evita di dover rifare il login dopo
 * l'aggiornamento; se fallisce, basta riconnettere l'account da Impostazioni.
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
      // Un cookie host-only non deve diventare di dominio: passiamo `domain` solo se lo era.
      // Campi opzionali copiati solo se presenti (exactOptionalPropertyTypes).
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
 * Apre una finestra di login verso claude.ai, nella partition dell'account, e
 * risolve con il cookie di sessione non appena l'utente completa l'accesso (con
 * qualunque metodo). La partition viene svuotata prima: si parte sempre da un
 * login pulito, mai da una sessione residua.
 */
export async function captureClaudeSession(partition: string): Promise<CapturedClaudeSession> {
  await clearClaudePartition(partition);
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 480,
      height: 720,
      title: 'Accedi a Claude',
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        // Nessun preload: questa finestra carica solo claude.ai, nessun bisogno di
        // esporre canali contextBridge al suo interno.
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

    // checkForSessionCookie gestisce da sé i propri errori (try/catch interno): la
    // promise non può rifiutare, `void` esplicita che non serve attenderla.
    const onPageEvent = () => { void checkForSessionCookie(); };
    authWindow.webContents.on('did-navigate', onPageEvent);
    authWindow.webContents.on('did-navigate-in-page', onPageEvent);
    authWindow.webContents.on('did-finish-load', onPageEvent);

    authWindow.on('closed', () => {
      finish(reject, new Error('Login Claude annullato: finestra chiusa prima del completamento'));
    });

    authWindow.loadURL(LOGIN_URL).catch((err: unknown) => {
      finish(reject, new Error(`Impossibile aprire la pagina di login Claude: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
    });
  });
}
