// preload.ts — bridge sicuro renderer <-> main via contextBridge
// nodeIntegration: false e contextIsolation: true sono obbligatori (vedi CLAUDE.md).
// Espone solo i canali IPC necessari, nessun accesso diretto a Node/Electron nel renderer.

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
  // Notifica il widget quando le Impostazioni cambiano (es. colore accento) mentre
  // è già aperto: senza, un campo che non ha un IPC dedicato (a differenza di
  // ui.windowStyle/ui.alwaysOnTop) restava applicato solo al prossimo riavvio.
  onSettingsUpdate: (callback: (settings: AppSettings) => void) => {
    const listener = (_event: unknown, settings: AppSettings) => { callback(settings); };
    ipcRenderer.on('settings:update', listener);
    return () => ipcRenderer.removeListener('settings:update', listener);
  },
  // Stato hover finestra calcolato lato main (screen.getCursorScreenPoint), non
  // da eventi mouse DOM: vedi main.ts (startWindowHoverPolling) per il perché.
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

  // Registro account (issue #4): ogni operazione è per id di account, non per provider.
  addAccount: (provider) => ipcRenderer.invoke('accounts:add', provider),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  connectClaude: (id) => ipcRenderer.invoke('accounts:connectClaude', id),
  connectCopilot: (id, token) => ipcRenderer.invoke('accounts:connectCopilot', id, token),
  connectCopilotOAuth: (id, clientId, clientSecret) => ipcRenderer.invoke('accounts:connectCopilotOAuth', id, { clientId, clientSecret }),
  disconnectAccount: (id) => ipcRenderer.invoke('accounts:disconnect', id),

  // Aggiornamenti (issue #5): l'URL da aprire lo decide il main, mai il renderer.
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  openReleaseNotes: () => ipcRenderer.invoke('updates:openReleaseNotes'),
};

contextBridge.exposeInMainWorld('hypermiler', bridge);
