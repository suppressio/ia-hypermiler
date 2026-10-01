// store/defaults.ts — valori di default di AppSettings (schema in ARCHITECTURE.md §1).
// Modulo puro (nessun import di electron/electron-store): usabile anche dai test.

import type { AppSettings } from '../types/index';

export const DEFAULTS: AppSettings = {
  // Registro account (issue #4): parte vuoto, gli account si aggiungono dalla
  // tabella in Impostazioni. Uno store legacy `{ claude, copilot }` viene
  // convertito qui sotto da migrateAccounts() — vedi store/migrate.ts.
  accounts: [],

  workSchedule: {
    // Default true: preserva il comportamento già in uso (pacing sui giorni
    // lavorativi configurati sotto). Disattivabile in Impostazioni per un account
    // personale, dove il pacing per giorni/ore specifici non ha senso.
    enabled: true,
    days: {
      mon: 'full',
      tue: 'full',
      wed: 'full',
      thu: 'full',
      fri: 'full',
      sat: 'off',
      sun: 'off',
    },
    // Ore lavorative/giorno: non ancora usato da budget.ts (che lavora a granularità
    // giornaliera/mezza giornata), riservato per un futuro pacing infra-giornaliero
    // (es. finestra Claude delle 5 ore). Vedi feedback in CLAUDE.md — semplificato
    // da un intervallo inizio/fine a un singolo numero su richiesta dell'utente.
    hoursPerDay: 8,
  },

  ui: {
    language: 'auto',
    windowStyle: 'filled',
    alwaysOnTop: false,
    accentColor: '#2563eb',
    // x/y assenti finché l'utente non sposta la finestra (vedi main/windows.ts).
    bounds: { width: 360, height: 480 },
    chartRange: 'week',
    notificationThresholdPercent: 80,
  },

  history: {
    dailyUsage: [],
    retentionDays: 90,
    recentSamples: [],
  },

  advisorCache: { generatedAt: null, adviceText: null },

  meta: { notifiedToday: {} },

  diagnostics: {
    // Se un endpoint cambia formato, apre una bozza di issue GitHub precompilata
    // (solo struttura, mai valori reali) invece di fallire silenziosamente — vedi
    // services/_shape.ts e diagnostics/githubIssue.ts. Attivo di default: non
    // pubblica nulla da solo, richiede sempre conferma manuale nel browser.
    autoReportFormatDrift: true,
    reportedSignatures: {},
  },

  localInsightsCache: { claudeCode: null },

  updates: {
    // Controllo nuova versione all'avvio e ogni 24h (issue #5, services/updates.ts):
    // solo lettura dell'elenco Release GitHub, nessun download automatico.
    autoCheck: true,
    lastCheckedAt: null,
    lastError: null,
    available: null,
    notifiedVersion: null,
  },
};
