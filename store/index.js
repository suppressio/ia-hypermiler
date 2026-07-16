// store/index.js — wrapper electron-store
// Schema definito in ARCHITECTURE.md §1. Segreti (sessionKey, PAT/token) restano
// cifrati via encryptionKey e non passano mai al renderer se non tramite IPC nel main.
//
// NOTA sicurezza: la encryptionKey qui sotto è un placeholder di sviluppo.
// Prima di qualunque distribuzione va sostituita con una chiave generata in modo
// sicuro (es. da un secret manager o da un valore legato alla macchina), MAI committata.

const Store = require('electron-store');

const DEFAULTS = {
  accounts: {
    claude: {
      enabled: false,
      accountScope: 'personal', // 'personal' | 'organization'
      authMethod: 'password', // 'password' | 'google' | 'sso'
      session: {
        sessionKey: null,
        organizationId: null,
        capturedAt: null,
        expiresAt: null,
      },
      planTier: 'pro', // 'free' | 'pro' | 'max_5x' | 'max_20x' | 'team' | 'enterprise'
      subscription: {
        renewalRule: { type: 'dayOfMonth', day: 1 },
      },
    },
    copilot: {
      enabled: false,
      accountScope: 'personal', // 'personal' | 'organization'
      authMethod: 'fine_grained_pat', // 'fine_grained_pat' | 'classic_pat' | 'oauth_device'
      credentials: {
        token: null,
        username: null,
      },
      // L'API di billing Copilot non espone la quota totale del piano: valore
      // configurato manualmente (vedi ARCHITECTURE.md §0 e RESEARCH.md v3 §3).
      manualQuota: 300,
      planTier: 'individual', // 'free' | 'individual' | 'pro_plus' | 'business' | 'enterprise'
      subscription: {
        renewalRule: { type: 'dayOfMonth', day: 1 },
      },
      experimentalWarningAcknowledged: false,
    },
  },

  workSchedule: {
    days: {
      mon: 'full',
      tue: 'full',
      wed: 'full',
      thu: 'full',
      fri: 'full',
      sat: 'off',
      sun: 'off',
    },
    // Ore lavorative/giorno: non ancora usato da budget.js (che lavora a granularità
    // giornaliera/mezza giornata), riservato per un futuro pacing infra-giornaliero
    // (es. finestra Claude delle 5 ore). Vedi feedback in CLAUDE.md — semplificato
    // da un intervallo inizio/fine a un singolo numero su richiesta dell'utente.
    hoursPerDay: 8,
  },

  ui: {
    windowStyle: 'filled', // 'filled' | 'transparent-digital'
    alwaysOnTop: false,
    accentColor: '#2563eb',
    bounds: { x: undefined, y: undefined, width: 360, height: 480 },
    chartRange: 'week', // 'week' | 'month'
    notificationThresholdPercent: 80,
  },

  history: {
    dailyUsage: [], // { date, accountId, windowId, used, meta? }
    retentionDays: 90,
  },

  advisorCache: { generatedAt: null, adviceText: null },

  meta: { notifiedToday: {} },
};

const store = new Store({
  name: 'ia-hypermiler-config',
  encryptionKey: 'dev-only-placeholder-change-before-release',
  defaults: DEFAULTS,
});

module.exports = store;
module.exports.DEFAULTS = DEFAULTS;
