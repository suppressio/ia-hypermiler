// renderer/types.ts — local, reduced copy of the shared types in ../types/index.ts.
//
// Duplicated on purpose (instead of importing from '../types/index') to keep the
// renderer tsconfig (tsconfig.renderer.json, rootDir "renderer") independent from the
// rest of the project: a cross-folder import would force tsc to include files outside
// rootDir and fail the emit (TS6059). If you change the interfaces in
// ../types/index.ts, update this file too.

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

export interface TodayBudget {
  budget: number;
  usedToday: number;
}

/**
 * The remaining quota spread over the working units from today on (perUnit, % per
 * full working day) next to the even share of the whole period (idealPerUnit) — see
 * budget.redistributedQuota.
 */
export interface Redistribution {
  perUnit: number;
  idealPerUnit: number;
  unitsLeft: number;
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
  kind: 'exhausted' | 'at-risk' | 'behind' | 'on-track' | 'ahead' | 'no-pacing';
  autonomyWorkingDays?: number;
  projectedUsage?: number;
  // From the redistribution (budget.windowVerdict), when the verdict rests on it.
  perUnit?: number;
  idealPerUnit?: number;
  // At risk because the current pace (% per working day) is well above `perUnit`.
  pacePerUnit?: number;
  // Rolling-hours windows: hours of autonomy at the instant pace (budget.hourlyOutlook).
  autonomyHours?: number;
}

/**
 * A window of a few hours (rolling-hours) read in hours, not working days — see
 * budget.hourlyOutlook.
 */
export interface HourlyOutlook {
  hoursLeft: number;
  projectedAtReset: number;
  // Hours to 100% at the instant pace; null when nothing is being consumed.
  autonomyHours: number | null;
}

/**
 * Daily tip as data (see budget.generateDailyTip): a message key plus the
 * numbers it states; the renderer renders it in the active language.
 */
export interface DailyTip {
  key: 'none' | 'autonomy' | 'instantRate' | 'rating' | 'nearReset' | 'nearResetToday' | 'projected' | 'cause' | 'rebalanceDown' | 'rebalanceUp';
  params: Record<string, number>;
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
  todayBudget: TodayBudget | null;
  redistribution: Redistribution | null;
  hourly: HourlyOutlook | null;
  preliminary: boolean;
  instantRate: number | null;
  sustainableRate: number | null;
  efficiencyRating: EfficiencyRating | null;
  dailyTip: DailyTip;
  // Only for the Claude account with local insights enabled (null otherwise).
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
  totalOutputTokens: number;
  highContextOutputTokens: number;
  longSessionOutputTokens: number;
  highContextSharePercent: number | null;
  longSessionSharePercent: number | null;
  topTools: ToolUsageShare[];
  // Output tokens per day (a session is attributed to the day it was last modified).
  daily: LocalDailyTokens[];
}

export interface LocalDailyTokens {
  date: string;
  outputTokens: number;
  highContextOutputTokens: number;
}

/** "Yield": output tokens per 1% of quota used — see budget.tokenYield. */
export interface TokenYield {
  tokensPerPercent: number;
  // % change of the yield between the second and the first half of the compared days (null when not computable).
  trendPercent: number | null;
  daysCompared: number;
}

/** Observed link between high-consumption days and large context — see budget.consumptionCause. */
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
  subscription: { renewalRule: { type: 'dayOfMonth' | 'rrule'; day?: number } };
  workSchedule: {
    enabled: boolean;
    days: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', 'full' | 'half' | 'off'>;
    hoursPerDay: number;
  };
}

export interface ClaudeAccountConfig extends AccountConfigBase {
  provider: 'claude';
  authMethod: 'password' | 'google' | 'sso';
  // sessionKey always arrives redacted (placeholder) from the main process: it only tells "connected yes/no".
  session: { sessionKey: string | null; organizationId: string | null };
  localInsights: boolean;
}

export interface CopilotAccountConfig extends AccountConfigBase {
  provider: 'copilot';
  authMethod: 'pat' | 'oauth';
  accountScope: 'personal' | 'organization';
  host: string;
  credentials: { username: string | null };
  oauthApp: { clientId: string | null };
  manualQuota: number;
  experimentalWarningAcknowledged: boolean;
}

export type AccountConfig = ClaudeAccountConfig | CopilotAccountConfig;

/** New version available — see services/updates.ts (issue #5). */
export interface UpdateInfo {
  version: string;
  publishedAt: string | null;
  releaseUrl: string;
  // Package for the current OS; when none fits (e.g. Intel Mac), the release page.
  downloadUrl: string;
  assetName: string | null;
}

export interface UpdateSettings {
  autoCheck: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  available: UpdateInfo | null;
  // Version already announced with a system notification: not repeated on every check.
  notifiedVersion: string | null;
}

export interface LastGoodUsage {
  subscriptionRenewsAt: string | null;
  quotaWindows: QuotaWindow[];
}

export interface AppSettings {
  accounts: AccountConfig[];
  updates?: UpdateSettings;
  // Sent by settings:get with the rest of the store; only the last good usage of each
  // account is read here (renewal day read from the provider, renderer/renewal.ts).
  history?: { lastGood?: Partial<Record<AccountId, LastGoodUsage>> };
  ui: {
    language: 'auto' | 'en' | 'it';
    windowStyle: 'filled' | 'filled-dark' | 'transparent-digital';
    alwaysOnTop: boolean;
    chartRange: 'week' | 'month';
    accentColor: string;
    notificationThresholdPercent: number;
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
  connectCopilot(id: AccountId, token: string, host: string): Promise<{ username: string }>;
  connectCopilotOAuth(id: AccountId, clientId: string, clientSecret: string, host: string): Promise<{ username: string }>;
  disconnectAccount(id: AccountId): Promise<void>;
  // Diagnostic report: after a confirmation, saves the report file in Downloads and opens
  // a GitHub issue draft; `created` false when the user cancelled.
  createDiagnosticReport(): Promise<{ created: boolean; fileName: string | null }>;
  getAppVersion(): Promise<string>;
  checkForUpdates(): Promise<UpdateSettings>;
  downloadUpdate(): Promise<void>;
  openReleaseNotes(): Promise<void>;
}
