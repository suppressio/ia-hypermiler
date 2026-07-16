// main/windows.ts — creazione e gestione delle finestre (vedi ARCHITECTURE.md §2, §6)
// Isolato da main.ts per non appesantirlo con la logica delle due skin.

import { BrowserWindow } from 'electron';
import path from 'path';
import type Store from 'electron-store';
import type { AppSettings } from '../types/index';

const ROOT = path.join(__dirname, '..');

/** Crea la finestra principale (widget), nello stile scelto dall'utente. */
export function createMainWindow(store: Store<AppSettings>): BrowserWindow {
  const ui = store.get('ui');
  const isTransparent = ui.windowStyle === 'transparent-digital';

  const win = new BrowserWindow({
    width: ui.bounds?.width ?? 360,
    height: ui.bounds?.height ?? 480,
    x: ui.bounds?.x,
    y: ui.bounds?.y,
    minWidth: 260,
    minHeight: 320,
    frame: !isTransparent,
    transparent: isTransparent,
    backgroundColor: isTransparent ? '#00000000' : '#fafafa',
    alwaysOnTop: !!ui.alwaysOnTop,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  // Persistenza posizione/dimensione (debounce semplice per non scrivere ad ogni pixel)
  let saveBoundsTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      store.set('ui.bounds', bounds);
    }, 400);
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);

  return win;
}

/** Crea (o riporta in primo piano) la finestra impostazioni. */
export function createSettingsWindow(store: Store<AppSettings>, existing?: BrowserWindow | null): BrowserWindow {
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: true,
    frame: true,
    transparent: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'renderer', 'settings.html'));

  return win;
}

/** Applica lo stile finestra corrente: richiede ricreazione (frame/transparent non sono modificabili a runtime). */
export function applyWindowStyle(win: BrowserWindow, _store: Store<AppSettings>): BrowserWindow {
  // Placeholder esplicito: Electron non permette di cambiare `frame`/`transparent`
  // su una BrowserWindow già creata. Il chiamante (main.ts) deve distruggere e
  // ricreare la finestra con createMainWindow() quando l'utente cambia stile.
  return win;
}
