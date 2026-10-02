// app.ts — renderer logic of the main widget (no direct access to Node.js).
// Reads/writes only through window.hypermiler, exposed by preload.ts.
// Every visible string goes through t() (renderer/i18n): see CLAUDE.md, i18n rule.

import type {
  AccountId,
  AccountSnapshot,
  AppSettings,
  DailyDelta,
  DailyTip,
  HypermilerBridge,
  ProviderId,
  QuotaWindow,
  QuotaWindowSnapshot,
  UsageSnapshot,
  WindowVerdict,
} from './types';
import { byId } from './dom.js';
import { localDateKey, parseDateKey } from './dates.js';
import {
  applyTranslations,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  isMessageKey,
  resolveLocale,
  setLocale,
  t,
} from './i18n/index.js';

declare global {
  interface Window {
    hypermiler: HypermilerBridge;
  }
}

interface RendererState {
  settings: AppSettings | null;
  latestSnapshot: UsageSnapshot | null;
  // null = no explicit choice: the first account of the snapshot is shown.
  activeAccount: AccountId | null;
  activeWindowId: string | null;
}

const state: RendererState = {
  settings: null,
  latestSnapshot: null,
  activeAccount: null,
  activeWindowId: null,
};

// --- Language ------------------------------------------------------------------

// Applies the configured language (or the system one for 'auto') to the static
// markup and re-renders the dynamic parts with the latest snapshot.
function applyLanguage(settings: AppSettings): void {
  const locale = resolveLocale(settings.ui.language, navigator.language);
  setLocale(locale, navigator.language);
  document.documentElement.lang = locale;
  applyTranslations(document);
  if (state.latestSnapshot) renderSnapshot(state.latestSnapshot);
}

// --- Appearance ----------------------------------------------------------------

function applyWindowStyle(style: AppSettings['ui']['windowStyle']): void {
  document.body.classList.remove('style-filled', 'style-filled-dark', 'style-transparent-digital');
  const cls = style === 'transparent-digital' ? 'style-transparent-digital'
    : style === 'filled-dark' ? 'style-filled-dark'
    : 'style-filled';
  document.body.classList.add(cls);
}

// The accent color (Settings → Appearance) used to be saved but never applied:
// style.css reads --accent from :root, which was never updated (user feedback).
function applyAccentColor(accentColor: string | undefined): void {
  if (!accentColor) return;
  document.documentElement.style.setProperty('--accent', accentColor);
}

// Mirrors the "always on top" state on the title bar pin (same source of truth
// as ui.alwaysOnTop, also settable from Settings/tray).
function updatePinButton(active: boolean): void {
  const btn = byId('btn-pin', HTMLButtonElement);
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', String(active));
}

// Reveals buttons/drag handle while hovering the WHOLE window. DOM mouse events
// were abandoned (mouseenter/leave, then mouseover/out): the
// -webkit-app-region:drag strip is treated by the OS as a non-client area, so
// regular document mouse events are unreliable exactly there — the bar vanished
// while hovering it (repeated user feedback). The reliable fix computes hover in
// the main process with screen.getCursorScreenPoint() (see main.ts,
// startWindowHoverPolling) and receives it here via IPC.
function initHoverReveal(): void {
  window.hypermiler.onWindowHoverChanged((isHovering) => {
    document.body.classList.toggle('window-hover', isHovering);
  });
}

// --- Formatting ------------------------------------------------------------------

// Small local copy of budget.normalizedUtilization: the renderer cannot
// require()/import budget.ts (nodeIntegration is disabled on purpose).
function budgetNormalizedUtilization(win: QuotaWindow): number | null {
  if (win.unit === 'percentage') return win.used;
  if (typeof win.total === 'number' && win.total > 0) {
    return Math.round((win.used / win.total) * 1000) / 10;
  }
  return null;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '--%';
  return `${formatNumber(value, 1)}%`;
}

function formatEfficiency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return formatNumber(value, 2);
}

// The raw efficiencyIndex value (e.g. "1.75") is not self-explanatory (user
// feedback). >= 1 = consuming less than the ideal pace (good), < 1 = more than
// sustainable (risk) — see budget.efficiencyIndex.
function formatEfficiencyHint(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value >= 1 ? t('widget.metric.efficiencyBelow') : t('widget.metric.efficiencyAbove');
}

function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return t('unit.days', { n: formatNumber(value, 1) });
}

// Issue #3: when the reset falls today the date says nothing useful — the time
// does. Compared on the LOCAL calendar day, not UTC.
function formatResetMoment(resetsAt: Date | string): string {
  const d = new Date(resetsAt);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return isToday ? t('widget.resetAtTime', { time: formatTime(d) }) : formatDate(d);
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return t('unit.ratePerHour', { n: formatNumber(value, 2) });
}

// Quota window label in the active language. Known window ids have their own
// key; generic windows are labelled from data the snapshot already carries,
// mirroring services/claude.ts (a Claude window with dollar amounts is modelled
// as unit 'count' = extra credit).
function windowLabel(win: QuotaWindow, provider: ProviderId): string {
  const key = `windows.${win.id}`;
  if (isMessageKey(key)) return t(key);
  if (provider === 'claude') {
    return t(win.unit === 'count' ? 'windows.claudeExtraCredit' : 'windows.claudeUndocumented', { name: win.id });
  }
  return t('windows.copilotSnapshot', { name: win.id });
}

// Tip of the day: budget.generateDailyTip returns a key + numbers, the sentence
// is composed here so it follows the active language without a refresh.
function formatTip(tip: DailyTip, win: QuotaWindow, provider: ProviderId): string {
  const window = windowLabel(win, provider);
  const reset = win.resetsAt ? formatDate(win.resetsAt) : t('tips.nextReset');
  // Numbers in the active locale ("6,5" in Italian, not "6.5"): the tip carries raw values.
  const numbers = Object.fromEntries(Object.entries(tip.params).map(([k, v]) => [k, formatNumber(v, 2)]));
  const params = { ...numbers, window, reset };
  switch (tip.key) {
    case 'none': return t('tips.none');
    case 'autonomy': return t('tips.autonomy', params);
    case 'instantRate': return t('tips.instantRate', params);
    case 'rating': return t('tips.rating', params);
    case 'nearReset': return t('tips.nearReset', params);
    case 'nearResetToday': return t('tips.nearResetToday', params);
    case 'projected': return t('tips.projected', params);
    case 'cause': return t('tips.cause', params);
    case 'rebalanceDown': return t('tips.rebalanceDown', params);
    case 'rebalanceUp': return t('tips.rebalanceUp', params);
  }
}

function formatVerdict(verdict: WindowVerdict, win: QuotaWindow): string {
  const moment = win.resetsAt ? formatResetMoment(win.resetsAt) : null;
  // Verdicts resting on the redistribution (budget.windowVerdict) carry the quota per
  // working day left and the even share.
  const quota = verdict.perUnit !== undefined && verdict.idealPerUnit !== undefined
    ? { perUnit: formatPercent(verdict.perUnit), ideal: formatPercent(verdict.idealPerUnit) }
    : null;
  switch (verdict.kind) {
    case 'exhausted': return moment ? t('verdict.exhaustedReset', { moment }) : t('verdict.exhausted');
    case 'at-risk':
      if (quota) return t('verdict.atRiskQuota', quota);
      if (verdict.autonomyWorkingDays !== undefined) return t('verdict.atRiskAutonomy', { days: formatDays(verdict.autonomyWorkingDays) });
      return t('verdict.atRiskProjection', { value: formatPercent(verdict.projectedUsage) });
    case 'behind': return quota ? t('verdict.behind', quota) : t('verdict.onTrack');
    case 'on-track': return quota ? t('verdict.onTrackQuota', quota) : t('verdict.onTrack');
    case 'ahead': return quota ? t('verdict.ahead', quota) : t('verdict.onTrack');
    case 'no-pacing': return moment ? t('verdict.noPacingReset', { moment }) : t('verdict.noPacing');
  }
}

// Today's budget (budget.todayBudget): today's consumption against the share of the
// quota today can use, with what is left or how far over. Shown in the warning colour
// once over budget. The hint also carries the remaining quota redistributed per
// working day (budget.redistributedQuota), also on a non-working day.
function renderTodayBudget(winSnap: QuotaWindowSnapshot | undefined): void {
  const valueEl = byId('metric-today', HTMLElement);
  const hintEl = byId('metric-today-hint', HTMLElement);
  const today = winSnap?.todayBudget ?? null;
  const redistribution = winSnap?.redistribution ?? null;
  const hints: string[] = [];
  if (redistribution) {
    hints.push(t('widget.metric.todayQuota', {
      perUnit: formatPercent(redistribution.perUnit),
      ideal: formatPercent(redistribution.idealPerUnit),
    }));
  }
  valueEl.classList.remove('over-budget');
  if (!today) {
    valueEl.textContent = '--';
    hintEl.textContent = hints.join(' · ');
    return;
  }
  valueEl.textContent = `${formatPercent(today.usedToday)} / ${formatPercent(today.budget)}`;
  const diff = today.budget - today.usedToday;
  if (diff < 0) {
    valueEl.classList.add('over-budget');
    hints.push(t('widget.metric.todayOver', { value: formatPercent(-diff) }));
  } else {
    hints.push(t('widget.metric.todayLeft', { value: formatPercent(diff) }));
  }
  hintEl.textContent = hints.join(' · ');
}

// --- Daily chart -------------------------------------------------------------------

// Fixed date slots (7 or 30), filling days without data: with a single day of
// history (account just connected) one full-width bar looked like a filled
// rectangle instead of a chart (user feedback).
function buildChartSeries(deltas: DailyDelta[], days: number): DailyDelta[] {
  const byDate = new Map(deltas.map((d) => [d.date, d]));
  const series: DailyDelta[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = localDateKey(d);
    series.push(byDate.get(dateStr) ?? { date: dateStr, delta: null, idealShare: null });
  }
  return series;
}

// "Daily consumption vs budget" chart (EVOLUTION.md point 1): each bar is the
// consumption of THAT day (winSnap.dailyDeltas, from budget.dailyDeltas), not the
// cumulative % shown by the provider dashboard. The tick on each slot is the
// day's ideal share (0 on non-working days, half on half days): bars above it use
// --warning. Days without data or with a reset in between stay a faint bar.
function renderChart(winSnap: QuotaWindowSnapshot | undefined, days: number): void {
  const container = byId('chart', HTMLDivElement);
  const idealLabel = byId('chart-ideal', HTMLSpanElement);
  container.innerHTML = '';
  idealLabel.textContent = '';

  if (winSnap?.window.periodType === 'rolling-hours') {
    // Same criterion as the star rating: on a window of a few hours a "daily"
    // consumption spans several resets and measures nothing.
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = t('widget.chart.notApplicable');
    container.appendChild(note);
    return;
  }

  const series = buildChartSeries(winSnap?.dailyDeltas ?? [], days);
  const fullDayIdeal = Math.max(0, ...series.map((d) => d.idealShare ?? 0));
  if (fullDayIdeal > 0) idealLabel.textContent = t('widget.chart.ideal', { value: formatPercent(fullDayIdeal) });

  const width = container.clientWidth || 300;
  const height = 90;
  const max = Math.max(0.1, ...series.map((d) => Math.max(d.delta ?? 0, d.idealShare ?? 0)));
  const barWidth = width / series.length;
  const scale = (value: number) => (value / max) * (height - 4);

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));

  series.forEach((point, i) => {
    const delta = point.delta;
    const barHeight = Math.max(2, scale(delta ?? 0));
    const overBudget = delta !== null && point.idealShare !== null && delta > point.idealShare;
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', String(i * barWidth + 1));
    rect.setAttribute('y', String(height - barHeight));
    rect.setAttribute('width', String(Math.max(1, barWidth - 2)));
    rect.setAttribute('height', String(barHeight));
    rect.setAttribute('fill', overBudget ? 'var(--warning)' : 'var(--accent)');
    rect.setAttribute('opacity', delta !== null ? '0.85' : '0.15');
    const title = document.createElementNS(svgNs, 'title');
    const date = formatDate(parseDateKey(point.date));
    title.textContent = delta === null
      ? t('widget.chart.noData', { date })
      : point.idealShare !== null
        ? t('widget.chart.pointWithIdeal', { date, value: formatPercent(delta), ideal: formatPercent(point.idealShare) })
        : t('widget.chart.point', { date, value: formatPercent(delta) });
    rect.appendChild(title);
    svg.appendChild(rect);

    if (point.idealShare !== null && point.idealShare > 0) {
      const y = height - scale(point.idealShare);
      const tick = document.createElementNS(svgNs, 'line');
      tick.setAttribute('x1', String(i * barWidth));
      tick.setAttribute('x2', String((i + 1) * barWidth));
      tick.setAttribute('y1', String(y));
      tick.setAttribute('y2', String(y));
      tick.setAttribute('stroke', 'currentColor');
      tick.setAttribute('stroke-width', '1');
      tick.setAttribute('stroke-dasharray', '3 2');
      tick.setAttribute('opacity', '0.7');
      svg.appendChild(tick);
    }
  });

  container.appendChild(svg);
}

// --- Instant consumption gauge ------------------------------------------------------

// A bar filled by the recent pace (winSnap.instantRate, %/h) with a vertical
// marker on the sustainable pace that reaches exactly 100% at the reset
// (winSnap.sustainableRate, the "target"). The scale adapts to the larger of the
// two; a pace well above the target fills most of the bar in --warning.
function renderInstantGauge(winSnap: QuotaWindowSnapshot | undefined): void {
  const container = byId('instant-gauge', HTMLDivElement);
  const label = byId('gauge-label', HTMLSpanElement);
  container.innerHTML = '';

  const instant = winSnap?.instantRate ?? null;
  const sustainable = winSnap?.sustainableRate ?? null;

  if (instant === null) {
    label.textContent = t('widget.gauge.waiting');
    return;
  }
  label.textContent = sustainable !== null
    ? t('widget.gauge.withTarget', { rate: formatRate(instant), target: formatRate(sustainable) })
    : formatRate(instant);

  const width = container.clientWidth || 300;
  const height = 20;
  const scaleMax = Math.max(instant, sustainable ?? 0, 0.01) * 1.5;
  const fillWidth = Math.max(0, Math.min(1, instant / scaleMax)) * width;
  const overBudget = sustainable !== null && instant > sustainable;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));

  const track = document.createElementNS(svgNs, 'rect');
  track.setAttribute('x', '0');
  track.setAttribute('y', '0');
  track.setAttribute('width', String(width));
  track.setAttribute('height', String(height));
  track.setAttribute('rx', '4');
  track.setAttribute('fill', 'currentColor');
  track.setAttribute('opacity', '0.1');
  svg.appendChild(track);

  const fill = document.createElementNS(svgNs, 'rect');
  fill.setAttribute('x', '0');
  fill.setAttribute('y', '0');
  fill.setAttribute('width', String(fillWidth));
  fill.setAttribute('height', String(height));
  fill.setAttribute('rx', '4');
  fill.setAttribute('fill', overBudget ? 'var(--warning)' : 'var(--accent)');
  svg.appendChild(fill);

  if (sustainable !== null) {
    const markerX = Math.max(0, Math.min(width - 2, (sustainable / scaleMax) * width));
    const marker = document.createElementNS(svgNs, 'rect');
    marker.setAttribute('x', String(markerX));
    marker.setAttribute('y', '0');
    marker.setAttribute('width', '2');
    marker.setAttribute('height', String(height));
    marker.setAttribute('fill', 'currentColor');
    const title = document.createElementNS(svgNs, 'title');
    title.textContent = t('widget.gauge.sustainable', { rate: formatRate(sustainable) });
    marker.appendChild(title);
    svg.appendChild(marker);
  }

  container.appendChild(svg);
}

// --- Efficiency rating ------------------------------------------------------------

function starIcon(filled: boolean): SVGSVGElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', filled ? 'var(--accent)' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute('d', 'M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 16.9l-6.2 3.4 1.6-6.8L2.2 8.9l6.9-.6L12 2z');
  svg.appendChild(path);
  return svg;
}

// Star rating (winSnap.efficiencyRating): how consistently usage stayed close to
// the ideal pace over `chartDays` (7 or 30, the same view as the chart — see
// budget.efficiencyRating). Kept next to "Efficiency index" in index.html: same
// concept on a different horizon (user feedback).
function renderEfficiencyRating(winSnap: QuotaWindowSnapshot | undefined, chartDays: number): void {
  const starsContainer = byId('efficiency-rating-stars', HTMLDivElement);
  const labelEl = byId('efficiency-rating-label', HTMLSpanElement);
  starsContainer.innerHTML = '';
  starsContainer.removeAttribute('title');

  const rating = winSnap?.efficiencyRating ?? null;
  const isRollingHours = winSnap?.window.periodType === 'rolling-hours';

  if (!rating) {
    // On a window renewing every few hours (e.g. Claude's 5-hour limit) a daily
    // rating is not missing data: the concept does not apply at that time scale —
    // an explicit message instead of empty stars (which would read as "terrible").
    labelEl.textContent = isRollingHours ? t('widget.rating.notApplicable') : t('widget.rating.insufficient');
    for (let i = 1; i <= 5; i++) starsContainer.appendChild(starIcon(false));
    return;
  }

  labelEl.textContent = t('widget.rating.label', { days: chartDays });
  starsContainer.title = t('widget.rating.avgRatio', { ratio: formatNumber(rating.avgRatio, 2) });
  for (let i = 1; i <= 5; i++) starsContainer.appendChild(starIcon(i <= rating.stars));
}

// --- Local insights (Claude Code sessions on this machine) ---------------------------

// Yield (EVOLUTION.md point 4, budget.tokenYield): tokens produced per 1% of quota
// of the selected window, with the trend between the second and first half.
function renderTokenYield(winSnap: QuotaWindowSnapshot | undefined): void {
  const valueEl = byId('local-insights-yield', HTMLElement);
  const hintEl = byId('local-insights-yield-hint', HTMLElement);
  const y = winSnap?.tokenYield ?? null;
  if (!y) {
    valueEl.textContent = '--';
    hintEl.textContent = winSnap?.window.periodType === 'rolling-hours'
      ? t('widget.insights.yieldNotApplicable')
      : t('widget.insights.yieldInsufficient');
    return;
  }
  valueEl.textContent = y.tokensPerPercent >= 1000 ? `${formatNumber(y.tokensPerPercent / 1000, 1)}k` : formatNumber(y.tokensPerPercent, 0);
  const over = t('widget.insights.yieldOver', { days: formatDays(y.daysCompared) });
  hintEl.textContent = y.trendPercent === null
    ? over
    : t('widget.insights.yieldTrend', {
      over,
      arrow: y.trendPercent >= 0 ? '▲' : '▼',
      percent: formatNumber(Math.abs(y.trendPercent), 1),
    });
}

// Behavioural insights from LOCAL Claude Code sessions (opt-in, see RESEARCH.md
// §5) — a sub-section inside the "Tip of the day" <details>, shown only when
// enabled and available. Present only on the Claude account the user attributed
// local sessions to (per-account flag in Settings).
function renderLocalInsights(account: AccountSnapshot | undefined): void {
  const details = byId('local-insights', HTMLDivElement);
  const insights = account?.localInsights ?? null;
  if (!insights) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  byId('local-insights-context').textContent = formatPercent(insights.highContextSharePercent);
  byId('local-insights-duration').textContent = formatPercent(insights.longSessionSharePercent);

  const list = byId('local-insights-tools', HTMLUListElement);
  list.innerHTML = '';
  insights.topTools.forEach((tool) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = tool.name;
    const share = document.createElement('span');
    share.textContent = formatPercent(tool.sharePercent);
    li.appendChild(name);
    li.appendChild(share);
    list.appendChild(li);
  });
}

// --- Accounts and quota windows ------------------------------------------------------

// One tab per account, in the order of the Settings table (issue #4: N accounts,
// possibly two of the same provider — hence the account label, not the provider name).
function selectAccount(snapshot: UsageSnapshot): AccountSnapshot | undefined {
  const accounts = snapshot.accounts;
  return accounts.find((a) => a.accountId === state.activeAccount) ?? accounts[0];
}

function renderAccountTabs(snapshot: UsageSnapshot): void {
  const nav = byId('account-tabs', HTMLElement);
  const available = snapshot.accounts;
  if (available.length <= 1) {
    nav.innerHTML = '';
    nav.hidden = true;
    return;
  }
  const activeId = selectAccount(snapshot)?.accountId;
  nav.hidden = false;
  nav.innerHTML = '';
  available.forEach((account) => {
    const id = account.accountId;
    const btn = document.createElement('button');
    btn.textContent = account.label;
    btn.title = account.label;
    btn.className = id === activeId ? 'active' : '';
    btn.addEventListener('click', () => {
      state.activeAccount = id;
      state.activeWindowId = null;
      if (state.latestSnapshot) renderSnapshot(state.latestSnapshot);
    });
    nav.appendChild(btn);
  });
}

// Quota windows of the active account (EVOLUTION.md point 1), replacing tabs that
// only lined up the provider's metrics: one row per window with a verdict computed
// by the app (budget.windowVerdict), the critical one first. Clicking a row shows
// that window in the rest of the widget. Hidden when the account has one window.
function renderWindowList(account: AccountSnapshot): void {
  const list = byId('window-list', HTMLElement);
  // Always emptied, even when hidden: no row of another account may stay in the
  // DOM (see [hidden] in style.css, 0.2.0 bug).
  list.innerHTML = '';
  if (account.windows.length <= 1) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  const selected = selectWindowSnapshot(account);
  const criticalId = account.criticalWindow?.id;
  const ordered = [...account.windows].sort((a, b) => Number(b.window.id === criticalId) - Number(a.window.id === criticalId));

  ordered.forEach((winSnap) => {
    const utilization = budgetNormalizedUtilization(winSnap.window);
    const labelText = windowLabel(winSnap.window, account.provider);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `window-row verdict-${winSnap.verdict.kind}${winSnap.window.id === selected?.window.id ? ' active' : ''}`;
    row.title = labelText;

    const dot = document.createElement('span');
    dot.className = 'window-row-dot';
    const label = document.createElement('span');
    label.className = 'window-row-label';
    label.textContent = labelText;
    const bar = document.createElement('span');
    bar.className = 'window-row-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(0, Math.min(100, utilization ?? 0))}%`;
    bar.appendChild(fill);
    const pct = document.createElement('span');
    pct.className = 'window-row-pct';
    pct.textContent = formatPercent(utilization);
    const verdict = document.createElement('span');
    verdict.className = 'window-row-verdict';
    const verdictText = formatVerdict(winSnap.verdict, winSnap.window);
    // A verdict resting on projection/autonomy (rolling hours) is flagged while they
    // are preliminary; one resting on the redistribution needs no history.
    const projectionVerdict = (winSnap.verdict.kind === 'at-risk' || winSnap.verdict.kind === 'on-track')
      && winSnap.verdict.perUnit === undefined;
    verdict.textContent = projectionVerdict && winSnap.preliminary
      ? t('verdict.preliminary', { verdict: verdictText })
      : verdictText;

    row.append(dot, label, bar, pct, verdict);
    row.addEventListener('click', () => {
      state.activeWindowId = winSnap.window.id;
      if (state.latestSnapshot) renderSnapshot(state.latestSnapshot);
    });
    list.appendChild(row);
  });
}

function selectWindowSnapshot(account: AccountSnapshot): QuotaWindowSnapshot | undefined {
  if (!account.windows.length) return undefined;
  const byActive = state.activeWindowId
    ? account.windows.find((w) => w.window.id === state.activeWindowId)
    : undefined;
  if (byActive) return byActive;
  const criticalId = account.criticalWindow?.id;
  const critical = criticalId !== undefined
    ? account.windows.find((w) => w.window.id === criticalId)
    : undefined;
  return critical ?? account.windows[0];
}

// --- Main render ------------------------------------------------------------------

function renderSnapshot(snapshot: UsageSnapshot): void {
  state.latestSnapshot = snapshot;
  renderAccountTabs(snapshot);
  // Same window (7/30 days) as the chart view, also used by the star rating.
  const chartDays = state.settings?.ui.chartRange === 'month' ? 30 : 7;

  const account = selectAccount(snapshot);
  if (!account) {
    byId('window-list').hidden = true;
    byId('current-value').textContent = '--';
    byId('current-label').textContent = t('widget.noAccount');
    renderInstantGauge(undefined);
    renderEfficiencyRating(undefined, chartDays);
    renderLocalInsights(undefined);
    byId('tips-text').textContent = t('widget.tips.waiting');
    return;
  }

  renderWindowList(account);
  const winSnap = selectWindowSnapshot(account);
  const win = winSnap?.window ?? null;
  const utilization = win ? budgetNormalizedUtilization(win) : null;

  byId('current-value').textContent =
    utilization !== null ? formatPercent(utilization) : (win ? `${win.used}${win.total ? `/${win.total}` : ''}` : '--');

  let label = t('widget.waiting');
  if (win) {
    const name = windowLabel(win, account.provider);
    label = win.resetsAt ? t('widget.windowWithReset', { window: name, moment: formatResetMoment(win.resetsAt) }) : name;
  }
  if (account.stale) {
    // Never a successful sync so far: the account IS connected but the very first
    // fetch failed — not to be confused with "not connected".
    label = account.lastUpdatedAt
      ? t('widget.stale', { label, time: formatDateTime(account.lastUpdatedAt) })
      : t('widget.firstSyncFailed');
    if (account.lastError) label = t('widget.withError', { label, error: account.lastError });
  }
  byId('current-label').textContent = label;

  renderInstantGauge(winSnap);
  renderEfficiencyRating(winSnap, chartDays);
  renderLocalInsights(account);
  renderTokenYield(winSnap);

  byId('metric-efficiency').textContent = formatEfficiency(winSnap?.efficiencyIndex ?? null);
  byId('metric-efficiency-hint').textContent = formatEfficiencyHint(winSnap?.efficiencyIndex ?? null);
  renderTodayBudget(winSnap);
  byId('metric-projected').textContent = formatPercent(winSnap?.projectedUsage ?? null);
  // Projection and autonomy extrapolated from less than two working days.
  const preliminaryHint = winSnap?.preliminary ? t('widget.metric.preliminary') : '';
  byId('metric-projected-hint').textContent = preliminaryHint;
  byId('metric-autonomy-hint').textContent = preliminaryHint;
  byId('metric-days-left').textContent = t('widget.metric.daysLeftValue', {
    days: winSnap?.daysUntilReset ?? '--',
    working: formatDays(winSnap?.workingDaysUntilReset ?? null),
  });
  byId('metric-autonomy').textContent = formatDays(winSnap?.estimatedAutonomyWorkingDays ?? null);

  const stats = winSnap?.deltaStats;
  byId('metric-peak-avg').textContent =
    stats?.peak == null ? '--' : `${formatPercent(stats.peak)} / ${formatPercent(stats.avg)}`;
  byId('metric-streak').textContent =
    stats?.streakUnderBudget == null ? '--' : formatDays(stats.streakUnderBudget);

  byId('chart-title').textContent = t('widget.chart.title', { days: chartDays });
  renderChart(winSnap, chartDays);

  byId('tips-text').textContent = winSnap && win
    ? formatTip(winSnap.dailyTip, win, account.provider)
    : t('widget.tips.waiting');
}

// --- Startup ----------------------------------------------------------------------

async function togglePin(): Promise<void> {
  const next = !(state.settings?.ui.alwaysOnTop ?? false);
  await window.hypermiler.setAlwaysOnTop(next);
  if (state.settings) state.settings.ui.alwaysOnTop = next;
  updatePinButton(next);
}

async function init(): Promise<void> {
  const settings = await window.hypermiler.getSettings();
  state.settings = settings;
  applyLanguage(settings);
  applyWindowStyle(settings.ui.windowStyle);
  applyAccentColor(settings.ui.accentColor);
  updatePinButton(settings.ui.alwaysOnTop);
  initHoverReveal();

  byId('btn-settings').addEventListener('click', () => {
    window.hypermiler.openSettingsWindow();
  });
  byId('btn-minimize').addEventListener('click', () => {
    window.hypermiler.minimizeWindow();
  });
  byId('btn-close').addEventListener('click', () => {
    window.hypermiler.closeWindow();
  });
  byId('btn-pin').addEventListener('click', () => { runGuarded(togglePin()); });
  byId('btn-refresh').addEventListener('click', () => {
    // requestUsageRefresh() is fire-and-forget (ipcRenderer.send): the result
    // arrives through onUsageUpdate below, which re-enables the button —
    // disabling it meanwhile only prevents spam clicks.
    const btn = byId('btn-refresh', HTMLButtonElement);
    btn.disabled = true;
    window.hypermiler.requestUsageRefresh();
  });

  window.hypermiler.onUsageUpdate((snapshot) => {
    renderSnapshot(snapshot);
    byId('btn-refresh', HTMLButtonElement).disabled = false;
  });
  // Applies Settings changes live while the widget is open (accent color, always
  // on top from Settings/tray, language) — see preload.ts/main.ts, settings:update.
  window.hypermiler.onSettingsUpdate((updated) => {
    const languageChanged = updated.ui.language !== state.settings?.ui.language;
    state.settings = updated;
    applyAccentColor(updated.ui.accentColor);
    updatePinButton(updated.ui.alwaysOnTop);
    if (languageChanged) applyLanguage(updated);
  });
  window.hypermiler.requestUsageRefresh();
}

// An error at startup or on a button must not leave the widget silent: it is
// shown in the label under the main value.
function runGuarded(task: Promise<unknown>): void {
  task.catch((err: unknown) => {
    console.error('[widget]', err);
    const label = document.getElementById('current-label');
    if (label) label.textContent = t('widget.error', { message: err instanceof Error ? err.message : String(err) });
  });
}

document.addEventListener('DOMContentLoaded', () => { runGuarded(init()); });
