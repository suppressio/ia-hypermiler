// main/tray.ts — system tray cross-platform (vedi ARCHITECTURE.md §4)

import { Tray, Menu, nativeImage, app, BrowserWindow, MenuItem } from 'electron';
import path from 'path';
import type Store from 'electron-store';
import type { AppSettings } from '../types/index';

const ICON_PATH = path.join(__dirname, '..', 'renderer', 'assets', 'tray-icon.png');

export interface CreateTrayDeps {
  getMainWindow: () => BrowserWindow | null;
  openSettings: () => void;
  refreshNow: () => void;
  store: Store<AppSettings>;
}

/** Crea l'icona di tray con menu contestuale. */
export function createTray({ getMainWindow, openSettings, refreshNow, store }: CreateTrayDeps): Tray {
  // Se l'icona custom non esiste ancora (asset da fornire in Sessione 2 avanzata),
  // usiamo un'icona vuota di fallback: Electron non crasha, ma va sostituita
  // prima della build finale con un asset reale multi-piattaforma.
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
    return Menu.buildFromTemplate([
      { label: 'Mostra/Nascondi', click: toggleMainWindow },
      { label: 'Impostazioni…', click: openSettings },
      { label: 'Aggiorna ora', click: refreshNow },
      { type: 'separator' },
      {
        label: 'Sempre in primo piano',
        type: 'checkbox',
        checked: !!ui.alwaysOnTop,
        click: (menuItem: MenuItem) => {
          store.set('ui.alwaysOnTop', menuItem.checked);
          const win = getMainWindow();
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(menuItem.checked, 'floating');
        },
      },
      { type: 'separator' },
      { label: 'Esci', click: () => app.quit() },
    ]);
  };

  tray.setContextMenu(buildMenu());

  // Click sinistro: toggle su Windows/Linux. Su macOS il click sinistro apre
  // di norma il menu nativo del tray: la voce "Mostra/Nascondi" nel menu copre
  // comunque il caso, garantendo un comportamento uniforme su tutte le piattaforme.
  tray.on('click', toggleMainWindow);

  return tray;
}
