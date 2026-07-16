// main.js — processo principale Electron
// Giorno 2, Sessione 1: dati reali da services/claude.js e services/copilot.js al posto
// del mock del Giorno 1. Se una fetch fallisce, si mostra l'ultimo dato noto con
// timestamp (mai schermata bianca, vedi CLAUDE.md).

const { app, ipcMain, BrowserWindow, Notification } = require('electron');
const store = require('./store');
const { createMainWindow, createSettingsWindow } = require('./main/windows');
const { createTray } = require('./main/tray');
const { captureClaudeSession } = require('./main/claude-auth');
const budget = require('./budget');
const claudeService = require('./services/claude');
const copilotService = require('./services/copilot');

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minuti, come da CLAUDE.md

let mainWindow = null;
let settingsWindow = null;
let refreshTimer = null;

// ---------------------------------------------------------------------------
// Storico locale: Claude e Copilot non forniscono uno storico giornaliero via
// API (vedi RESEARCH.md), quindi lo costruiamo noi, un punto al giorno, ad ogni
// refresh riuscito.
// ---------------------------------------------------------------------------
function recordDailyUsage(accountId, window) {
  const utilization = budget.normalizedUtilization(window);
  if (utilization === null) return;

  const today = new Date().toISOString().slice(0, 10);
  const history = store.get('history.dailyUsage');
  const idx = history.findIndex((h) => h.date === today && h.accountId === accountId && h.windowId === window.id);
  const entry = { date: today, accountId, windowId: window.id, used: Math.round(utilization * 10) / 10 };
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);

  const retentionDays = store.get('history.retentionDays') || 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const pruned = history.filter((h) => new Date(h.date) >= cutoff);
  store.set('history.dailyUsage', pruned);
}

function getDailyHistory(accountId, windowId, days) {
  return store.get('history.dailyUsage')
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
// budget.js è troppo grossolana per un'efficienza realmente significativa — il valore
// resta comunque coerente, ma va letto soprattutto come indicatore corrente, non come
// pacing affidabile su una finestra così breve.
// ---------------------------------------------------------------------------
function resolvePeriodBounds(criticalWindow, subscription, now) {
  if (criticalWindow?.resetsAt) {
    const periodEnd = new Date(criticalWindow.resetsAt);
    const spanMs = criticalWindow.periodType === 'rolling-hours'
      ? criticalWindow.periodLength * 3600 * 1000
      : criticalWindow.periodLength * 24 * 3600 * 1000;
    return { periodStart: new Date(periodEnd.getTime() - spanMs), periodEnd };
  }
  const periodEnd = budget.resolveRenewalDate(subscription.renewalRule, now);
  const periodStart = new Date(periodEnd);
  periodStart.setMonth(periodStart.getMonth() - 1);
  return { periodStart, periodEnd };
}

function computeAccountSnapshot(raw, subscription, workSchedule, now) {
  const criticalWindow = budget.pickCriticalWindow(raw.quotaWindows);
  if (!criticalWindow) return { ...raw, criticalWindow: null };

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

function isClaudeConnected(accounts) {
  return accounts.claude.enabled === true && !!accounts.claude.session?.sessionKey;
}
function isCopilotConnected(accounts) {
  return accounts.copilot.enabled === true && !!accounts.copilot.credentials?.token;
}

async function fetchAccountOrFallback(accountId, fetchFn, lastGoodKey) {
  try {
    const raw = await fetchFn();
    const stamped = { ...raw, accountId, lastUpdatedAt: new Date().toISOString(), stale: false };
    store.set(lastGoodKey, stamped);
    return stamped;
  } catch (err) {
    console.error(`[main] refresh ${accountId} fallito:`, err.message);
    const lastGood = store.get(lastGoodKey);
    if (!lastGood) throw err; // nessun dato pregresso: propaga, il chiamante decide come mostrarlo
    return { ...lastGood, stale: true, lastError: err.message };
  }
}

async function buildUsageSnapshot() {
  const now = new Date();
  const workSchedule = store.get('workSchedule');
  const accounts = store.get('accounts');
  const snapshot = { generatedAt: now.toISOString() };

  if (isClaudeConnected(accounts)) {
    try {
      const raw = await fetchAccountOrFallback(
        'claude',
        () => claudeService.fetchUsage({
          sessionKey: accounts.claude.session.sessionKey,
          organizationId: accounts.claude.session.organizationId,
          planTier: accounts.claude.planTier,
        }),
        'history.lastGood.claude',
      );
      snapshot.claude = computeAccountSnapshot(raw, accounts.claude.subscription, workSchedule, now);
    } catch (err) {
      console.error('[main] Claude non disponibile e nessun dato pregresso:', err.message);
    }
  }

  if (isCopilotConnected(accounts)) {
    try {
      const raw = await fetchAccountOrFallback(
        'copilot',
        () => copilotService.fetchUsage({
          token: accounts.copilot.credentials.token,
          accountScope: accounts.copilot.accountScope,
          manualQuota: accounts.copilot.manualQuota,
        }),
        'history.lastGood.copilot',
      );
      if (!raw.planTier) raw.planTier = accounts.copilot.planTier;
      snapshot.copilot = computeAccountSnapshot(raw, accounts.copilot.subscription, workSchedule, now);
    } catch (err) {
      console.error('[main] Copilot non disponibile e nessun dato pregresso:', err.message);
    }
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Notifiche soglia (default 80%, configurabile) — una sola volta al giorno
// ---------------------------------------------------------------------------
function maybeNotifyThreshold(snapshot) {
  const threshold = store.get('ui.notificationThresholdPercent');
  const todayKey = new Date().toISOString().slice(0, 10);
  const notifiedToday = store.get('meta.notifiedToday') || {};

  for (const accountId of ['claude', 'copilot']) {
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

async function refreshAndBroadcast() {
  let snapshot;
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
function registerIpcHandlers() {
  ipcMain.handle('settings:get', () => store.store);

  ipcMain.handle('settings:set', (_event, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      store.set(key, value);
    }
    return store.store;
  });

  ipcMain.on('usage:refreshRequest', () => refreshAndBroadcast());

  ipcMain.on('window:openSettings', () => {
    settingsWindow = createSettingsWindow(store, settingsWindow);
  });

  ipcMain.handle('window:setAlwaysOnTop', (_event, value) => {
    store.set('ui.alwaysOnTop', value);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(value, 'floating');
    return value;
  });

  ipcMain.handle('window:setStyle', (_event, style) => {
    store.set('ui.windowStyle', style);
    const wasVisible = mainWindow ? mainWindow.isVisible() : true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = createMainWindow(store);
    if (!wasVisible) mainWindow.hide();
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
    let organizationId = null;
    try {
      const orgs = await claudeService.listOrganizations(sessionKey);
      organizationId = orgs[0]?.id ?? null;
    } catch (err) {
      console.error('[main] impossibile risolvere organizationId Claude:', err.message);
    }
    store.set('accounts.claude.session', { sessionKey, organizationId, capturedAt, expiresAt: null });
    store.set('accounts.claude.enabled', true);
    refreshAndBroadcast();
    return { organizationId };
  });

  ipcMain.handle('auth:connectCopilot', async (_event, token) => {
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

  mainWindow = createMainWindow(store);
  createTray({
    getMainWindow: () => mainWindow,
    openSettings: () => {
      settingsWindow = createSettingsWindow(store, settingsWindow);
    },
    refreshNow: () => refreshAndBroadcast(),
    store,
  });

  mainWindow.webContents.once('did-finish-load', () => refreshAndBroadcast());

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
