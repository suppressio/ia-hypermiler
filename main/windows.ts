// main/windows.ts — window creation and management (see ARCHITECTURE.md §2, §6)
// Kept apart from main.ts so it is not weighed down by the skin logic.

import { BrowserWindow } from 'electron';
import path from 'path';
import type Store from 'electron-store';
import type { AppSettings } from '../types/index';

const ROOT = path.join(__dirname, '..');
// renderer/assets/ (not build/, which is not copied into dist/ — see scripts/generate-icons.js)
// so the same app icon reaches an unpackaged `npm start` too.
const ICON_PATH = path.join(ROOT, 'renderer', 'assets', 'app-icon.png');

/** Creates the main window (widget) in the style chosen by the user. */
export function createMainWindow(store: Store<AppSettings>): BrowserWindow {
  const ui = store.get('ui');
  const isTransparent = ui.windowStyle === 'transparent-digital';

  const win = new BrowserWindow({
    width: ui.bounds.width,
    height: ui.bounds.height,
    // Position only if ever saved: without it, Electron centers the window.
    ...(ui.bounds.x !== undefined && ui.bounds.y !== undefined ? { x: ui.bounds.x, y: ui.bounds.y } : {}),
    minWidth: 260,
    minHeight: 320,
    // Always without a native frame, in every skin (user feedback — with frame:true the
    // "filled" skin showed the OS native title bar above the app's custom title bar,
    // duplicated and with the menu bar). Window controls are always the custom ones in
    // renderer/index.html, with dragging handled via CSS -webkit-app-region (see
    // renderer/style.css).
    frame: false,
    transparent: isTransparent,
    // Initial window color before the CSS is applied (avoids a flash in the wrong
    // color) — for the "filled-dark" skin it must be the same hex as --bg-filled-dark in
    // renderer/style.css.
    backgroundColor: isTransparent ? '#00000000' : ui.windowStyle === 'filled-dark' ? '#1a1a1a' : '#fafafa',
    alwaysOnTop: ui.alwaysOnTop,
    show: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Per-window defence in addition to the global Menu.setApplicationMenu(null) in
  // main.ts: without it, the "filled" skin (frame: true) showed Electron's default menu
  // bar (File/Edit/View/Window/Help) above the widget (user feedback).
  win.setMenuBarVisibility(false);
  // A failure here is a blank window: at least it leaves a trace in the log.
  win.loadFile(path.join(ROOT, 'renderer', 'index.html')).catch((err: unknown) => {
    console.error('[windows] widget load failed:', err);
  });

  // Position/size persistence (simple debounce so it is not written on every pixel)
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

/** Creates (or brings to front) the Settings window. */
export function createSettingsWindow(existing?: BrowserWindow | null): BrowserWindow {
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    // Wider than before for the accounts table (issue #4).
    width: 620,
    height: 680,
    resizable: true,
    frame: true,
    transparent: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'renderer', 'settings.html')).catch((err: unknown) => {
    console.error('[windows] Settings load failed:', err);
  });

  return win;
}
