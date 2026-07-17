// main.ts — processo principale Electron
// Giorno 2, Sessione 1: dati reali da services/claude.ts e services/copilot.ts al posto
// del mock del Giorno 1. Se una fetch fallisce, si mostra l'ultimo dato noto con
// timestamp (mai schermata bianca, vedi CLAUDE.md).

import { app, ipcMain, BrowserWindow, Notification, shell } from 'electron';
import store from './store/index';
import { createMainWindow, createSettingsWindow } from './main/windows';
import { createTray } from './main/tray';
import { captureClaudeSession, buildClaudeCookieHeader } from './main/claude-auth';
import * as budget from './budget';
import * as claudeService from './services/claude';
import * as copilotService from './services/copilot';
import { FormatDriftError, shapeSignature } from './services/_shape';
import { buildFormatDriftIssueUrl } from './diagnostics/githubIssue';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  AccountId,
  AccountSnapshot,
  AppSettings,
  DailyUsagePoint,
  QuotaWindow,
  RawAccountUsage,
  RenewalRule,
  UsageSnapshot,
  WorkSchedule,
  WindowStyle,
} from './types/index';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minuti, come da CLAUDE.md

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

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

function computeAccountSnapshot(
  raw: RawAccountUsage & { accountId: AccountId; lastUpdatedAt?: string; stale?: boolean; lastError?: string },
  subscription: { renewalRule: RenewalRule },
  workSchedule: WorkSchedule,
  now: Date,
): AccountSnapshot {
  const criticalWindow = budget.pickCriticalWindow(raw.quotaWindows);
  if (!criticalWindow) {
    return {
      ...raw,
      criticalWindow: null,
      dailyHistory: [],
      efficiencyIndex: null,
      projectedUsage: null,
      daysUntilReset: null,
      workingDaysUntilReset: null,
      estimatedAutonomyWorkingDays: null,
    };
  }

  recordDailyUsage(raw.accountId, criticalWindow);
  const chartDays = store.get('ui.chartRange') === 'month' ? 30 : 7;
  const dailyHistory = getDailyHistory(raw.accountId, criticalWindow.id, chartDays);

  const { periodStart, periodEnd } = resolvePeriodBounds(criticalWindow, subscription, now);
  const ctx = { window: criticalWindow, workSchedule, periodStart, periodEnd, now };

  return {
    ...raw,
    criticalWindow,
    dailyHistory,
    efficiencyIndex: budget.efficiencyIndex(ctx),
    projectedUsage: budget.projectedUsage(ctx),
    daysUntilReset: budget.daysUntilReset(periodEnd, now),
    workingDaysUntilReset: budget.workingDaysUntilReset(periodEnd, workSchedule, now),
    estimatedAutonomyWorkingDays: budget.estimatedAutonomyWorkingDays(ctx),
  };
}

function isClaudeConnected(accounts: AppSettings['accounts']): boolean {
  return accounts.claude.enabled === true && !!accounts.claude.session?.sessionKey;
}
function isCopilotConnected(accounts: AppSettings['accounts']): boolean {
  return accounts.copilot.enabled === true && !!accounts.copilot.credentials?.token;
}

type StampedUsage = RawAccountUsage & { accountId: AccountId; lastUpdatedAt: string; stale: boolean; lastError?: string };

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
    return { ...lastGood, stale: true, lastError: error.message };
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
      const message = (err as Error).message;
      console.error('[main] Claude non disponibile e nessun dato pregresso:', message);
      snapshot.claude = emptyAccountSnapshot('claude', accounts.claude.planTier, message);
    }
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
      const message = (err as Error).message;
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
function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => store.store);

  ipcMain.handle('settings:set', (_event: IpcMainInvokeEvent, patch: Partial<AppSettings>) => {
    for (const [key, value] of Object.entries(patch)) {
      store.set(key, value);
    }
    return store.store;
  });

  ipcMain.on('usage:refreshRequest', () => refreshAndBroadcast());

  ipcMain.on('window:openSettings', () => {
    settingsWindow = createSettingsWindow(store, settingsWindow);
  });

  ipcMain.handle('window:setAlwaysOnTop', (_event: IpcMainInvokeEvent, value: boolean) => {
    store.set('ui.alwaysOnTop', value);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(value, 'floating');
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
    store.set('accounts.copilot.enabled', true);
    refreshAndBroadcast();
    return { username };
  });
}

// ---------------------------------------------------------------------------
// Ciclo di vita app
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
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

  win.webContents.once('did-finish-load', () => refreshAndBroadcast());

  refreshTimer = setInterval(refreshAndBroadcast, REFRESH_INTERVAL_MS);

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
});
