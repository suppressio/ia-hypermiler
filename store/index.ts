// store/index.ts — wrapper electron-store
// Schema definito in ARCHITECTURE.md §1. Segreti (sessionKey, PAT/token) restano
// cifrati via encryptionKey e non passano mai al renderer se non tramite IPC nel main.
//
// NOTA sicurezza: la encryptionKey qui sotto è un placeholder di sviluppo.
// Prima di qualunque distribuzione va sostituita con una chiave generata in modo
// sicuro (es. da un secret manager o da un valore legato alla macchina), MAI committata.
//
// NOTA electron-store/conf: i DEFAULTS si applicano con un merge SHALLOW
// (Object.assign(defaults, fileStore) in conf/dist/source/index.js) — su
// un'installazione con un file già persistito, un campo nuovo aggiunto dentro un
// oggetto annidato che esiste già nel file (es. `history`, `accounts.claude`) non
// viene fuso: l'intero oggetto persistito sovrascrive quello dei default, campo
// nuovo escluso. Bug reale scoperto aggiungendo `history.recentSamples` (vedi
// CLAUDE.md, gauge "consumo istantaneo"): `store.get('history.recentSamples')`
// tornava `undefined` su installazioni preesistenti, non `[]`. Ogni lettura di un
// campo nested aggiunto dopo il primo rilascio deve avere un fallback esplicito
// (`?? []`/`?? {}`), non assumere che il default configurato qui basti.

import Store from 'electron-store';
import type { AppSettings } from '../types/index';
import { migrateAccounts } from './migrate';

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
    windowStyle: 'filled',
    alwaysOnTop: false,
    accentColor: '#2563eb',
    bounds: { x: undefined, y: undefined, width: 360, height: 480 },
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

const store = new Store<AppSettings>({
  name: 'ia-hypermiler-config',
  encryptionKey: 'dev-only-placeholder-change-before-release',
  defaults: DEFAULTS,
});

// Migrazione schema account: da `{ claude, copilot }` (due slot fissi) ad
// `AccountConfig[]` (issue #4). Eseguita una sola volta: dopo la prima scrittura
// `accounts` è un array e migrateAccounts() non fa più nulla. Il vecchio flag
// globale `localInsights.claudeCode.enabled` passa all'account Claude migrato
// (ora è per-account) e la chiave radice viene rimossa.
// Letture su chiavi non più presenti in AppSettings: via una vista non tipizzata
// dello stesso store, invece di allargare AppSettings con campi legacy.
const untyped = store as unknown as Store<Record<string, unknown>>;
const rawAccounts = untyped.get('accounts');
if (!Array.isArray(rawAccounts)) {
  const legacyLocalInsights = untyped.get('localInsights.claudeCode.enabled') === true;
  store.set('accounts', migrateAccounts(rawAccounts, legacyLocalInsights));
  untyped.delete('localInsights');
}

export default store;
