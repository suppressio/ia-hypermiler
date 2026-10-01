// main/tray.ts — cross-platform system tray (see ARCHITECTURE.md §4)

import { Tray, Menu, nativeImage, app, BrowserWindow, MenuItem } from 'electron';
import path from 'path';
import type Store from 'electron-store';
import type { AppSettings } from '../types/index';
import { t } from './i18n/index';

const ICON_PATH = path.join(__dirname, '..', 'renderer', 'assets', 'tray-icon.png');

export interface CreateTrayDeps {
  getMainWindow: () => BrowserWindow | null;
  openSettings: () => void;
  refreshNow: () => void;
  store: Store<AppSettings>;
}

/** Creates the tray icon with its context menu. */
export interface TrayHandle {
  tray: Tray;
  // Rebuilds the menu (e.g. after an update check or a language change): Electron
  // does not refresh a context menu that is already set.
  refreshMenu: () => void;
}

export function createTray({ getMainWindow, openSettings, refreshNow, store }: CreateTrayDeps): TrayHandle {
  // If the custom icon does not exist (missing asset), an empty fallback icon is used:
  // Electron does not crash, but a real cross-platform asset must ship in builds (see
  // scripts/generate-icons.js).
  let icon;
  try {
    icon = nativeImage.createFromPath(ICON_PATH);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }

  const tray = new Tray(icon);
  tray.setToolTip('IA Hypermiler');

  const toggleMainWindow = () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) win.hide();
    else win.show();
  };

  const buildMenu = () => {
    const ui = store.get('ui');
    const available = store.get('updates').available;
    return Menu.buildFromTemplate([
      ...(available
        ? [{ label: t('tray.updateAvailable', { version: available.version }), click: openSettings }, { type: 'separator' as const }]
        : []),
      { label: t('tray.toggle'), click: toggleMainWindow },
      { label: t('tray.settings'), click: openSettings },
      { label: t('tray.refresh'), click: refreshNow },
      { type: 'separator' },
      {
        label: t('tray.alwaysOnTop'),
        type: 'checkbox',
        checked: ui.alwaysOnTop,
        click: (menuItem: MenuItem) => {
          store.set('ui.alwaysOnTop', menuItem.checked);
          const win = getMainWindow();
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(menuItem.checked, 'floating');
        },
      },
      { type: 'separator' },
      { label: t('tray.quit'), click: () => { app.quit(); } },
    ]);
  };

  tray.setContextMenu(buildMenu());

  // Left click: toggle on Windows/Linux. On macOS a left click usually opens the
  // native tray menu: its "Show/Hide" entry covers that case, giving the same behaviour
  // on every platform.
  tray.on('click', toggleMainWindow);

  return { tray, refreshMenu: () => { tray.setContextMenu(buildMenu()); } };
}
