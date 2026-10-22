import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import type { TrayViewState, UsageView } from '../types/index';

// Exercise the actual panel selection wiring without a browser or Electron.
const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.js'), 'utf8');
const functions = ['panelView', 'applyView', 'choosePanelView', 'selectAccount', 'selectWindowSnapshot'].map(name => {
  const body = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(body, `${name} must exist in the built renderer`);
  return body;
}).join('\n');

const a = { accountId: 'a', criticalWindow: { id: 'weekly' }, windows: [{ window: { id: '5h' } }, { window: { id: 'weekly' } }] };
const b = { ...a, accountId: 'b' };
const view = (mode: 'auto' | 'manual', shown: UsageView): TrayViewState => ({
  selection: { view: mode === 'auto' ? { mode } : { mode, ...shown }, critical: true }, shown, entries: [],
});

test('Auto keeps panel browsing local; Manual follows the main view and its fallback', () => {
  const local = { accountId: 'a', windowId: '5h' };
  const state = { view: view('auto', { accountId: 'b', windowId: 'weekly' }), localView: local,
    latestSnapshot: { accounts: [a, b] } };
  const applyView = new Script(`${functions}\napplyView`).runInNewContext({ state, renderSnapshot: () => undefined }) as (updated: TrayViewState) => void;
  applyView(view('auto', { accountId: 'b', windowId: '5h' }));
  assert.deepEqual(state.localView, local);
  const manual = view('manual', { accountId: 'b', windowId: 'weekly' });
  applyView(manual);
  const fallback = { ...manual, shown: local };
  applyView(fallback);
  assert.equal(state.view.shown, local);
  assert.equal(state.view.selection.view.mode, 'manual');
  applyView(manual);
  applyView(view('auto', local));
  assert.deepEqual({ ...state.localView }, { accountId: 'b', windowId: 'weekly' });
  applyView(view('auto', local));
  assert.deepEqual({ ...state.localView }, { accountId: 'b', windowId: 'weekly' });
});

test('an account tab uses that account critical window instead of another account window id', () => {
  const state = { view: view('manual', { accountId: 'a', windowId: '5h' }), localView: null };
  const select = new Script(`${functions}\nselectWindowSnapshot`).runInNewContext({ state }) as (account: typeof a) => (typeof a.windows)[number];
  assert.equal(select(a).window.id, '5h');
  assert.equal(select(b).window.id, 'weekly');
});

test('a panel click with the badge Off browses locally and leaves the badge Off', () => {
  const off: TrayViewState = { selection: { view: { mode: 'off' }, critical: true }, shown: null, entries: [] };
  const sent: unknown[] = [];
  const state = { view: off, localView: null as UsageView | null, latestSnapshot: { accounts: [a, b] } };
  const context = { state, renderSnapshot: () => undefined, runGuarded: () => undefined,
    window: { hypermiler: { setView: (choice: unknown) => { sent.push(choice); } } } };
  const choose = new Script(`${functions}\nchoosePanelView`).runInNewContext(context) as (view: UsageView) => void;
  choose({ accountId: 'b', windowId: '5h' });
  assert.deepEqual(sent, []);
  assert.deepEqual({ ...state.localView }, { accountId: 'b', windowId: '5h' });
  state.view = { ...off, selection: { view: { mode: 'auto' }, critical: true } };
  choose({ accountId: 'a', windowId: 'weekly' });
  assert.deepEqual(sent.map(c => ({ ...(c as object) })), [{ mode: 'manual', accountId: 'a', windowId: 'weekly' }]);
});
