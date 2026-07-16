// renderer/types.ts — copia locale, ridotta, dei tipi condivisi in ../types/index.ts.
//
// Duplicata intenzionalmente (invece di importare da '../types/index') per tenere
// il tsconfig del renderer (tsconfig.renderer.json, rootDir "renderer") indipendente
// dal resto del progetto: un import cross-cartella costringerebbe tsc a includere
// file fuori da rootDir e a fallire l'emit (TS6059). Se cambi le interfacce in
// ../types/index.ts, aggiorna anche questo file.

export type AccountId = 'claude' | 'copilot';

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

export interface AccountSnapshot {
  planTier: string | null;
  subscriptionRenewsAt: string | null;
  quotaWindows: QuotaWindow[];
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

export interface AppSettings {
  accounts: {
    claude: { enabled: boolean; accountScope: 'personal' | 'organization'; session: { sessionKey: string | null } };
    copilot: { enabled: boolean; accountScope: 'personal' | 'organization'; credentials: { username: string | null } };
  };
  ui: {
    windowStyle: 'filled' | 'transparent-digital';
    alwaysOnTop: boolean;
    chartRange: 'week' | 'month';
  };
  [key: string]: unknown;
}

export interface HypermilerBridge {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Record<string, unknown>): Promise<AppSettings>;
  onUsageUpdate(callback: (snapshot: UsageSnapshot) => void): () => void;
  requestUsageRefresh(): void;
  openSettingsWindow(): void;
  setAlwaysOnTop(value: boolean): Promise<boolean>;
  setWindowStyle(style: 'filled' | 'transparent-digital'): Promise<string>;
  minimizeWindow(): void;
  closeWindow(): void;
  connectClaude(): Promise<{ organizationId: string | null }>;
  connectCopilot(token: string): Promise<{ username: string }>;
}
