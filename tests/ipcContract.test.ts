// tests/ipcContract.test.ts — guards on the shared IPC contract (types/): the built files
// carry no runtime code, and every channel in the maps of types/ipc.ts is wired in main
// and in the preload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Compiled test: dist/tests/ → project root two levels up.
const ROOT = path.join(__dirname, '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('built dist/types/*.js hold no runtime code (the renderer build rewrites them as ES modules)', () => {
  const dir = path.join(ROOT, 'dist', 'types');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 2, 'expected the built types/index.js and types/ipc.js');
  for (const file of files) {
    const code = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'))
      .replace(/^\s*"use strict";\s*$/gm, '')
      .replace(/^\s*Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\s*$/gm, '')
      .replace(/^\s*export \{\};\s*$/gm, '')
      .replace(/^\s*\/\/# sourceMappingURL=.*$/gm, '')
      .trim();
    assert.equal(code, '', `dist/types/${file} must be types only, found: ${code}`);
  }
});

/** Keys of `interface <name> { 'a:b': …; … }` in types/ipc.ts, top level only. */
function channelKeys(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} `);
  assert.notEqual(start, -1, `${name} not found in types/ipc.ts`);
  const body = source.slice(start);
  const end = body.indexOf('\n}');
  const keys: string[] = [];
  // Every top-level member line must parse as a key, so a key written another way fails
  // here instead of silently dropping out of the checks below.
  for (const line of body.slice(0, end).split('\n').slice(1)) {
    // Skip deeper continuation lines, comments and the closers of a multiline member.
    if (!/^ {2}\S/.test(line) || /^ {2}(\/\/|\/\*|\*|[}\]])/.test(line)) continue;
    const m = /^ {2}(['"])([^'"]+)\1:/.exec(line);
    assert.ok(m?.[2] !== undefined, `${name}: cannot parse member line: ${line}`);
    keys.push(m[2]);
  }
  assert.ok(keys.length > 0, `${name} has no channels`);
  return keys;
}

test('channelKeys reads both quote styles and fails on a top-level member it cannot parse', () => {
  const src = "export interface M {\n  'a:b': [];\n  \"c:d\": [];\n  // note\n  'e:f': {\n    args: [];\n  };\n}\n";
  assert.deepEqual(channelKeys(src, 'M'), ['a:b', 'c:d', 'e:f']);
  assert.throws(() => channelKeys("export interface M {\n  'a:b': [];\n  `c:d`: [];\n}\n", 'M'), /cannot parse/);
});

function usedChannels(code: string, fn: string): Set<string> {
  return new Set([...code.matchAll(new RegExp(`\\b${fn}\\(\\s*(?:\\w+,\\s*)?'([^']+)'`, 'g'))].map((m) => m[1] ?? ''));
}

test('every channel of the IPC maps is wired in main and in the preload', () => {
  const contract = read('types', 'ipc.ts');
  const main = stripComments(read('main.ts'));
  const preload = stripComments(read('preload.ts'));

  const invoke = channelKeys(contract, 'IpcInvokeChannels');
  const send = channelKeys(contract, 'IpcSendChannels');
  const events = channelKeys(contract, 'IpcEventChannels');
  assert.ok(events.includes('usage:refreshing'), 'refresh lifecycle must be exposed to the widget');

  const handled = usedChannels(main, 'handle');
  const listened = usedChannels(main, 'listen');
  const emitted = usedChannels(main, 'sendToRenderer');
  const invoked = usedChannels(preload, 'invoke');
  const sent = usedChannels(preload, 'send');
  const subscribed = usedChannels(preload, 'subscribe');

  for (const c of invoke) {
    assert.ok(handled.has(c), `invoke channel ${c} has no handle() in main.ts`);
    assert.ok(invoked.has(c), `invoke channel ${c} has no bridge method in preload.ts`);
  }
  for (const c of send) {
    assert.ok(listened.has(c), `send channel ${c} has no listen() in main.ts`);
    assert.ok(sent.has(c), `send channel ${c} has no bridge method in preload.ts`);
  }
  for (const c of events) {
    assert.ok(emitted.has(c), `event channel ${c} is never sent by main.ts`);
    assert.ok(subscribed.has(c), `event channel ${c} has no subscription in preload.ts`);
  }
});
