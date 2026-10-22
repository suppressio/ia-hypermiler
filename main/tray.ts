// main/tray.ts — cross-platform system tray (see docs/ARCHITECTURE.md §4)

import { Tray, Menu, nativeImage, app, BrowserWindow, MenuItem } from 'electron';
import path from 'path';
import type Store from 'electron-store';
import { trayTooltip } from './traySummary';
import { BADGE_SIZE, badgeText, badgeTone, pickBadge, renderBadge } from './trayBadge';
import type { AppSettings, UsageSnapshot } from '../types/index';
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
  updateUsage: (snapshot: UsageSnapshot) => void;
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

  const baseIcon = icon;
  const tray = new Tray(icon);
  tray.setToolTip('IA Hypermiler');

  // Usage badge (#33). macOS shows the percentage as text next to the icon (the menu
  // bar has room for it, and a drawn number would not follow the system appearance);
  // Windows and Linux (StatusNotifier) have no tray text, so the icon itself becomes
  // the number. The taskbar overlay of Windows belongs to windows, not to the tray.
  // Re-rendered only when the shown value changes: nothing runs between refreshes.
  let shownBadge = '';
  const applyBadge = (snapshot: UsageSnapshot | null) => {
    const ui = store.get('ui');
    const badge = snapshot ? pickBadge(snapshot.accounts, ui.trayBadge) : null;
    const tone = badge ? badgeTone(badge, ui.notificationThresholdPercent) : null;
    const key = badge && tone ? `${badgeText(badge.percent)}:${tone}` : '';
    if (key === shownBadge) return;
    shownBadge = key;
    if (process.platform === 'darwin') {
      tray.setTitle(badge ? `${badgeText(badge.percent)}%${badge.stale ? '*' : ''}` : '');
      return;
    }
    if (!badge || !tone) {
      tray.setImage(baseIcon);
      return;
    }
    // Electron wants BGRA; the renderer draws RGBA.
    const rgba = renderBadge(badge.percent, tone);
    const bgra = Buffer.alloc(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      bgra[i] = rgba[i + 2] ?? 0;
      bgra[i + 1] = rgba[i + 1] ?? 0;
      bgra[i + 2] = rgba[i] ?? 0;
      bgra[i + 3] = rgba[i + 3] ?? 0;
    }
    tray.setImage(nativeImage.createFromBitmap(bgra, { width: BADGE_SIZE, height: BADGE_SIZE }));
  };

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

  return {
    tray,
    refreshMenu: () => { tray.setContextMenu(buildMenu()); },
    updateUsage: (snapshot) => {
      tray.setToolTip(trayTooltip(snapshot.accounts));
      applyBadge(snapshot);
    },
  };
}
