import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
import { createRequire } from 'node:module';
import { DEFAULTS } from '../store/defaults';
import { defaultAccountFor } from '../store/migrate';
import { badgeEntries, pickBadge } from './trayBadge';
import type { CreateTrayDeps, TrayHandle } from './tray';
import type { AccountSnapshot, TrayBadgeChoice, TrayViewState, UsageSnapshot } from '../types/index';

const filename = path.join(__dirname, 'tray.js');
const source = new Script(readFileSync(filename, 'utf8'), { filename });
const realRequire = createRequire(filename);

type MenuEntry = { type?: string; checked?: boolean; enabled?: boolean; click?: () => void };

function harness(platform: NodeJS.Platform = 'linux') {
  const settings = structuredClone(DEFAULTS);
  settings.ui.animations = false;
  const quota = { id: 'weekly', label: 'Weekly', periodType: 'rolling-days' as const, periodLength: 7,
    used: 25, total: 100, unit: 'percentage' as const, resetsAt: null };
  const account = (id: string, used: number) => ({ accountId: id, criticalWindow: { ...quota, used }, quotaWindows: [{ ...quota, used }] });
  // Only tray-facing fields are read; the core's computed pacing metrics are irrelevant here.
  const snapshot: UsageSnapshot = { generatedAt: '2026-10-22T12:00:00Z', accounts: [account('a', 25), account('b', 95)] as AccountSnapshot[] };
  const registry = ['a', 'b'].map(id => ({ ...defaultAccountFor('claude', id), enabled: true, quotaWindows: [quota] }));
  settings.ui.trayBadge.view = { mode: 'manual', accountId: 'a', windowId: 'weekly' };
  let timer: (() => void) | null = null;
  let started = 0;
  let stopped = 0;
  const images: Uint8Array[] = [];
  const titles: string[] = [];
  let menu: MenuEntry[] = [];
  const app = new EventEmitter();
  class FakeTray extends EventEmitter {
    isDestroyed(): boolean { return false; }
    setToolTip(): void { /* No native shell in this test. */ }
    setTitle(title: string): void { titles.push(title); }
    setImage(pixels: Uint8Array): void { images.push(pixels); }
    setContextMenu(entries: MenuEntry[]): void { menu = entries; }
  }
  const exports: { createTray?: (deps: CreateTrayDeps) => TrayHandle } = {};
  source.runInNewContext({
    exports, __dirname, Buffer, process: { platform },
    require: (name: string): unknown => name === 'electron' ? {
      Tray: FakeTray, app, Menu: { buildFromTemplate: (entries: MenuEntry[]) => entries },
      nativeImage: { createFromPath: () => ({ isEmpty: () => false }), createFromBitmap: (pixels: Uint8Array) => pixels },
    } : realRequire(name),
    setInterval: (callback: () => void, ms: number) => { assert.equal(ms, 2000); timer = callback; started++; return started; },
    clearInterval: () => { timer = null; stopped++; },
  });
  const state = (): TrayViewState => ({ selection: settings.ui.trayBadge,
    shown: pickBadge(snapshot.accounts, settings.ui.trayBadge, 'a')?.view ?? null,
    entries: badgeEntries(registry, snapshot.accounts, settings.ui.trayBadge.view) });
  assert.ok(exports.createTray);
  const handle = exports.createTray({ store: { get: (key: keyof typeof settings) => settings[key] } as CreateTrayDeps['store'],
    getMainWindow: () => null, openSettings: () => undefined, refreshNow: () => undefined,
    getViewState: state, selectView: (view: TrayBadgeChoice) => { settings.ui.trayBadge.view = view; handle.refreshMenu(); } });
  return { settings, snapshot, images, titles, handle, registry, app,
    menu: () => menu, tick: () => { assert.ok(timer); timer(); }, started: () => started, stopped: () => stopped };
}

test('tray alternates every 2s even with animations off and stops on Critical off, Off and quit', () => {
  const h = harness();
  h.handle.updateUsage(h.snapshot);
  assert.equal(h.started(), 1);
  h.tick();
  assert.notDeepEqual(h.images[0], h.images[1]);
  h.tick();
  assert.deepEqual(h.images[0], h.images[2]);
  h.settings.ui.trayBadge.critical = false;
  h.handle.refreshMenu();
  assert.equal(h.stopped(), 1);
  h.settings.ui.trayBadge.critical = true;
  h.handle.refreshMenu();
  assert.equal(h.started(), 2);
  h.settings.ui.trayBadge.view = { mode: 'off' };
  h.handle.refreshMenu();
  assert.equal(h.stopped(), 2);
  h.settings.ui.trayBadge.view = { mode: 'auto' };
  h.handle.refreshMenu();
  h.app.emit('before-quit');
  assert.equal(h.stopped(), 3);
});

test('tray stops the alert when usage falls below threshold and rebuilds a checked disabled choice', () => {
  const h = harness();
  h.handle.updateUsage(h.snapshot);
  h.snapshot.accounts = h.snapshot.accounts.slice(0, 1);
  h.registry[0] = { ...h.registry[0]!, enabled: false };
  h.handle.updateUsage(h.snapshot);
  assert.equal(h.stopped(), 1);
  const radios = h.menu().filter(entry => entry.type === 'radio');
  assert.equal(radios.filter(entry => entry.checked).length, 1);
  assert.equal(radios.find(entry => entry.checked)?.enabled, false);
  radios[1]?.click?.();
  assert.equal(h.settings.ui.trayBadge.view.mode, 'auto');
});


test('macOS title keeps the alert marker even at 100 percent', () => {
  const h = harness('darwin');
  h.handle.updateUsage(h.snapshot);
  assert.equal(h.titles.at(-1), '25%');
  h.tick();
  assert.equal(h.titles.at(-1), '!95%');
  const other = h.snapshot.accounts[1];
  assert.ok(other);
  const win = other.quotaWindows[0];
  assert.ok(win);
  win.used = 100;
  h.handle.updateUsage(h.snapshot);
  assert.equal(h.titles.at(-1), '!100%');
  h.app.emit('before-quit');
});
