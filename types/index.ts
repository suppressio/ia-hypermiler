// types/index.ts — tipi condivisi tra processo main (Node) e renderer (browser).
// Solo dichiarazioni di tipo: nessun codice a runtime, quindi sicuro da importare
// (con `import type`) da entrambi i contesti senza alcun accoppiamento reale.

export type AccountId = 'claude' | 'copilot';
export type AccountScope = 'personal' | 'organization';
export type DayStatus = 'full' | 'half' | 'off';
export type WindowStyle = 'filled' | 'transparent-digital';
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

/** Snapshot arricchito inviato al renderer via IPC (vedi main.ts). */
export interface AccountSnapshot extends RawAccountUsage {
  accountId: AccountId;
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
  claude?: AccountSnapshot;
  copilot?: AccountSnapshot;
}

export interface ClaudeAccountSettings {
  enabled: boolean;
  accountScope: AccountScope;
  authMethod: 'password' | 'google' | 'sso';
  session: {
    sessionKey: string | null;
    organizationId: string | null;
    capturedAt: string | null;
    expiresAt: string | null;
  };
  planTier: 'free' | 'pro' | 'max_5x' | 'max_20x' | 'team' | 'enterprise';
  subscription: { renewalRule: RenewalRule };
}

export interface CopilotAccountSettings {
  enabled: boolean;
  accountScope: AccountScope;
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
  subscription: { renewalRule: RenewalRule };
  experimentalWarningAcknowledged: boolean;
}

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
  lastGood?: {
    claude?: RawAccountUsage & { accountId: AccountId; lastUpdatedAt: string };
    copilot?: RawAccountUsage & { accountId: AccountId; lastUpdatedAt: string };
  };
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
  accounts: {
    claude: ClaudeAccountSettings;
    copilot: CopilotAccountSettings;
  };
  workSchedule: WorkSchedule;
  ui: UiSettings;
  history: HistorySettings;
  advisorCache: { generatedAt: string | null; adviceText: string | null };
  meta: { notifiedToday: Record<string, boolean> };
  diagnostics: DiagnosticsSettings;
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
  connectClaude(): Promise<{ organizationId: string | null }>;
  connectCopilot(token: string): Promise<{ username: string }>;
  connectCopilotOAuth(clientId: string, clientSecret: string): Promise<{ username: string }>;
  disconnectClaude(): Promise<void>;
  disconnectCopilot(): Promise<void>;
}
