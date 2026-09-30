// types/index.ts — tipi condivisi tra processo main (Node) e renderer (browser).
// Solo dichiarazioni di tipo: nessun codice a runtime, quindi sicuro da importare
// (con `import type`) da entrambi i contesti senza alcun accoppiamento reale.

// Id di un'ISTANZA di account (es. 'claude', 'copilot' per gli account migrati
// dallo schema a due slot, un id generato per quelli aggiunti dopo) — non più il
// nome del provider: con N account (issue #4) due account Claude hanno id diversi.
export type AccountId = string;
export type ProviderId = 'claude' | 'copilot';
export type AccountScope = 'personal' | 'organization';
export type DayStatus = 'full' | 'half' | 'off';
export type WindowStyle = 'filled' | 'filled-dark' | 'transparent-digital';
export type ChartRange = 'week' | 'month';

export interface RenewalRule {
  type: 'dayOfMonth' | 'rrule';
  day?: number;
  rrule?: string;
}

export interface WorkScheduleDays {
  mon: DayStatus;
  tue: DayStatus;
  wed: DayStatus;
  thu: DayStatus;
  fri: DayStatus;
  sat: DayStatus;
  sun: DayStatus;
}

export interface WorkSchedule {
  // Se false, il pacing ignora `days` e tratta ogni giorno di calendario come
  // giornata lavorativa piena (vedi budget.getDayUnit) — pensato per un account
  // personale, dove non ha senso limitarsi a giorni/ore specifici della settimana
  // come invece utile per un account aziendale (feedback utente).
  enabled: boolean;
  days: WorkScheduleDays;
  // Riservato per un futuro pacing infra-giornaliero (vedi CLAUDE.md): non ancora
  // usato dalla logica di budget, che lavora a granularità giorno/mezza-giornata.
  hoursPerDay: number;
}

/** Una singola finestra di quota (vedi ARCHITECTURE.md §0). */
export interface QuotaWindow {
  id: string;
  label: string;
  periodType: 'rolling-hours' | 'rolling-days' | 'billing-cycle';
  periodLength: number | null;
  unit: 'percentage' | 'count';
  used: number;
  total: number | null;
  resetsAt: Date | string | null;
}

/** Dato grezzo restituito da un service (services/claude.ts, services/copilot.ts). */
export interface RawAccountUsage {
  planTier: string | null;
  subscriptionRenewsAt: Date | string | null;
  quotaWindows: QuotaWindow[];
}

export interface DailyUsagePoint {
  date: string;
  accountId: AccountId;
  windowId: string;
  used: number;
  meta?: Record<string, unknown>;
}

/**
 * Campione grezzo con timestamp preciso (non una data di calendario), usato solo
 * per il gauge di consumo istantaneo (vedi budget.instantaneousRate). Distinto da
 * DailyUsagePoint: qui ogni refresh riuscito aggiunge un punto (append), mentre
 * DailyUsagePoint tiene un solo valore per giorno (sovrascritto ad ogni refresh).
 */
export interface RecentUsageSample {
  timestamp: string;
  accountId: AccountId;
  windowId: string;
  used: number;
}

/** Punteggio eco a stelle (vedi budget.ecoScore), su una finestra mobile di giorni. */
export interface EfficiencyRating {
  stars: number;
  avgRatio: number;
}

/** Consumo di un giorno vs quota ideale — vedi budget.dailyDeltas. */
export interface DailyDelta {
  date: string;
  delta: number | null;
  idealShare: number | null;
}

/** Statistiche sul consumo giornaliero — vedi budget.deltaStats. */
export interface DeltaStats {
  peak: number | null;
  avg: number | null;
  streakUnderBudget: number | null;
}

/** Verdetto sintetico di una finestra — vedi budget.windowVerdict. */
export interface WindowVerdict {
  kind: 'exhausted' | 'at-risk' | 'on-track' | 'no-pacing';
  autonomyWorkingDays?: number;
  projectedUsage?: number;
}

/**
 * Metriche calcolate per UNA finestra di quota (vedi main.ts, computeWindowSnapshot).
 * Un account può avere più finestre attive contemporaneamente (es. Claude: limite
 * standard + credito extra una tantum) — il widget le mostra come tab separate invece
 * di appiattirle a una sola "finestra critica".
 */
export interface QuotaWindowSnapshot {
  window: QuotaWindow;
  dailyHistory: DailyUsagePoint[];
  // Consumo giornaliero vs quota ideale (grafico del widget) e relative statistiche.
  dailyDeltas: DailyDelta[];
  deltaStats: DeltaStats;
  verdict: WindowVerdict;
  efficiencyIndex: number | null;
  projectedUsage: number | null;
  daysUntilReset: number | null;
  workingDaysUntilReset: number | null;
  estimatedAutonomyWorkingDays: number | null;
  // Consumo istantaneo (%/ora, dai campioni recenti) e ritmo orario sostenibile
  // per arrivare esattamente al 100% al reset — vedi budget.instantaneousRate /
  // budget.sustainableHourlyRate.
  instantRate: number | null;
  sustainableRate: number | null;
  // Rating efficienza a stelle sugli ultimi giorni (vedi budget.efficiencyRating).
  efficiencyRating: EfficiencyRating | null;
  // "Consiglio del giorno": frase generata da fatti reali sui dati di questa
  // finestra, mai una frase generica — vedi budget.generateDailyTip.
  dailyTip: string;
  // Solo per l'account Claude con insight locali attivi (null altrimenti) — vedi budget.tokenYield.
  tokenYield: TokenYield | null;
}

/** Quota d'uso (in volume di token) di un singolo tool/server MCP — vedi services/claudeLocalSessions.ts. */
export interface ToolUsageShare {
  name: string;
  sharePercent: number;
}

/**
 * Insight comportamentali calcolati da sessioni Claude Code LOCALI (CLI/estensione
 * VS Code, stessa sorgente — vedi RESEARCH.md §5), non dall'account claude.ai.
 * Solo per Claude: Copilot non ha una sorgente locale equivalente. Cross-finestra
 * (non legato a una QuotaWindow specifica): vive su AccountSnapshot, non su
 * QuotaWindowSnapshot. Le quote sono pesate per volume di token (output_tokens),
 * non per conteggio di turni — coerente con "% del tuo utilizzo" del pannello
 * VS Code che l'ha ispirato. Mai calcolato da contenuto reale dei messaggi, solo
 * da campi strutturali (usage, nomi di tool) — vedi services/claudeLocalSessions.ts.
 */
export interface ClaudeLocalInsights {
  computedAt: string;
  windowDays: number;
  sessionsAnalyzed: number;
  highContextSharePercent: number | null;
  longSessionSharePercent: number | null;
  topTools: ToolUsageShare[];
  // Token di output per giorno (sessione attribuita al giorno di ultima modifica).
  daily: LocalDailyTokens[];
}

export interface LocalDailyTokens {
  date: string;
  outputTokens: number;
  highContextOutputTokens: number;
}

/** "Resa": token di output per 1% di quota consumata — vedi budget.tokenYield. */
export interface TokenYield {
  tokensPerPercent: number;
  // Variazione % della resa tra seconda e prima metà dei giorni confrontati (null se non calcolabile).
  trendPercent: number | null;
  daysCompared: number;
}

/** Legame osservato tra giorni di consumo alto e contesto ampio — vedi budget.consumptionCause. */
export interface ConsumptionCause {
  highDaysHighContextPercent: number;
  lowDaysHighContextPercent: number;
  daysCompared: number;
}

/** Snapshot arricchito inviato al renderer via IPC (vedi main.ts). */
export interface AccountSnapshot extends RawAccountUsage {
  accountId: AccountId;
  provider: ProviderId;
  label: string;
  windows: QuotaWindowSnapshot[];
  // Presente solo sull'account Claude con `localInsights: true` nelle Impostazioni
  // (al massimo uno) — vedi main.ts/computeLocalInsightsIfNeeded.
  localInsights?: ClaudeLocalInsights | null;
  // Campi derivati dalla finestra più critica (budget.pickCriticalWindow), mantenuti per
  // compatibilità (notifica soglia 80%, vista di default nel widget) — vedi anche
  // QuotaWindowSnapshot in `windows` per le altre finestre dell'account.
  criticalWindow: QuotaWindow | null;
  dailyHistory: DailyUsagePoint[];
  efficiencyIndex: number | null;
  projectedUsage: number | null;
  daysUntilReset: number | null;
  workingDaysUntilReset: number | null;
  estimatedAutonomyWorkingDays: number | null;
  lastUpdatedAt?: string;
  stale?: boolean;
  lastError?: string;
}

export interface UsageSnapshot {
  generatedAt: string;
  // Un elemento per account abilitato e connesso, nello stesso ordine di
  // AppSettings.accounts.
  accounts: AccountSnapshot[];
}

/**
 * Parte comune a ogni account, indipendente dal provider (issue #4): la parte
 * specifica vive nelle interfacce che la estendono, discriminate su `provider`.
 */
export interface AccountConfigBase {
  id: AccountId;
  provider: ProviderId;
  label: string;
  enabled: boolean;
  accountScope: AccountScope;
  subscription: { renewalRule: RenewalRule };
}

export interface ClaudeAccountSettings extends AccountConfigBase {
  provider: 'claude';
  authMethod: 'password' | 'google' | 'sso';
  session: {
    sessionKey: string | null;
    organizationId: string | null;
    capturedAt: string | null;
    expiresAt: string | null;
  };
  planTier: 'free' | 'pro' | 'max_5x' | 'max_20x' | 'team' | 'enterprise';
  // Partition Electron dedicata (`persist:account-<id>`): cookie claude.ai isolati
  // per account. Prima tutti vivevano in session.defaultSession — un "Disconnetti"
  // non li cancellava e il login successivo riprendeva la stessa sessione (issue #4).
  partition: string;
  // Sessioni Claude Code di QUESTA macchina attribuite a questo account (opt-in,
  // al massimo un account Claude alla volta) — vedi services/claudeLocalSessions.ts.
  localInsights: boolean;
}

export interface CopilotAccountSettings extends AccountConfigBase {
  provider: 'copilot';
  // Sceglie quale pannello di connessione mostrare in Impostazioni (PAT vs OAuth) e viene
  // aggiornato automaticamente dal metodo usato per l'ultima connessione riuscita — vedi
  // renderer/settings.ts (updateCopilotAuthMethodVisibility) e main.ts (auth:connectCopilot*).
  authMethod: 'pat' | 'oauth';
  credentials: { token: string | null; username: string | null };
  // Client ID di una GitHub OAuth App registrata dall'utente (non è un segreto — vedi
  // renderer/settings.ts): via sperimentale alternativa al PAT, vedi CLAUDE.md.
  oauthApp: { clientId: string | null };
  manualQuota: number;
  planTier: 'free' | 'individual' | 'pro_plus' | 'business' | 'enterprise';
  experimentalWarningAcknowledged: boolean;
}

export type AccountConfig = ClaudeAccountSettings | CopilotAccountSettings;

export interface UiSettings {
  windowStyle: WindowStyle;
  alwaysOnTop: boolean;
  accentColor: string;
  bounds: { x?: number; y?: number; width: number; height: number };
  chartRange: ChartRange;
  notificationThresholdPercent: number;
}

export interface HistorySettings {
  dailyUsage: DailyUsagePoint[];
  retentionDays: number;
  // Buffer di campioni ravvicinati (append-only, pruning per età non per giorni)
  // usato solo dal gauge di consumo istantaneo — vedi RecentUsageSample sopra.
  recentSamples: RecentUsageSample[];
  // Chiave = AccountId.
  lastGood?: Record<AccountId, RawAccountUsage & { accountId: AccountId; lastUpdatedAt: string }>;
}

/**
 * Segnalazione automatica di "format drift" (vedi services/_shape.ts, main.ts,
 * diagnostics/githubIssue.ts): quando un service non riconosce più il formato di
 * un endpoint, l'app apre una bozza di issue GitHub precompilata (mai valori
 * reali, solo struttura) e la deduplica per firma per non riaprirla ad ogni refresh.
 */
export interface DiagnosticsSettings {
  autoReportFormatDrift: boolean;
  reportedSignatures: Record<string, string>; // firma -> timestamp ISO di prima segnalazione
}

export interface AppSettings {
  // Registro di N account (issue #4) — prima due slot fissi `{ claude, copilot }`,
  // convertiti all'avvio da store/migrate.ts.
  accounts: AccountConfig[];
  workSchedule: WorkSchedule;
  ui: UiSettings;
  history: HistorySettings;
  advisorCache: { generatedAt: string | null; adviceText: string | null };
  meta: {
    notifiedToday: Record<string, boolean>;
    // Copia una tantum dei cookie claude.ai da session.defaultSession alla
    // partition dell'account Claude migrato (vedi main.ts, migrateLegacyClaudeCookies).
    claudeCookiesMigrated?: boolean;
  };
  diagnostics: DiagnosticsSettings;
  // Cache gestita dall'app (non impostazione utente), stesso pattern di advisorCache:
  // evita di riscandire tutte le sessioni Claude Code locali ad ogni refresh di 30 min
  // — vedi main.ts LOCAL_INSIGHTS_RECOMPUTE_INTERVAL_MS.
  localInsightsCache: { claudeCode: ClaudeLocalInsights | null };
}

/** Credenziali passate a services/claude.ts fetchUsage(). */
export interface ClaudeCredentials {
  sessionKey: string;
  organizationId?: string | null;
  planTier?: string | null;
  // Header Cookie completo (sessionKey + cf_clearance + eventuali altri cookie
  // Cloudflare/claude.ai), letto fresco dalla sessione Electron al momento della
  // richiesta — vedi main/claude-auth.ts:buildClaudeCookieHeader(). Se assente,
  // si ricade sul solo sessionKey (compatibilità/test), ma senza cf_clearance
  // claude.ai risponde con la pagina di verifica Cloudflare invece dei dati.
  cookieHeader?: string | null;
}

/** Credenziali passate a services/copilot.ts fetchUsage(). */
export interface CopilotCredentials {
  token: string;
  accountScope?: AccountScope;
  manualQuota?: number | null;
}

/** API esposta dal preload sul renderer (`window.hypermiler`). */
export interface HypermilerBridge {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  onUsageUpdate(callback: (snapshot: UsageSnapshot) => void): () => void;
  onSettingsUpdate(callback: (settings: AppSettings) => void): () => void;
  onWindowHoverChanged(callback: (isHovering: boolean) => void): () => void;
  requestUsageRefresh(): void;
  openSettingsWindow(): void;
  setAlwaysOnTop(value: boolean): Promise<boolean>;
  setWindowStyle(style: WindowStyle): Promise<WindowStyle>;
  minimizeWindow(): void;
  closeWindow(): void;
  addAccount(provider: ProviderId): Promise<AccountId>;
  removeAccount(id: AccountId): Promise<void>;
  connectClaude(id: AccountId): Promise<{ organizationId: string | null }>;
  connectCopilot(id: AccountId, token: string): Promise<{ username: string }>;
  connectCopilotOAuth(id: AccountId, clientId: string, clientSecret: string): Promise<{ username: string }>;
  disconnectAccount(id: AccountId): Promise<void>;
}
