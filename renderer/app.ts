// app.ts — logica renderer del widget principale (nessun accesso diretto a Node.js)
// Legge/scrive solo tramite window.hypermiler esposto da preload.ts.

import type { AccountId, AccountSnapshot, AppSettings, DailyUsagePoint, HypermilerBridge, QuotaWindow, UsageSnapshot } from './types';

declare global {
  interface Window {
    hypermiler: HypermilerBridge;
  }
}

interface RendererState {
  settings: AppSettings | null;
  latestSnapshot: UsageSnapshot | null;
  activeAccount: AccountId;
}

const state: RendererState = {
  settings: null,
  latestSnapshot: null,
  activeAccount: 'claude',
};

const TIPS_POOL = {
  good: [
    'Stai andando sotto il ritmo ideale: puoi permetterti sessioni più lunghe oggi senza rischiare la quota.',
    'Ottimo passo questa settimana: se hai task complessi in coda, oggi è un buon momento per affrontarli.',
  ],
  warning: [
    'Il ritmo attuale è sopra il budget ideale: prova a spostare le richieste meno urgenti a domani.',
    'Stai consumando più in fretta del previsto: valuta prompt più mirati per ridurre iterazioni inutili.',
  ],
  neutral: [
    "Nessun dato sufficiente ancora per un consiglio mirato: continua a usare l'app, tornerò con suggerimenti più precisi.",
  ],
};

function pickTip(efficiencyIndex: number | null | undefined): string {
  if (efficiencyIndex === null || efficiencyIndex === undefined) {
    return TIPS_POOL.neutral[0];
  }
  const pool = efficiencyIndex >= 1 ? TIPS_POOL.good : TIPS_POOL.warning;
  return pool[Math.floor(Math.random() * pool.length)];
}

function applyWindowStyle(style: AppSettings['ui']['windowStyle']): void {
  document.body.classList.remove('style-filled', 'style-transparent-digital');
  document.body.classList.add(style === 'transparent-digital' ? 'style-transparent-digital' : 'style-filled');
}

// Il colore accento (Impostazioni → Aspetto) era salvato ma non veniva mai
// applicato a nulla: style.css legge --accent da :root, mai aggiornato dal valore
// scelto dall'utente (feedback utente: "cambiandolo non varia nulla").
function applyAccentColor(accentColor: string | undefined): void {
  if (!accentColor) return;
  document.documentElement.style.setProperty('--accent', accentColor);
}

// Riflette lo stato "sempre in primo piano" sul pin in titlebar (stessa fonte di
// verità di ui.alwaysOnTop, già impostabile anche da Impostazioni/tray).
function updatePinButton(active: boolean): void {
  const btn = document.getElementById('btn-pin') as HTMLButtonElement;
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', String(active));
}

// Rivela pulsanti/indicatore di trascinamento in hover su TUTTA la finestra, non
// solo sulla titlebar. Tentativi precedenti con eventi mouse DOM (mouseenter/
// mouseleave, poi mouseover/mouseout con relatedTarget) sono stati abbandonati:
// la striscia -webkit-app-region:drag viene trattata dal sistema operativo come
// area non-client (come una titlebar nativa), quindi il dispatch dei normali
// eventi mouse del documento non è affidabile proprio lì — la barra spariva
// esattamente passandoci sopra, qualunque tecnica DOM si usasse (feedback utente,
// ripetuto più volte). Il fix è calcolare l'hover lato main process, dove
// screen.getCursorScreenPoint() è sempre disponibile indipendentemente dal
// dispatch di eventi del renderer (vedi main.ts, startWindowHoverPolling), e
// riceverlo qui via IPC invece di ricostruirlo da eventi DOM.
function initHoverReveal(): void {
  window.hypermiler.onWindowHoverChanged((isHovering) => {
    document.body.classList.toggle('window-hover', isHovering);
  });
}

// Piccola replica locale di budget.normalizedUtilization: il renderer non può
// fare require()/import di budget.ts (nodeIntegration è disabilitato di proposito).
function budgetNormalizedUtilization(win: QuotaWindow): number | null {
  if (win.unit === 'percentage') return win.used;
  if (win.unit === 'count' && typeof win.total === 'number' && win.total > 0) {
    return Math.round((win.used / win.total) * 1000) / 10;
  }
  return null;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '--%';
  return `${Math.round(value * 10) / 10}%`;
}

function formatEfficiency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return value.toFixed(2);
}

function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10} gg`;
}

function computePeakAvg(dailyHistory: DailyUsagePoint[]): { peak: number | null; avg: number | null } {
  if (!dailyHistory || dailyHistory.length === 0) return { peak: null, avg: null };
  const values = dailyHistory.map((d) => d.used);
  const peak = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return { peak, avg: Math.round(avg * 10) / 10 };
}

function computeStreak(dailyHistory: DailyUsagePoint[]): number | null {
  if (!dailyHistory || dailyHistory.length === 0) return null;
  const values = dailyHistory.map((d) => d.used);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  let streak = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] <= avg) streak += 1;
    else break;
  }
  return streak;
}

// Riempie i giorni senza dati (0) fino a `days` slot fissi, invece di disegnare
// solo i punti realmente registrati: con un solo giorno di storico (account appena
// collegato) un'unica barra a larghezza/altezza piena riempiva tutto il riquadro
// del grafico, sembrando un rettangolo pieno invece di un grafico (feedback utente:
// "si vede solo un rettangolone grigio").
function buildChartSeries(dailyHistory: DailyUsagePoint[], days: number): { date: string; used: number }[] {
  const byDate = new Map((dailyHistory || []).map((d) => [d.date, d.used]));
  const series: { date: string; used: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    series.push({ date: dateStr, used: byDate.get(dateStr) ?? 0 });
  }
  return series;
}

function renderChart(dailyHistory: DailyUsagePoint[], days: number): void {
  const container = document.getElementById('chart') as HTMLDivElement;
  container.innerHTML = '';
  const series = buildChartSeries(dailyHistory, days);

  const width = container.clientWidth || 300;
  const height = 90;
  const max = Math.max(...series.map((d) => d.used), 1);
  const barWidth = width / series.length;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));

  series.forEach((point, i) => {
    const barHeight = Math.max(2, (point.used / max) * (height - 4));
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', String(i * barWidth + 1));
    rect.setAttribute('y', String(height - barHeight));
    rect.setAttribute('width', String(Math.max(1, barWidth - 2)));
    rect.setAttribute('height', String(barHeight));
    // Colore accento (Impostazioni → Aspetto) invece del colore testo di default:
    // era usato solo sulla tab account attiva, invisibile con un solo account
    // collegato — qui invece si vede sempre (feedback utente, scelta esplicita).
    rect.setAttribute('fill', 'var(--accent)');
    // Giorni senza dati reali (riempimento) restano visivamente più tenui, per
    // distinguerli a colpo d'occhio dai giorni con un utilizzo effettivo registrato.
    rect.setAttribute('opacity', point.used > 0 ? '0.85' : '0.15');
    const title = document.createElementNS(svgNs, 'title');
    title.textContent = `${point.date}: ${point.used}`;
    rect.appendChild(title);
    svg.appendChild(rect);
  });

  container.appendChild(svg);
}

function renderAccountTabs(snapshot: UsageSnapshot): void {
  const nav = document.getElementById('account-tabs') as HTMLElement;
  const available = (['claude', 'copilot'] as AccountId[]).filter((id) => snapshot[id]);
  if (available.length <= 1) {
    nav.hidden = true;
    if (available.length === 1) state.activeAccount = available[0];
    return;
  }
  nav.hidden = false;
  nav.innerHTML = '';
  available.forEach((id) => {
    const btn = document.createElement('button');
    btn.textContent = id === 'claude' ? 'Claude' : 'Copilot';
    btn.className = id === state.activeAccount ? 'active' : '';
    btn.addEventListener('click', () => {
      state.activeAccount = id;
      if (state.latestSnapshot) renderSnapshot(state.latestSnapshot);
    });
    nav.appendChild(btn);
  });
}

function renderSnapshot(snapshot: UsageSnapshot): void {
  if (!snapshot) return;
  state.latestSnapshot = snapshot;
  renderAccountTabs(snapshot);

  const account: AccountSnapshot | undefined = snapshot[state.activeAccount] || snapshot.claude || snapshot.copilot;
  if (!account) {
    document.getElementById('current-value')!.textContent = '--';
    document.getElementById('current-label')!.textContent = 'Nessun account collegato — apri le impostazioni';
    return;
  }

  const win = account.criticalWindow;
  const utilization = win ? budgetNormalizedUtilization(win) : null;

  document.getElementById('current-value')!.textContent =
    utilization !== null ? formatPercent(utilization) : (win ? `${win.used}${win.total ? `/${win.total}` : ''}` : '--');

  const resetLabel = win?.resetsAt ? ` · rinnovo ${new Date(win.resetsAt).toLocaleDateString('it-IT')}` : '';
  let label = win ? `${win.label}${resetLabel}` : 'In attesa di dati…';
  if (account.stale) {
    if (account.lastUpdatedAt) {
      const ts = new Date(account.lastUpdatedAt).toLocaleString('it-IT');
      label += ` — dato non aggiornato (ultimo aggiornamento riuscito: ${ts})`;
    } else {
      // Mai una sincronizzazione riuscita finora: l'account è collegato, ma la
      // primissima fetch è fallita — non confondere questo caso con "non collegato".
      label = 'Account collegato — prima sincronizzazione non riuscita';
    }
    if (account.lastError) label += ` (${account.lastError})`;
  }
  document.getElementById('current-label')!.textContent = label;

  document.getElementById('metric-efficiency')!.textContent = formatEfficiency(account.efficiencyIndex);
  document.getElementById('metric-projected')!.textContent = formatPercent(account.projectedUsage);
  document.getElementById('metric-days-left')!.textContent =
    `${account.daysUntilReset ?? '--'} (${formatDays(account.workingDaysUntilReset)} lav.)`;
  document.getElementById('metric-autonomy')!.textContent = formatDays(account.estimatedAutonomyWorkingDays);

  const { peak, avg } = computePeakAvg(account.dailyHistory);
  document.getElementById('metric-peak-avg')!.textContent = peak === null ? '--' : `${peak} / ${avg}`;

  const streak = computeStreak(account.dailyHistory);
  document.getElementById('metric-streak')!.textContent = streak === null ? '--' : `${streak} gg`;

  const chartDays = state.settings?.ui?.chartRange === 'month' ? 30 : 7;
  document.getElementById('chart-title')!.textContent =
    state.settings?.ui?.chartRange === 'month' ? 'Andamento mensile' : 'Andamento settimanale';
  renderChart(account.dailyHistory, chartDays);

  document.getElementById('tips-text')!.textContent = pickTip(account.efficiencyIndex);
}

async function init(): Promise<void> {
  const settings = await window.hypermiler.getSettings();
  state.settings = settings;
  applyWindowStyle(settings.ui.windowStyle);
  applyAccentColor(settings.ui.accentColor);
  updatePinButton(!!settings.ui.alwaysOnTop);
  initHoverReveal();

  document.getElementById('btn-settings')!.addEventListener('click', () => {
    window.hypermiler.openSettingsWindow();
  });
  document.getElementById('btn-minimize')!.addEventListener('click', () => {
    window.hypermiler.minimizeWindow();
  });
  document.getElementById('btn-close')!.addEventListener('click', () => {
    window.hypermiler.closeWindow();
  });
  document.getElementById('btn-pin')!.addEventListener('click', async () => {
    const next = !(state.settings?.ui.alwaysOnTop ?? false);
    await window.hypermiler.setAlwaysOnTop(next);
    if (state.settings) state.settings.ui.alwaysOnTop = next;
    updatePinButton(next);
  });

  window.hypermiler.onUsageUpdate(renderSnapshot);
  // Applica dal vivo i cambi di Impostazioni (es. colore accento, always-on-top
  // cambiato da Impostazioni o dal tray) mentre il widget è già aperto — vedi
  // preload.ts/main.ts (canale settings:update).
  window.hypermiler.onSettingsUpdate((updated) => {
    state.settings = updated;
    applyAccentColor(updated.ui.accentColor);
    updatePinButton(!!updated.ui.alwaysOnTop);
  });
  window.hypermiler.requestUsageRefresh();
}

document.addEventListener('DOMContentLoaded', init);
