// types/ipc.ts — the IPC contract between main, preload and renderer: every channel
// name with its request/response types, and the bridge the preload exposes.
// Type declarations only (same rule as ./index.ts: the renderer build compiles it too).
// Main registers handlers through main/ipc.ts and the preload calls through its own
// typed helpers: both are keyed on these maps, so a misspelled channel, a wrong
// argument or a wrong result type fails the compilation.

import type {
  AccountId,
  AppSettings,
  ProviderId,
  UpdateSettings,
  UsageSnapshot,
  WindowStyle,
} from './index';

export interface CopilotOAuthPayload {
  clientId: string;
  clientSecret: string;
  host: string;
}

// A handler with nothing to return (`void` is only allowed as a generic argument).
type NoResult = Awaited<Promise<void>>;

/** renderer → main, `ipcRenderer.invoke` / `ipcMain.handle`: arguments and result. */
export interface IpcInvokeChannels {
  'settings:get': { args: []; result: AppSettings };
  'settings:set': { args: [patch: Partial<AppSettings>]; result: AppSettings };
  'window:setAlwaysOnTop': { args: [value: boolean]; result: boolean };
  'window:setStyle': { args: [style: WindowStyle]; result: WindowStyle };
  'accounts:add': { args: [provider: ProviderId]; result: AccountId };
  'accounts:remove': { args: [id: AccountId]; result: NoResult };
  'accounts:connectClaude': { args: [id: AccountId]; result: { organizationId: string | null } };
  'accounts:connectCopilot': { args: [id: AccountId, token: string, host: string]; result: { username: string } };
  'accounts:connectCopilotOAuth': { args: [id: AccountId, payload: CopilotOAuthPayload]; result: { username: string } };
  'accounts:disconnect': { args: [id: AccountId]; result: NoResult };
  // After a confirmation, saves the report file in Downloads and opens a GitHub issue
  // draft; `created` false when the user cancelled.
  'diagnostics:createReport': { args: []; result: { created: boolean; fileName: string | null } };
  'app:getVersion': { args: []; result: string };
  'updates:check': { args: []; result: UpdateSettings };
  'updates:download': { args: []; result: NoResult };
  'updates:openReleaseNotes': { args: []; result: NoResult };
  // Opens the user guide (README on GitHub) in the browser; the URL is fixed in main.
  'app:openGuide': { args: []; result: NoResult };
}

/** renderer → main, fire and forget (`ipcRenderer.send` / `ipcMain.on`): arguments. */
export interface IpcSendChannels {
  'usage:refreshRequest': [];
  'window:openSettings': [];
  'window:minimize': [];
  'window:close': [];
}

/** main → renderer (`webContents.send` / `ipcRenderer.on`): arguments of the event. */
export interface IpcEventChannels {
  'usage:update': [snapshot: UsageSnapshot];
  'settings:update': [settings: AppSettings];
  'window:hoverChanged': [isHovering: boolean];
}

/** API exposed by the preload to the renderer (`window.hypermiler`). */
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
  connectCopilot(id: AccountId, token: string, host: string): Promise<{ username: string }>;
  connectCopilotOAuth(id: AccountId, clientId: string, clientSecret: string, host: string): Promise<{ username: string }>;
  disconnectAccount(id: AccountId): Promise<void>;
  createDiagnosticReport(): Promise<{ created: boolean; fileName: string | null }>;
  getAppVersion(): Promise<string>;
  checkForUpdates(): Promise<UpdateSettings>;
  downloadUpdate(): Promise<void>;
  openReleaseNotes(): Promise<void>;
  openGuide(): Promise<void>;
}
