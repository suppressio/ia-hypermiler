// preload.js — bridge sicuro renderer <-> main via contextBridge
// nodeIntegration: false e contextIsolation: true sono obbligatori (vedi CLAUDE.md).
// Espone solo i canali IPC necessari, nessun accesso diretto a Node/Electron nel renderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hypermiler', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  onUsageUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('usage:update', listener);
    return () => ipcRenderer.removeListener('usage:update', listener);
  },
  requestUsageRefresh: () => ipcRenderer.send('usage:refreshRequest'),

  openSettingsWindow: () => ipcRenderer.send('window:openSettings'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:setAlwaysOnTop', value),
  setWindowStyle: (style) => ipcRenderer.invoke('window:setStyle', style),

  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  connectClaude: () => ipcRenderer.invoke('auth:connectClaude'),
  connectCopilot: (token) => ipcRenderer.invoke('auth:connectCopilot', token),
});
