// preload.ts — secure renderer <-> main bridge via contextBridge
// nodeIntegration: false and contextIsolation: true are mandatory (see CLAUDE.md).
// Exposes only the needed IPC channels, no direct Node/Electron access in the renderer.

import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, HypermilerBridge, UsageSnapshot } from './types/index';

const bridge: HypermilerBridge = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  onUsageUpdate: (callback: (snapshot: UsageSnapshot) => void) => {
    const listener = (_event: unknown, snapshot: UsageSnapshot) => { callback(snapshot); };
    ipcRenderer.on('usage:update', listener);
    return () => ipcRenderer.removeListener('usage:update', listener);
  },
  // Notifies the widget when Settings change (e.g. accent color, language) while it
  // is open: without it, a field with no dedicated IPC (unlike
  // ui.windowStyle/ui.alwaysOnTop) applied only after the next restart.
  onSettingsUpdate: (callback: (settings: AppSettings) => void) => {
    const listener = (_event: unknown, settings: AppSettings) => { callback(settings); };
    ipcRenderer.on('settings:update', listener);
    return () => ipcRenderer.removeListener('settings:update', listener);
  },
  // Window hover state computed in the main process (screen.getCursorScreenPoint), not
  // from DOM mouse events: see main.ts (startWindowHoverPolling) for why.
  onWindowHoverChanged: (callback: (isHovering: boolean) => void) => {
    const listener = (_event: unknown, isHovering: boolean) => { callback(isHovering); };
    ipcRenderer.on('window:hoverChanged', listener);
    return () => ipcRenderer.removeListener('window:hoverChanged', listener);
  },
  requestUsageRefresh: () => { ipcRenderer.send('usage:refreshRequest'); },

  openSettingsWindow: () => { ipcRenderer.send('window:openSettings'); },
  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:setAlwaysOnTop', value),
  setWindowStyle: (style) => ipcRenderer.invoke('window:setStyle', style),

  minimizeWindow: () => { ipcRenderer.send('window:minimize'); },
  closeWindow: () => { ipcRenderer.send('window:close'); },

  // Account registry (issue #4): every operation is per account id, not per provider.
  addAccount: (provider) => ipcRenderer.invoke('accounts:add', provider),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  connectClaude: (id) => ipcRenderer.invoke('accounts:connectClaude', id),
  connectCopilot: (id, token, host) => ipcRenderer.invoke('accounts:connectCopilot', id, token, host),
  connectCopilotOAuth: (id, clientId, clientSecret, host) => ipcRenderer.invoke('accounts:connectCopilotOAuth', id, { clientId, clientSecret, host }),
  disconnectAccount: (id) => ipcRenderer.invoke('accounts:disconnect', id),
  createDiagnosticReport: () => ipcRenderer.invoke('diagnostics:createReport'),

  // Updates (issue #5): the URL to open is decided by the main process, never by the renderer.
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  openReleaseNotes: () => ipcRenderer.invoke('updates:openReleaseNotes'),
};

contextBridge.exposeInMainWorld('hypermiler', bridge);
