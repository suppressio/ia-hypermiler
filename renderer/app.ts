// app.ts — logica renderer del widget principale (nessun accesso diretto a Node.js)
// Legge/scrive solo tramite window.hypermiler esposto da preload.ts.

import type { AccountId, AccountSnapshot, AppSettings, DailyDelta, HypermilerBridge, QuotaWindow, QuotaWindowSnapshot, UsageSnapshot, WindowVerdict } from './types';

declare global {
  interface Window {
    hypermiler: HypermilerBridge;
  }
}

interface RendererState {
  settings: AppSettings | null;
  latestSnapshot: UsageSnapshot | null;
  // null = nessuna scelta esplicita: si mostra il primo account dello snapshot.
  activeAccount: AccountId | null;
  activeWindowId: string | null;
}

const state: RendererState = {
  settings: null,
  latestSnapshot: null,
  activeAccount: null,
  activeWindowId: null,
};

// Mostrato solo quando non c'è ancora nessuna finestra di quota da cui derivare
// un consiglio (account non collegato/prima sincronizzazione) — il consiglio vero
// e proprio arriva sempre da winSnap.dailyTip, generato da dati reali in
// budget.generateDailyTip, mai da qui.
const NO_WINDOW_TIP = 'In attesa di dati per generare un consiglio.';

function applyWindowStyle(style: AppSettings['ui']['windowStyle']): void {
  document.body.classList.remove('style-filled', 'style-filled-dark', 'style-transparent-digital');
  const cls = style === 'transparent-digital' ? 'style-transparent-digital'
    : style === 'filled-dark' ? 'style-filled-dark'
    : 'style-filled';
  document.body.classList.add(cls);
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

// Il valore grezzo di efficiencyIndex (es. "1.75") non è auto-esplicativo — feedback
// utente ("non capisco che valore mostra"). >=1 = si sta consumando meno del ritmo
// ideale (bene), <1 = più del sostenibile (rischio), vedi budget.efficiencyIndex.
function formatEfficiencyHint(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value >= 1 ? 'sotto il ritmo ideale' : 'sopra il ritmo ideale';
}

function formatDays(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10} gg`;
}

// Issue #3: se il reset cade oggi la data (dd/mm/yyyy) non dice nulla di utile —
// conta l'orario. Confronto sul giorno di calendario LOCALE, non UTC.
function formatResetMoment(resetsAt: Date | string): string {
  const d = new Date(resetsAt);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return isToday
    ? `alle ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString('it-IT');
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return `${Math.round(value * 100) / 100}%/h`;
}

// Slot fissi per data (7 o 30), riempiendo i giorni senza dati: con un solo
// giorno di storico (account appena collegato) un'unica barra a larghezza piena
// sembrava un rettangolo pieno invece di un grafico (feedback utente).
function buildChartSeries(deltas: DailyDelta[], days: number): DailyDelta[] {
  const byDate = new Map((deltas || []).map((d) => [d.date, d]));
  const series: DailyDelta[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    series.push(byDate.get(dateStr) ?? { date: dateStr, delta: null, idealShare: null });
  }
  return series;
}

// Grafico "consumo giornaliero vs budget" (EVOLUTION.md punto 1): ogni barra è il
// consumo di QUEL giorno (winSnap.dailyDeltas, calcolati in budget.dailyDeltas),
// non la % cumulata come nella dashboard del provider. Il trattino su ogni slot
// è la quota ideale del giorno (0 nei giorni non lavorativi, metà in quelli a
// mezza giornata): le barre che la superano usano --warning. Giorni senza dato o
// con un reset in mezzo restano una barra minima tenue.
function renderChart(winSnap: QuotaWindowSnapshot | undefined, days: number): void {
  const container = document.getElementById('chart') as HTMLDivElement;
  const idealLabel = document.getElementById('chart-ideal') as HTMLSpanElement;
  container.innerHTML = '';
  idealLabel.textContent = '';

  if (winSnap?.window.periodType === 'rolling-hours') {
    // Stesso criterio del rating a stelle: su una finestra di poche ore un
    // consumo "giornaliero" attraversa più reset e non misura nulla.
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = 'Non applicabile su finestre di poche ore — vedi il consumo istantaneo.';
    container.appendChild(note);
    return;
  }

  const series = buildChartSeries(winSnap?.dailyDeltas ?? [], days);
  const fullDayIdeal = Math.max(0, ...series.map((d) => d.idealShare ?? 0));
  if (fullDayIdeal > 0) idealLabel.textContent = `quota ideale ${formatPercent(fullDayIdeal)}/giorno`;

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
    const hasData = point.delta !== null;
    const barHeight = Math.max(2, scale(point.delta ?? 0));
    const overBudget = hasData && point.idealShare !== null && (point.delta as number) > point.idealShare;
    const rect = document.createElementNS(svgNs, 'rect');
    rect.setAttribute('x', String(i * barWidth + 1));
    rect.setAttribute('y', String(height - barHeight));
    rect.setAttribute('width', String(Math.max(1, barWidth - 2)));
    rect.setAttribute('height', String(barHeight));
    rect.setAttribute('fill', overBudget ? 'var(--warning)' : 'var(--accent)');
    rect.setAttribute('opacity', hasData ? '0.85' : '0.15');
    const title = document.createElementNS(svgNs, 'title');
    title.textContent = hasData
      ? `${point.date}: ${formatPercent(point.delta)}${point.idealShare !== null ? ` (ideale ${formatPercent(point.idealShare)})` : ''}`
      : `${point.date}: nessun dato`;
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

// Gauge "consumo istantaneo": barra che si riempie in base al ritmo recente
// (winSnap.instantRate, %/ora) con un marcatore verticale sul ritmo sostenibile
// per arrivare esattamente al 100% al reset (winSnap.sustainableRate, il
// "pallino target"). La scala si adatta al valore più alto tra i due, non è
// fissa: un ritmo istantaneo molto sopra il target riempie quasi tutta la barra
// ed è colorato con --warning invece di --accent.
function renderInstantGauge(winSnap: QuotaWindowSnapshot | undefined): void {
  const container = document.getElementById('instant-gauge') as HTMLDivElement;
  const label = document.getElementById('gauge-label') as HTMLSpanElement;
  container.innerHTML = '';

  const instant = winSnap?.instantRate ?? null;
  const sustainable = winSnap?.sustainableRate ?? null;

  if (instant === null) {
    label.textContent = 'In attesa di più campioni…';
    return;
  }
  label.textContent = sustainable !== null
    ? `${formatRate(instant)} · target ${formatRate(sustainable)}`
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
    title.textContent = `Ritmo sostenibile: ${formatRate(sustainable)}`;
    marker.appendChild(title);
    svg.appendChild(marker);
  }

  container.appendChild(svg);
}

function starIcon(filled: boolean): SVGSVGElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', filled ? 'var(--accent)' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute('d', 'M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 16.9l-6.2 3.4 1.6-6.8L2.2 8.9l6.9-.6L12 2z');
  svg.appendChild(path);
  return svg;
}

// Rating efficienza a stelle (winSnap.efficiencyRating): quanto costantemente ci
// si è tenuti vicini al ritmo ideale nella finestra `chartDays` (7 o 30 giorni,
// la stessa vista scelta per il grafico — coerenza tra indicatori, vedi
// budget.efficiencyRating). Tenuto vicino a "Indice efficienza" in index.html
// perché è lo stesso concetto su un orizzonte diverso (istantaneo/cumulativo lì,
// media mobile qui) — feedback utente.
function renderEfficiencyRating(winSnap: QuotaWindowSnapshot | undefined, chartDays: number): void {
  const starsContainer = document.getElementById('efficiency-rating-stars') as HTMLDivElement;
  const labelEl = document.getElementById('efficiency-rating-label') as HTMLSpanElement;
  starsContainer.innerHTML = '';

  const rating = winSnap?.efficiencyRating ?? null;
  const isRollingHours = winSnap?.window?.periodType === 'rolling-hours';

  if (!rating) {
    // Su una finestra che si rinnova ogni poche ore (es. limite 5 ore di Claude)
    // un rating su base giornaliera non è un dato mancante: è un concetto che non
    // si applica a quella scala temporale — messaggio esplicito invece di stelle
    // vuote (che si leggerebbero come "pessimo", non come "non applicabile").
    labelEl.textContent = isRollingHours ? 'non applicabile su finestre così brevi' : 'dati insufficienti';
    for (let i = 1; i <= 5; i++) starsContainer.appendChild(starIcon(false));
    return;
  }

  labelEl.textContent = `Rating (${chartDays}gg)`;
  starsContainer.title = `Rapporto medio ideale/reale: ${rating.avgRatio}`;
  for (let i = 1; i <= 5; i++) starsContainer.appendChild(starIcon(i <= rating.stars));
}

// Insight comportamentali da sessioni Claude Code LOCALI (opt-in, vedi
// CLAUDE.md/RESEARCH.md §5) — sottosezione dentro la <details> "Consiglio del
// giorno" (index.html), mostrata solo se abilitati e disponibili: a differenza
// del consiglio (sempre presente), qui l'intero blocco può restare nascosto.
// Presente solo sull'account Claude a cui l'utente ha attribuito le sessioni
// locali (flag per account in Impostazioni): Copilot non ha una sorgente equivalente.
// Resa (EVOLUTION.md punto 4, budget.tokenYield): token prodotti per 1% di quota
// della finestra selezionata, con il trend tra seconda e prima metà dei giorni.
function renderTokenYield(winSnap: QuotaWindowSnapshot | undefined): void {
  const valueEl = document.getElementById('local-insights-yield') as HTMLElement;
  const hintEl = document.getElementById('local-insights-yield-hint') as HTMLElement;
  const y = winSnap?.tokenYield ?? null;
  if (!y) {
    valueEl.textContent = '--';
    hintEl.textContent = winSnap?.window.periodType === 'rolling-hours'
      ? 'non applicabile su finestre di poche ore'
      : 'servono almeno 3 giorni con sessioni locali e consumo di quota';
    return;
  }
  valueEl.textContent = y.tokensPerPercent >= 1000 ? `${Math.round(y.tokensPerPercent / 100) / 10}k` : String(y.tokensPerPercent);
  const trend = y.trendPercent === null ? '' : ` · ${y.trendPercent >= 0 ? '▲' : '▼'}${Math.abs(y.trendPercent)}% vs prima metà`;
  hintEl.textContent = `su ${y.daysCompared}gg${trend}`;
}

function renderLocalInsights(account: AccountSnapshot | undefined): void {
  const details = document.getElementById('local-insights') as HTMLDivElement;
  const insights = account?.localInsights ?? null;
  if (!insights) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  document.getElementById('local-insights-context')!.textContent = formatPercent(insights.highContextSharePercent);
  document.getElementById('local-insights-duration')!.textContent = formatPercent(insights.longSessionSharePercent);

  const list = document.getElementById('local-insights-tools') as HTMLUListElement;
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

// Un account per tab, nell'ordine della tabella in Impostazioni (issue #4: N
// account, anche due dello stesso provider — da qui l'etichetta dell'account, non
// il nome del provider).
function selectAccount(snapshot: UsageSnapshot): AccountSnapshot | undefined {
  const accounts = snapshot.accounts ?? [];
  return accounts.find((a) => a.accountId === state.activeAccount) ?? accounts[0];
}

function renderAccountTabs(snapshot: UsageSnapshot): void {
  const nav = document.getElementById('account-tabs') as HTMLElement;
  const available = snapshot.accounts ?? [];
  if (available.length <= 1) {
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

function formatVerdict(verdict: WindowVerdict, win: QuotaWindow): string {
  const reset = win.resetsAt ? formatResetMoment(win.resetsAt) : null;
  switch (verdict.kind) {
    case 'exhausted': return reset ? `esaurita · rinnovo ${reset}` : 'esaurita';
    case 'at-risk':
      if (verdict.autonomyWorkingDays !== undefined) return `a rischio · finisce tra ${formatDays(verdict.autonomyWorkingDays)} lav.`;
      return `a rischio · proiezione ${formatPercent(verdict.projectedUsage)}`;
    case 'on-track': return 'in linea';
    case 'no-pacing': return reset ? `nessun pacing · rinnovo ${reset}` : 'nessun pacing';
  }
}

// Lista delle finestre di quota dell'account attivo (EVOLUTION.md punto 1), al
// posto delle tab che affiancavano solo le metriche esposte dal provider: una riga
// per finestra con un verdetto calcolato da noi (budget.windowVerdict), la critica
// per prima. Clic su una riga = dettaglio di quella finestra nel resto del widget.
// Nascosta se l'account ha una sola finestra.
function renderWindowList(account: AccountSnapshot): void {
  const list = document.getElementById('window-list') as HTMLElement;
  if (account.windows.length <= 1) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  list.innerHTML = '';
  const selected = selectWindowSnapshot(account);
  const criticalId = account.criticalWindow?.id;
  const ordered = [...account.windows].sort((a, b) => Number(b.window.id === criticalId) - Number(a.window.id === criticalId));

  ordered.forEach((winSnap) => {
    const utilization = budgetNormalizedUtilization(winSnap.window);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `window-row verdict-${winSnap.verdict.kind}${winSnap.window.id === selected?.window.id ? ' active' : ''}`;
    row.title = winSnap.window.label;

    const dot = document.createElement('span');
    dot.className = 'window-row-dot';
    const label = document.createElement('span');
    label.className = 'window-row-label';
    label.textContent = winSnap.window.label;
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
    verdict.textContent = formatVerdict(winSnap.verdict, winSnap.window);

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
  const critical = account.criticalWindow
    ? account.windows.find((w) => w.window.id === account.criticalWindow!.id)
    : undefined;
  return critical ?? account.windows[0];
}

function renderSnapshot(snapshot: UsageSnapshot): void {
  if (!snapshot) return;
  state.latestSnapshot = snapshot;
  renderAccountTabs(snapshot);
  // Stessa finestra (7/30gg) della vista scelta per il grafico, usata anche dal
  // rating a stelle — coerenza tra indicatori, vedi renderEfficiencyRating.
  const chartDays = state.settings?.ui?.chartRange === 'month' ? 30 : 7;

  const account = selectAccount(snapshot);
  if (!account) {
    document.getElementById('window-list')!.hidden = true;
    document.getElementById('current-value')!.textContent = '--';
    document.getElementById('current-label')!.textContent = 'Nessun account collegato — apri le impostazioni';
    renderInstantGauge(undefined);
    renderEfficiencyRating(undefined, chartDays);
    renderLocalInsights(undefined);
    document.getElementById('tips-text')!.textContent = NO_WINDOW_TIP;
    return;
  }

  renderWindowList(account);
  const winSnap = selectWindowSnapshot(account);
  const win = winSnap?.window ?? null;
  const utilization = win ? budgetNormalizedUtilization(win) : null;

  document.getElementById('current-value')!.textContent =
    utilization !== null ? formatPercent(utilization) : (win ? `${win.used}${win.total ? `/${win.total}` : ''}` : '--');

  const resetLabel = win?.resetsAt ? ` · rinnovo ${formatResetMoment(win.resetsAt)}` : '';
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

  renderInstantGauge(winSnap);
  renderEfficiencyRating(winSnap, chartDays);
  renderLocalInsights(account);
  renderTokenYield(winSnap);

  document.getElementById('metric-efficiency')!.textContent = formatEfficiency(winSnap?.efficiencyIndex ?? null);
  document.getElementById('metric-efficiency-hint')!.textContent = formatEfficiencyHint(winSnap?.efficiencyIndex ?? null);
  document.getElementById('metric-projected')!.textContent = formatPercent(winSnap?.projectedUsage ?? null);
  document.getElementById('metric-days-left')!.textContent =
    `${winSnap?.daysUntilReset ?? '--'} (${formatDays(winSnap?.workingDaysUntilReset ?? null)} lav.)`;
  document.getElementById('metric-autonomy')!.textContent = formatDays(winSnap?.estimatedAutonomyWorkingDays ?? null);

  const stats = winSnap?.deltaStats;
  document.getElementById('metric-peak-avg')!.textContent =
    stats?.peak == null ? '--' : `${formatPercent(stats.peak)} / ${formatPercent(stats.avg)}`;
  document.getElementById('metric-streak')!.textContent =
    stats?.streakUnderBudget == null ? '--' : `${stats.streakUnderBudget} gg`;

  document.getElementById('chart-title')!.textContent = `Consumo giornaliero vs budget (${chartDays}gg)`;
  renderChart(winSnap, chartDays);

  document.getElementById('tips-text')!.textContent = winSnap?.dailyTip ?? NO_WINDOW_TIP;
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
  document.getElementById('btn-refresh')!.addEventListener('click', () => {
    // requestUsageRefresh() è "fire and forget" (ipcRenderer.send): il risultato
    // arriva comunque via onUsageUpdate qui sotto, che riabilita il pulsante —
    // disabilitarlo nel frattempo evita solo lo spam-click, non serve altro stato.
    const btn = document.getElementById('btn-refresh') as HTMLButtonElement;
    btn.disabled = true;
    window.hypermiler.requestUsageRefresh();
  });

  window.hypermiler.onUsageUpdate((snapshot) => {
    renderSnapshot(snapshot);
    (document.getElementById('btn-refresh') as HTMLButtonElement).disabled = false;
  });
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
