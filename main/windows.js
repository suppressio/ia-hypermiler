// main/windows.js — creazione e gestione delle finestre (vedi ARCHITECTURE.md §2, §6)
// Isolato da main.js per non appesantirlo con la logica delle due skin.

const { BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Crea la finestra principale (widget), nello stile scelto dall'utente.
 * @param {import('electron-store')} store
 * @returns {BrowserWindow}
 */
function createMainWindow(store) {
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
  let saveBoundsTimer = null;
  const persistBounds = () => {
    clearTimeout(saveBoundsTimer);
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

/**
 * Crea (o riporta in primo piano) la finestra impostazioni.
 * @param {import('electron-store')} store
 * @param {BrowserWindow | null} existing
 * @returns {BrowserWindow}
 */
function createSettingsWindow(store, existing) {
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
function applyWindowStyle(win, store) {
  // Placeholder esplicito: Electron non permette di cambiare `frame`/`transparent`
  // su una BrowserWindow già creata. Il chiamante (main.js) deve distruggere e
  // ricreare la finestra con createMainWindow() quando l'utente cambia stile.
  return win;
}

module.exports = { createMainWindow, createSettingsWindow, applyWindowStyle };
