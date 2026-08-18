// main.ts — processo principale Electron
// Giorno 2, Sessione 1: dati reali da services/claude.ts e services/copilot.ts al posto
// del mock del Giorno 1. Se una fetch fallisce, si mostra l'ultimo dato noto con
// timestamp (mai schermata bianca, vedi CLAUDE.md).

import { app, ipcMain, BrowserWindow, Notification, shell, Menu, screen } from 'electron';
import store from './store/index';
import { createMainWindow, createSettingsWindow } from './main/windows';
import { createTray } from './main/tray';
import { captureClaudeSession, buildClaudeCookieHeader } from './main/claude-auth';
import { captureGithubOAuthToken } from './main/copilot-oauth';
import * as budget from './budget';
import * as claudeService from './services/claude';
import * as copilotService from './services/copilot';
import { computeClaudeLocalInsights } from './services/claudeLocalSessions';
import { FormatDriftError, shapeSignature } from './services/_shape';
import { buildFormatDriftIssueUrl } from './diagnostics/githubIssue';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  AccountId,
  AccountSnapshot,
  AppSettings,
  ClaudeLocalInsights,
  DailyUsagePoint,
  QuotaWindow,
  QuotaWindowSnapshot,
  RawAccountUsage,
  RecentUsageSample,
  RenewalRule,
  UsageSnapshot,
  WorkSchedule,
  WindowStyle,
} from './types/index';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minuti, come da CLAUDE.md
// Ricalcolo insight locali (services/claudeLocalSessions.ts): più costoso di un
// refresh usuale (scansione file su disco, non un poll di rete), non serve farlo
// ad ogni refresh di 30 min — cache con questo intervallo minimo, stesso pattern
// di advisorCache.
const LOCAL_INSIGHTS_RECOMPUTE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 ore
const LOCAL_INSIGHTS_WINDOW_DAYS = 7; // stessa finestra del punteggio eco (budget.ecoScore)

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let hoverPollTimer: NodeJS.Timeout | null = null;
let lastHoverState = false;

// ---------------------------------------------------------------------------
// Rivelamento hover finestra per titlebar/pulsanti "a scomparsa" (feedback
// utente): un :hover CSS puro, e anche mouseover/mouseout sul documento, non
// si attivano in modo affidabile sopra alla striscia -webkit-app-region:drag,
// perché il sistema operativo la tratta come area non-client (come la titlebar
// nativa) e intercetta il mouse per il trascinamento invece di dispatchare i
// normali eventi DOM — con quella tecnica la barra spariva proprio passandoci
// sopra. Il fix affidabile è interrogare la posizione del cursore lato main
// process (sempre disponibile via screen.getCursorScreenPoint(), indipendente
// dal dispatch di eventi del renderer) e confrontarla con i bounds della
// finestra, inviando al renderer solo i cambi di stato via IPC.
// ---------------------------------------------------------------------------
function startWindowHoverPolling(): void {
  if (hoverPollTimer) clearInterval(hoverPollTimer);
  hoverPollTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const isOver =
      cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    if (isOver !== lastHoverState) {
      lastHoverState = isOver;
      mainWindow.webContents.send('window:hoverChanged', isOver);
    }
  }, 120);
}

// ---------------------------------------------------------------------------
// Storico locale: Claude e Copilot non forniscono uno storico giornaliero via
// API (vedi RESEARCH.md), quindi lo costruiamo noi, un punto al giorno, ad ogni
// refresh riuscito.
// ---------------------------------------------------------------------------
function recordDailyUsage(accountId: AccountId, window: QuotaWindow): void {
  const utilization = budget.normalizedUtilization(window);
  if (utilization === null) return;

  const today = new Date().toISOString().slice(0, 10);
  const history = store.get('history.dailyUsage') as DailyUsagePoint[];
  const idx = history.findIndex((h) => h.date === today && h.accountId === accountId && h.windowId === window.id);
  const entry: DailyUsagePoint = { date: today, accountId, windowId: window.id, used: Math.round(utilization * 10) / 10 };
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);

  const retentionDays = (store.get('history.retentionDays') as number) || 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const pruned = history.filter((h) => new Date(h.date) >= cutoff);
  store.set('history.dailyUsage', pruned);
}

function getDailyHistory(accountId: AccountId, windowId: string, days: number): DailyUsagePoint[] {
  return (store.get('history.dailyUsage') as DailyUsagePoint[])
    .filter((h) => h.accountId === accountId && h.windowId === windowId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days);
}

// Ampio margine sopra il lookback di 3h usato da budget.instantaneousRate: il
// buffer resta comunque minuscolo (append ogni 30 min, mai più di ~8 campioni
// per finestra), a differenza di history.dailyUsage non serve una vera retention
// configurabile.
const RECENT_SAMPLES_MAX_AGE_MS = 4 * 60 * 60 * 1000;

// store.get(...) as RecentUsageSample[] può risultare undefined anche con un
// default configurato in store/index.ts: electron-store (conf) applica i default
// con un merge shallow (Object.assign(defaults, fileStore)) — su un'installazione
// che aveva già un oggetto `history` persistito PRIMA che questo campo esistesse,
// l'intero `history` del file sovrascrive quello dei default, `recentSamples`
// incluso, invece di fondersi campo per campo. Fallback esplicito a [] finché
// il primo store.set qui sotto non "ripara" il file scrivendoci il campo.
function recordRecentSample(accountId: AccountId, window: QuotaWindow): void {
  const utilization = budget.normalizedUtilization(window);
  if (utilization === null) return;

  const samples = (store.get('history.recentSamples') as RecentUsageSample[] | undefined) ?? [];
  samples.push({ timestamp: new Date().toISOString(), accountId, windowId: window.id, used: Math.round(utilization * 100) / 100 });

  const cutoff = Date.now() - RECENT_SAMPLES_MAX_AGE_MS;
  const pruned = samples.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
  store.set('history.recentSamples', pruned);
}

function getRecentSamples(accountId: AccountId, windowId: string): RecentUsageSample[] {
  return ((store.get('history.recentSamples') as RecentUsageSample[] | undefined) ?? [])
    .filter((s) => s.accountId === accountId && s.windowId === windowId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ---------------------------------------------------------------------------
// Insight locali da sessioni Claude Code (services/claudeLocalSessions.ts, vedi
// RESEARCH.md §5): opt-in (localInsights.claudeCode.enabled, default false),
// cachati perché più costosi di un refresh usuale (scansione file su disco, non
// un poll di rete) — ricalcolati al massimo ogni LOCAL_INSIGHTS_RECOMPUTE_INTERVAL_MS.
// ---------------------------------------------------------------------------
async function computeLocalInsightsIfNeeded(): Promise<ClaudeLocalInsights | null> {
  if (store.get('localInsights.claudeCode.enabled') !== true) return null;

  const cached = (store.get('localInsightsCache.claudeCode') as ClaudeLocalInsights | null | undefined) ?? null;
  const cacheAgeMs = cached ? Date.now() - new Date(cached.computedAt).getTime() : Infinity;
  if (cached && cacheAgeMs < LOCAL_INSIGHTS_RECOMPUTE_INTERVAL_MS) return cached;

  try {
    const result = await computeClaudeLocalInsights(LOCAL_INSIGHTS_WINDOW_DAYS);
    store.set('localInsightsCache.claudeCode', result);
    return result;
  } catch (err) {
    // Mai bloccare il refresh dell'account per un problema sulla sorgente locale
    // opzionale: logga e ricadi sull'ultima cache valida (anche se scaduta), se c'è.
    console.error('[main] calcolo insight locali Claude Code fallito:', (err as Error).message);
    return cached;
  }
}

// ---------------------------------------------------------------------------
// Confini del periodo per efficienza/previsionale/scadenza:
// - se la finestra critica ha un proprio resetsAt (caso Claude, finestre rolling),
//   usiamo quello e ricaviamo l'inizio periodo sottraendo la durata della finestra;
// - altrimenti (caso Copilot, ciclo di fatturazione) usiamo la renewalRule configurata.
// NOTA: per la finestra "five_hour" di Claude la granularità giorno/mezza-giornata di
// budget.ts è troppo grossolana per un'efficienza realmente significativa — il valore
// resta comunque coerente, ma va letto soprattutto come indicatore corrente, non come
// pacing affidabile su una finestra così breve.
// ---------------------------------------------------------------------------
function resolvePeriodBounds(
  criticalWindow: QuotaWindow | null,
  subscription: { renewalRule: RenewalRule },
  now: Date,
): { periodStart: Date; periodEnd: Date } {
  if (criticalWindow?.resetsAt) {
    const periodEnd = new Date(criticalWindow.resetsAt);
    const spanMs = criticalWindow.periodType === 'rolling-hours'
      ? (criticalWindow.periodLength ?? 0) * 3600 * 1000
      : (criticalWindow.periodLength ?? 0) * 24 * 3600 * 1000;
    return { periodStart: new Date(periodEnd.getTime() - spanMs), periodEnd };
  }
  const periodEnd = budget.resolveRenewalDate(subscription.renewalRule, now);
  const periodStart = new Date(periodEnd);
  periodStart.setMonth(periodStart.getMonth() - 1);
  return { periodStart, periodEnd };
}

// Una finestra "billing-cycle" con periodLength sconosciuto (es. i crediti riconosciuti
// solo dalla forma del valore in services/claude.ts, sia quelli ricorrenti sia quelli
// una tantum: non c'è modo di distinguerli senza indovinare un formato non documentato)
// non ha un periodStart deducibile con certezza: niente pacing fabbricato su uno span
// fittizio (vedi resolvePeriodBounds sotto), solo daysUntilReset, che usa il resetsAt
// reale della finestra ed è sempre affidabile.
function canEstimatePacing(window: QuotaWindow): boolean {
  return window.periodType !== 'billing-cycle' || window.periodLength !== null;
}

function computeWindowSnapshot(
  accountId: AccountId,
  window: QuotaWindow,
  subscription: { renewalRule: RenewalRule },
  workSchedule: WorkSchedule,
  now: Date,
): QuotaWindowSnapshot {
  recordDailyUsage(accountId, window);
  recordRecentSample(accountId, window);
  const chartDays = store.get('ui.chartRange') === 'month' ? 30 : 7;
  const dailyHistory = getDailyHistory(accountId, window.id, chartDays);
  const recentSamples = getRecentSamples(accountId, window.id);

  const { periodStart, periodEnd } = resolvePeriodBounds(window, subscription, now);
  const ctx = { window, workSchedule, periodStart, periodEnd, now };
  const pacingAvailable = canEstimatePacing(window);
  const totalPeriodWorkingUnits = budget.workingUnitsBetween(periodStart, periodEnd, workSchedule);

  return {
    window,
    dailyHistory,
    efficiencyIndex: pacingAvailable ? budget.efficiencyIndex(ctx) : null,
    projectedUsage: pacingAvailable ? budget.projectedUsage(ctx) : null,
    daysUntilReset: budget.daysUntilReset(periodEnd, now),
    workingDaysUntilReset: budget.workingDaysUntilReset(periodEnd, workSchedule, now),
    estimatedAutonomyWorkingDays: pacingAvailable ? budget.estimatedAutonomyWorkingDays(ctx) : null,
    // Non gated da pacingAvailable: usa solo window.resetsAt, quindi resta
    // significativo anche per finestre con periodStart sconosciuto (es. crediti
    // una tantum) — vedi budget.sustainableHourlyRate.
    instantRate: budget.instantaneousRate(recentSamples, now),
    sustainableRate: budget.sustainableHourlyRate(window, now),
    ecoScore: pacingAvailable ? budget.ecoScore(dailyHistory, workSchedule, totalPeriodWorkingUnits) : null,
  };
}

function computeAccountSnapshot(
  raw: RawAccountUsage & { accountId: AccountId; lastUpdatedAt?: string; stale?: boolean; lastError?: string },
  subscription: { renewalRule: RenewalRule },
  workSchedule: WorkSchedule,
  now: Date,
): AccountSnapshot {
  const windows = raw.quotaWindows.map((w) => computeWindowSnapshot(raw.accountId, w, subscription, workSchedule, now));
  const criticalWindow = budget.pickCriticalWindow(raw.quotaWindows);
  const criticalSnapshot = criticalWindow ? windows.find((w) => w.window.id === criticalWindow.id) : undefined;

  if (!criticalWindow || !criticalSnapshot) {
    return {
      ...raw,
      windows,
      criticalWindow: null,
      dailyHistory: [],
      efficiencyIndex: null,
      projectedUsage: null,
      daysUntilReset: null,
      workingDaysUntilReset: null,
      estimatedAutonomyWorkingDays: null,
    };
  }

  return {
    ...raw,
    windows,
    criticalWindow,
    dailyHistory: criticalSnapshot.dailyHistory,
    efficiencyIndex: criticalSnapshot.efficiencyIndex,
    projectedUsage: criticalSnapshot.projectedUsage,
    daysUntilReset: criticalSnapshot.daysUntilReset,
    workingDaysUntilReset: criticalSnapshot.workingDaysUntilReset,
    estimatedAutonomyWorkingDays: criticalSnapshot.estimatedAutonomyWorkingDays,
  };
}

function isClaudeConnected(accounts: AppSettings['accounts']): boolean {
  return accounts.claude.enabled === true && !!accounts.claude.session?.sessionKey;
}
function isCopilotConnected(accounts: AppSettings['accounts']): boolean {
  return accounts.copilot.enabled === true && !!accounts.copilot.credentials?.token;
}

type StampedUsage = RawAccountUsage & { accountId: AccountId; lastUpdatedAt: string; stale: boolean; lastError?: string };

// 401/403 da un service (sessionKey/PAT scaduto o revocato) sono l'unico caso in cui
// possiamo dare un consiglio pratico invece del messaggio grezzo del service — vedi
// CLAUDE.md, "Stato avanzamento", sessione sull'errore account_session_invalid.
function friendlyErrorMessage(err: unknown): string {
  const error = err as Error & { status?: number };
  if (error.status === 401 || error.status === 403) {
    return `Sessione scaduta o non valida — riconnetti l'account da Impostazioni. (${error.message})`;
  }
  return error.message;
}

async function fetchAccountOrFallback(
  accountId: AccountId,
  fetchFn: () => Promise<RawAccountUsage>,
  lastGoodKey: string,
): Promise<StampedUsage> {
  try {
    const raw = await fetchFn();
    const stamped: StampedUsage = { ...raw, accountId, lastUpdatedAt: new Date().toISOString(), stale: false };
    store.set(lastGoodKey, stamped);
    return stamped;
  } catch (err) {
    const error = err as Error;
    console.error(`[main] refresh ${accountId} fallito:`, error.message);
    // Segnalato qui (non solo nel chiamante) perché un fallback su dato pregresso
    // valido "assorbe" l'errore sotto — senza questa chiamata un format-drift che
    // emerge DOPO il primo fetch riuscito non verrebbe mai rilevato.
    maybeReportFormatDrift(accountId, err);
    const lastGood = store.get(lastGoodKey) as StampedUsage | undefined;
    if (!lastGood) throw err; // nessun dato pregresso: propaga, il chiamante decide come mostrarlo
    return { ...lastGood, stale: true, lastError: friendlyErrorMessage(err) };
  }
}

// Placeholder mostrato quando un account è collegato/abilitato ma la fetch è
// fallita e non esiste ancora nessun dato pregresso (store.history.lastGood.*):
// senza questo, il renderer non distingue "non collegato" da "collegato ma la
// sincronizzazione è appena fallita", e mostra il messaggio sbagliato ("Nessun
// account collegato") anche quando l'account È collegato — vedi CLAUDE.md,
// "mai schermata bianca o fallimento silenzioso".
// ---------------------------------------------------------------------------
// Auto-segnalazione "format drift" (feedback utente, Giorno 3): se un service
// rileva che il formato di un endpoint non è più quello atteso (FormatDriftError,
// vedi services/_shape.ts), apriamo nel browser una bozza di issue GitHub già
// compilata — MAI valori reali, solo struttura (nomi di campo/tipo) — che
// l'utente deve rivedere e confermare manualmente. Deduplicata per firma della
// struttura: non riapre la stessa bozza ad ogni refresh (ogni 30 minuti).
// ---------------------------------------------------------------------------
function maybeReportFormatDrift(accountId: AccountId, err: unknown): void {
  if (!(err instanceof FormatDriftError)) return;
  if (store.get('diagnostics.autoReportFormatDrift') === false) return;

  const signature = shapeSignature(err.shape);
  const reported = (store.get('diagnostics.reportedSignatures') as Record<string, string>) || {};
  if (reported[signature]) return; // già segnalato per questa forma: non riaprire

  const url = buildFormatDriftIssueUrl({ accountId, endpointLabel: err.endpointLabel, shape: err.shape });
  shell.openExternal(url).catch((openErr: Error) => {
    console.error('[main] impossibile aprire la bozza di segnalazione nel browser:', openErr.message);
  });

  if (Notification.isSupported()) {
    new Notification({
      title: 'IA Hypermiler',
      body: `Il formato della risposta ${accountId === 'claude' ? 'Claude' : 'Copilot'} sembra cambiato: ho aperto una bozza di segnalazione nel browser (da confermare tu).`,
    }).show();
  }

  reported[signature] = new Date().toISOString();
  store.set('diagnostics.reportedSignatures', reported);
}

function emptyAccountSnapshot(accountId: AccountId, planTier: string | null, lastError: string): AccountSnapshot {
  return {
    accountId,
    planTier,
    subscriptionRenewsAt: null,
    quotaWindows: [],
    windows: [],
    criticalWindow: null,
    dailyHistory: [],
    efficiencyIndex: null,
    projectedUsage: null,
    daysUntilReset: null,
    workingDaysUntilReset: null,
    estimatedAutonomyWorkingDays: null,
    stale: true,
    lastError,
  };
}

async function buildUsageSnapshot(): Promise<UsageSnapshot> {
  const now = new Date();
  const workSchedule = store.get('workSchedule') as WorkSchedule;
  const accounts = store.get('accounts') as AppSettings['accounts'];
  const snapshot: UsageSnapshot = { generatedAt: now.toISOString() };

  if (isClaudeConnected(accounts)) {
    try {
      const raw = await fetchAccountOrFallback(
        'claude',
        async () => claudeService.fetchUsage({
          sessionKey: accounts.claude.session.sessionKey as string,
          organizationId: accounts.claude.session.organizationId,
          planTier: accounts.claude.planTier,
          // Letto fresco ad ogni refresh (non persistito): vedi buildClaudeCookieHeader.
          cookieHeader: await buildClaudeCookieHeader(),
        }),
        'history.lastGood.claude',
      );
      snapshot.claude = computeAccountSnapshot(raw, accounts.claude.subscription, workSchedule, now);
    } catch (err) {
      const message = friendlyErrorMessage(err);
      console.error('[main] Claude non disponibile e nessun dato pregresso:', message);
      snapshot.claude = emptyAccountSnapshot('claude', accounts.claude.planTier, message);
    }
    // Sorgente locale indipendente dal fetch dell'account: la calcoliamo anche se
    // claude.ai non ha risposto (snapshot.claude è comunque valorizzato sopra, sia
    // sul percorso riuscito sia su quello di fallback).
    snapshot.claude.localInsights = await computeLocalInsightsIfNeeded();
  }

  if (isCopilotConnected(accounts)) {
    try {
      const raw = await fetchAccountOrFallback(
        'copilot',
        () => copilotService.fetchUsage({
          token: accounts.copilot.credentials.token as string,
          accountScope: accounts.copilot.accountScope,
          manualQuota: accounts.copilot.manualQuota,
        }),
        'history.lastGood.copilot',
      );
      if (!raw.planTier) raw.planTier = accounts.copilot.planTier;
      snapshot.copilot = computeAccountSnapshot(raw, accounts.copilot.subscription, workSchedule, now);
    } catch (err) {
      const message = friendlyErrorMessage(err);
      console.error('[main] Copilot non disponibile e nessun dato pregresso:', message);
      snapshot.copilot = emptyAccountSnapshot('copilot', accounts.copilot.planTier, message);
    }
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Notifiche soglia (default 80%, configurabile) — una sola volta al giorno
// ---------------------------------------------------------------------------
function maybeNotifyThreshold(snapshot: UsageSnapshot): void {
  const threshold = store.get('ui.notificationThresholdPercent') as number;
  const todayKey = new Date().toISOString().slice(0, 10);
  const notifiedToday = (store.get('meta.notifiedToday') as Record<string, boolean>) || {};

  for (const accountId of ['claude', 'copilot'] as AccountId[]) {
    const account = snapshot[accountId];
    if (!account?.criticalWindow) continue;
    const utilization = budget.normalizedUtilization(account.criticalWindow);
    if (utilization === null || utilization < threshold) continue;

    const flagKey = `${accountId}:${todayKey}`;
    if (notifiedToday[flagKey]) continue;

    if (Notification.isSupported()) {
      new Notification({
        title: 'IA Hypermiler',
        body: `${accountId === 'claude' ? 'Claude' : 'Copilot'}: hai superato l'${threshold}% del budget (${account.criticalWindow.label}).`,
      }).show();
    }
    notifiedToday[flagKey] = true;
  }
  store.set('meta.notifiedToday', notifiedToday);
}

async function refreshAndBroadcast(): Promise<void> {
  let snapshot: UsageSnapshot;
  try {
    snapshot = await buildUsageSnapshot();
  } catch (err) {
    console.error('[main] refresh usage fallito:', err);
    return;
  }
  maybeNotifyThreshold(snapshot);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usage:update', snapshot);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
// Il renderer non deve mai ricevere segreti reali (sessionKey, PAT) — vedi CLAUDE.md
// "Sicurezza Electron". `store.store` li contiene in chiaro (servono al main process
// per autenticare le chiamate), quindi ogni volta che passa il confine IPC verso il
// renderer li sostituiamo con un segnaposto: preserva il valore booleano "è collegato?"
// (usato da renderer/settings.ts per lo stato "Connesso"/"Non connesso") senza mai
// esporre il valore reale.
function redactSecretsForRenderer(settings: AppSettings): AppSettings {
  return {
    ...settings,
    accounts: {
      ...settings.accounts,
      claude: {
        ...settings.accounts.claude,
        session: {
          ...settings.accounts.claude.session,
          sessionKey: settings.accounts.claude.session.sessionKey ? '••••••••' : null,
        },
      },
      copilot: {
        ...settings.accounts.copilot,
        credentials: {
          ...settings.accounts.copilot.credentials,
          token: settings.accounts.copilot.credentials.token ? '••••••••' : null,
        },
      },
    },
  };
}

// Il renderer riceve sempre la versione con segnaposto (mai il valore reale): se
// salva le impostazioni dopo aver modificato un ALTRO campo (es. planTier), rimanda
// indietro l'intero oggetto `accounts` così com'è, segnaposto incluso. Senza questa
// difesa, quel segnaposto sovrascriverebbe silenziosamente sessionKey/token reali
// nello store. sessionKey e token cambiano SOLO tramite i flussi dedicati
// (auth:connectClaude/auth:connectCopilot), mai tramite il salvataggio generico.
function preserveRealSecretsOnWrite(key: string, value: unknown): unknown {
  if (key !== 'accounts' || typeof value !== 'object' || value === null) return value;
  const incoming = value as AppSettings['accounts'];
  const current = store.get('accounts') as AppSettings['accounts'];
  return {
    ...incoming,
    claude: {
      ...incoming.claude,
      session: { ...incoming.claude.session, sessionKey: current.claude.session.sessionKey },
    },
    copilot: {
      ...incoming.copilot,
      credentials: { ...incoming.copilot.credentials, token: current.copilot.credentials.token },
    },
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => redactSecretsForRenderer(store.store));

  ipcMain.handle('settings:set', (_event: IpcMainInvokeEvent, patch: Partial<AppSettings>) => {
    for (const [key, value] of Object.entries(patch)) {
      store.set(key, preserveRealSecretsOnWrite(key, value));
    }
    const redacted = redactSecretsForRenderer(store.store);
    // Propaga il cambio al widget se già aperto: alcuni campi (es. colore accento)
    // non hanno un IPC dedicato come ui.windowStyle/ui.alwaysOnTop e altrimenti
    // resterebbero applicati solo al prossimo riavvio della finestra (feedback utente).
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings:update', redacted);
    }
    return redacted;
  });

  ipcMain.on('usage:refreshRequest', () => refreshAndBroadcast());

  ipcMain.on('window:openSettings', () => {
    settingsWindow = createSettingsWindow(store, settingsWindow);
  });

  ipcMain.handle('window:setAlwaysOnTop', (_event: IpcMainInvokeEvent, value: boolean) => {
    store.set('ui.alwaysOnTop', value);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(value, 'floating');
    // Propaga anche alla finestra Impostazioni se aperta (es. attivato dal pin
    // nella titlebar del widget): stessa logica di settings:set sopra, per non
    // lasciare la checkbox "Sempre in primo piano" disallineata.
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('settings:update', redactSecretsForRenderer(store.store));
    }
    return value;
  });

  ipcMain.handle('window:setStyle', (_event: IpcMainInvokeEvent, style: WindowStyle) => {
    store.set('ui.windowStyle', style);
    const wasVisible = mainWindow ? mainWindow.isVisible() : true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    const newWindow = createMainWindow(store);
    mainWindow = newWindow;
    if (!wasVisible) newWindow.hide();
    return style;
  });

  ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.on('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });

  ipcMain.handle('auth:connectClaude', async () => {
    const { sessionKey, capturedAt } = await captureClaudeSession();
    let organizationId: string | null = null;
    try {
      const cookieHeader = await buildClaudeCookieHeader();
      const orgs = await claudeService.listOrganizations(sessionKey, cookieHeader);
      organizationId = orgs[0]?.id ?? null;
    } catch (err) {
      console.error('[main] impossibile risolvere organizationId Claude:', (err as Error).message);
    }
    store.set('accounts.claude.session', { sessionKey, organizationId, capturedAt, expiresAt: null });
    store.set('accounts.claude.enabled', true);
    refreshAndBroadcast();
    return { organizationId };
  });

  ipcMain.handle('auth:connectCopilot', async (_event: IpcMainInvokeEvent, token: string) => {
    const username = await copilotService.resolveUsername(token);
    store.set('accounts.copilot.credentials', { token, username });
    store.set('accounts.copilot.authMethod', 'pat');
    store.set('accounts.copilot.enabled', true);
    refreshAndBroadcast();
    return { username };
  });

  // Via sperimentale alternativa al PAT incollato a mano — vedi CLAUDE.md/RESEARCH.md
  // §2.2: ipotesi da verificare, non confermata, che un token OAuth App riceva da
  // copilot_internal/user una risposta con quota_snapshots dove un PAT non la riceve più.
  ipcMain.handle('auth:connectCopilotOAuth', async (_event: IpcMainInvokeEvent, payload: { clientId: string; clientSecret: string }) => {
    const { accessToken } = await captureGithubOAuthToken(payload);
    const username = await copilotService.resolveUsername(accessToken);
    store.set('accounts.copilot.credentials', { token: accessToken, username });
    store.set('accounts.copilot.oauthApp.clientId', payload.clientId);
    store.set('accounts.copilot.authMethod', 'oauth');
    store.set('accounts.copilot.enabled', true);
    refreshAndBroadcast();
    return { username };
  });

  ipcMain.handle('auth:disconnectClaude', async () => {
    store.set('accounts.claude.session', { sessionKey: null, organizationId: null, capturedAt: null, expiresAt: null });
    store.set('accounts.claude.enabled', false);
    refreshAndBroadcast();
  });

  ipcMain.handle('auth:disconnectCopilot', async () => {
    // oauthApp.clientId non viene cancellato: non è un segreto, resta comodo per riconnettersi.
    store.set('accounts.copilot.credentials', { token: null, username: null });
    store.set('accounts.copilot.enabled', false);
    refreshAndBroadcast();
  });
}

// ---------------------------------------------------------------------------
// Ciclo di vita app
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // È un widget, non un'app documentale: la barra menu di default di Electron
  // (File/Modifica/Vista/Finestra/Aiuto) non serve e appesantiva la skin "pieno"
  // (feedback utente — vedi anche setMenuBarVisibility(false) su ogni finestra
  // in main/windows.ts come difesa aggiuntiva per-finestra).
  Menu.setApplicationMenu(null);

  registerIpcHandlers();

  const win = createMainWindow(store);
  mainWindow = win;
  createTray({
    getMainWindow: () => mainWindow,
    openSettings: () => {
      settingsWindow = createSettingsWindow(store, settingsWindow);
    },
    refreshNow: () => refreshAndBroadcast(),
    store,
  });

  // Il refresh al primo caricamento è già innescato dal renderer stesso
  // (renderer/app.ts chiama requestUsageRefresh() in DOMContentLoaded, sia al primo
  // avvio sia dopo un cambio skin che ricrea la finestra) — un secondo trigger qui
  // duplicherebbe la chiamata alle API Claude/Copilot ad ogni apertura del widget.

  refreshTimer = setInterval(refreshAndBroadcast, REFRESH_INTERVAL_MS);
  startWindowHoverPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(store);
    }
  });
});

app.on('window-all-closed', () => {
  // L'app resta viva in tray anche a finestra chiusa (refresh in background);
  // si esce solo dalla voce "Esci" del menu tray.
});

app.on('before-quit', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (hoverPollTimer) clearInterval(hoverPollTimer);
});
