// renderer/types.ts — copia locale, ridotta, dei tipi condivisi in ../types/index.ts.
//
// Duplicata intenzionalmente (invece di importare da '../types/index') per tenere
// il tsconfig del renderer (tsconfig.renderer.json, rootDir "renderer") indipendente
// dal resto del progetto: un import cross-cartella costringerebbe tsc a includere
// file fuori da rootDir e a fallire l'emit (TS6059). Se cambi le interfacce in
// ../types/index.ts, aggiorna anche questo file.

export type AccountId = string;
export type ProviderId = 'claude' | 'copilot';

export interface QuotaWindow {
  id: string;
  label: string;
  periodType: 'rolling-hours' | 'rolling-days' | 'billing-cycle';
  periodLength: number | null;
  unit: 'percentage' | 'count';
  used: number;
  total: number | null;
  resetsAt: string | null;
}

export interface DailyUsagePoint {
  date: string;
  accountId: AccountId;
  windowId: string;
  used: number;
}

export interface EfficiencyRating {
  stars: number;
  avgRatio: number;
}

export interface DailyDelta {
  date: string;
  delta: number | null;
  idealShare: number | null;
}

export interface DeltaStats {
  peak: number | null;
  avg: number | null;
  streakUnderBudget: number | null;
}

export interface WindowVerdict {
  kind: 'exhausted' | 'at-risk' | 'on-track' | 'no-pacing';
  autonomyWorkingDays?: number;
  projectedUsage?: number;
}

export interface QuotaWindowSnapshot {
  window: QuotaWindow;
  dailyHistory: DailyUsagePoint[];
  dailyDeltas: DailyDelta[];
  deltaStats: DeltaStats;
  verdict: WindowVerdict;
  efficiencyIndex: number | null;
  projectedUsage: number | null;
  daysUntilReset: number | null;
  workingDaysUntilReset: number | null;
  estimatedAutonomyWorkingDays: number | null;
  instantRate: number | null;
  sustainableRate: number | null;
  efficiencyRating: EfficiencyRating | null;
  dailyTip: string;
  // Solo per l'account Claude con insight locali attivi (null altrimenti).
  tokenYield: TokenYield | null;
}

export interface ToolUsageShare {
  name: string;
  sharePercent: number;
}

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

export interface AccountSnapshot {
  planTier: string | null;
  subscriptionRenewsAt: string | null;
  quotaWindows: QuotaWindow[];
  accountId: AccountId;
  provider: ProviderId;
  label: string;
  windows: QuotaWindowSnapshot[];
  criticalWindow: QuotaWindow | null;
  dailyHistory: DailyUsagePoint[];
  efficiencyIndex: number | null;
  projectedUsage: number | null;
  daysUntilReset: number | null;
  workingDaysUntilReset: number | null;
  estimatedAutonomyWorkingDays: number | null;
  localInsights?: ClaudeLocalInsights | null;
  lastUpdatedAt?: string;
  stale?: boolean;
  lastError?: string;
}

export interface UsageSnapshot {
  generatedAt: string;
  accounts: AccountSnapshot[];
}

interface AccountConfigBase {
  id: AccountId;
  provider: ProviderId;
  label: string;
  enabled: boolean;
  accountScope: 'personal' | 'organization';
  subscription: { renewalRule: { type: 'dayOfMonth' | 'rrule'; day?: number } };
}

export interface ClaudeAccountConfig extends AccountConfigBase {
  provider: 'claude';
  authMethod: 'password' | 'google' | 'sso';
  planTier: string;
  // sessionKey arriva sempre redatto (segnaposto) dal main: indica solo "connesso sì/no".
  session: { sessionKey: string | null; organizationId: string | null };
  localInsights: boolean;
}

export interface CopilotAccountConfig extends AccountConfigBase {
  provider: 'copilot';
  authMethod: 'pat' | 'oauth';
  planTier: string;
  credentials: { username: string | null };
  oauthApp: { clientId: string | null };
  manualQuota: number;
  experimentalWarningAcknowledged: boolean;
}

export type AccountConfig = ClaudeAccountConfig | CopilotAccountConfig;

export interface AppSettings {
  accounts: AccountConfig[];
  ui: {
    windowStyle: 'filled' | 'filled-dark' | 'transparent-digital';
    alwaysOnTop: boolean;
    chartRange: 'week' | 'month';
    accentColor: string;
  };
  [key: string]: unknown;
}

export interface HypermilerBridge {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Record<string, unknown>): Promise<AppSettings>;
  onUsageUpdate(callback: (snapshot: UsageSnapshot) => void): () => void;
  onSettingsUpdate(callback: (settings: AppSettings) => void): () => void;
  onWindowHoverChanged(callback: (isHovering: boolean) => void): () => void;
  requestUsageRefresh(): void;
  openSettingsWindow(): void;
  setAlwaysOnTop(value: boolean): Promise<boolean>;
  setWindowStyle(style: 'filled' | 'filled-dark' | 'transparent-digital'): Promise<string>;
  minimizeWindow(): void;
  closeWindow(): void;
  addAccount(provider: ProviderId): Promise<AccountId>;
  removeAccount(id: AccountId): Promise<void>;
  connectClaude(id: AccountId): Promise<{ organizationId: string | null }>;
  connectCopilot(id: AccountId, token: string): Promise<{ username: string }>;
  connectCopilotOAuth(id: AccountId, clientId: string, clientSecret: string): Promise<{ username: string }>;
  disconnectAccount(id: AccountId): Promise<void>;
}
