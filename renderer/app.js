// app.js — logica renderer del widget principale (nessun accesso diretto a Node.js)
// Legge/scrive solo tramite window.hypermiler esposto da preload.js.

(function () {
  const state = {
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
      'Nessun dato sufficiente ancora per un consiglio mirato: continua a usare l\'app, tornerò con suggerimenti più precisi.',
    ],
  };

  function pickTip(efficiencyIndex) {
    if (efficiencyIndex === null || efficiencyIndex === undefined) {
      return TIPS_POOL.neutral[0];
    }
    const pool = efficiencyIndex >= 1 ? TIPS_POOL.good : TIPS_POOL.warning;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function applyWindowStyle(style) {
    document.body.classList.remove('style-filled', 'style-transparent-digital');
    document.body.classList.add(style === 'transparent-digital' ? 'style-transparent-digital' : 'style-filled');
  }

  // Piccola replica locale di budget.normalizedUtilization: il renderer non può
  // fare require() di budget.js (nodeIntegration è disabilitato di proposito).
  function budgetNormalizedUtilization(win) {
    if (win.unit === 'percentage') return win.used;
    if (win.unit === 'count' && typeof win.total === 'number' && win.total > 0) {
      return Math.round((win.used / win.total) * 1000) / 10;
    }
    return null;
  }

  function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--%';
    return `${Math.round(value * 10) / 10}%`;
  }

  function formatEfficiency(value) {
    if (value === null || value === undefined) return '--';
    return value.toFixed(2);
  }

  function formatDays(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return `${Math.round(value * 10) / 10} gg`;
  }

  function computePeakAvg(dailyHistory) {
    if (!dailyHistory || dailyHistory.length === 0) return { peak: null, avg: null };
    const values = dailyHistory.map((d) => d.used);
    const peak = Math.max(...values);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    return { peak, avg: Math.round(avg * 10) / 10 };
  }

  function computeStreak(dailyHistory) {
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

  function renderChart(dailyHistory) {
    const container = document.getElementById('chart');
    container.innerHTML = '';
    if (!dailyHistory || dailyHistory.length === 0) return;

    const width = container.clientWidth || 300;
    const height = 90;
    const max = Math.max(...dailyHistory.map((d) => d.used), 1);
    const barWidth = width / dailyHistory.length;

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', height);

    dailyHistory.forEach((point, i) => {
      const barHeight = Math.max(2, (point.used / max) * (height - 4));
      const rect = document.createElementNS(svgNs, 'rect');
      rect.setAttribute('x', i * barWidth + 1);
      rect.setAttribute('y', height - barHeight);
      rect.setAttribute('width', Math.max(1, barWidth - 2));
      rect.setAttribute('height', barHeight);
      rect.setAttribute('fill', 'currentColor');
      rect.setAttribute('opacity', '0.75');
      const title = document.createElementNS(svgNs, 'title');
      title.textContent = `${point.date}: ${point.used}`;
      rect.appendChild(title);
      svg.appendChild(rect);
    });

    container.appendChild(svg);
  }

  function renderAccountTabs(snapshot) {
    const nav = document.getElementById('account-tabs');
    const available = ['claude', 'copilot'].filter((id) => snapshot[id]);
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
        renderSnapshot(state.latestSnapshot);
      });
      nav.appendChild(btn);
    });
  }

  function renderSnapshot(snapshot) {
    if (!snapshot) return;
    state.latestSnapshot = snapshot;
    renderAccountTabs(snapshot);

    const account = snapshot[state.activeAccount] || snapshot.claude || snapshot.copilot;
    if (!account) {
      document.getElementById('current-value').textContent = '--';
      document.getElementById('current-label').textContent = 'Nessun account collegato — apri le impostazioni';
      return;
    }

    const win = account.criticalWindow;
    const utilization = win ? budgetNormalizedUtilization(win) : null;

    document.getElementById('current-value').textContent =
      utilization !== null ? formatPercent(utilization) : (win ? `${win.used}${win.total ? `/${win.total}` : ''}` : '--');

    const resetLabel = win?.resetsAt ? ` · rinnovo ${new Date(win.resetsAt).toLocaleDateString('it-IT')}` : '';
    let label = win ? `${win.label}${resetLabel}` : 'In attesa di dati…';
    if (account.stale) {
      const ts = account.lastUpdatedAt ? new Date(account.lastUpdatedAt).toLocaleString('it-IT') : 'sconosciuto';
      label += ` — dato non aggiornato (ultimo aggiornamento riuscito: ${ts})`;
    }
    document.getElementById('current-label').textContent = label;

    document.getElementById('metric-efficiency').textContent = formatEfficiency(account.efficiencyIndex);
    document.getElementById('metric-projected').textContent = formatPercent(account.projectedUsage);
    document.getElementById('metric-days-left').textContent =
      `${account.daysUntilReset ?? '--'} (${formatDays(account.workingDaysUntilReset)} lav.)`;
    document.getElementById('metric-autonomy').textContent = formatDays(account.estimatedAutonomyWorkingDays);

    const { peak, avg } = computePeakAvg(account.dailyHistory);
    document.getElementById('metric-peak-avg').textContent =
      peak === null ? '--' : `${peak} / ${avg}`;

    const streak = computeStreak(account.dailyHistory);
    document.getElementById('metric-streak').textContent = streak === null ? '--' : `${streak} gg`;

    document.getElementById('chart-title').textContent =
      state.settings?.ui?.chartRange === 'month' ? 'Andamento mensile' : 'Andamento settimanale';
    renderChart(account.dailyHistory);

    document.getElementById('tips-text').textContent = pickTip(account.efficiencyIndex);
  }

  async function init() {
    state.settings = await window.hypermiler.getSettings();
    applyWindowStyle(state.settings.ui.windowStyle);

    document.getElementById('btn-settings').addEventListener('click', () => {
      window.hypermiler.openSettingsWindow();
    });
    document.getElementById('btn-minimize').addEventListener('click', () => {
      window.hypermiler.minimizeWindow();
    });
    document.getElementById('btn-close').addEventListener('click', () => {
      window.hypermiler.closeWindow();
    });

    window.hypermiler.onUsageUpdate(renderSnapshot);
    window.hypermiler.requestUsageRefresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
