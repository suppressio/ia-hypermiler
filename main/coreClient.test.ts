// main/coreClient.test.ts — the core CLI client against the shared contract fixtures
// (gocore/contract/v1/, the same files the Go tests reproduce byte for byte), plus the
// real execFile runner with a Node script standing in for the binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CoreBinaryError,
  CoreOutputError,
  CoreProviderError,
  CoreTimeoutError,
  createCoreClient,
  execFileRunner,
  parseUsageRun,
  parseVersionRun,
  resolveCoreBinary,
  type CoreRun,
  type CoreRunner,
} from './coreClient';
import { FormatDriftError } from '../services/_shape';

// Compiled test: dist/main/ → project root two levels up.
const FIXTURES = path.join(__dirname, '..', '..', 'gocore', 'contract', 'v1');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8');
const runOf = (name: string, exitCode: number): CoreRun => ({ exitCode, stdout: fixture(name) });

test('every shared fixture is read by this client (none left untested)', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, [
    'error-format-drift.json', 'error-not-ready.json', 'error-signed-out.json', 'error-timeout.json',
    'error-unavailable.json', 'error-usage.json', 'usage-count-window.json', 'usage-ok.json', 'usage-stale.json', 'version.json',
  ]);
});

test('usage-ok: RawAccountUsage with ISO strings, every window field', () => {
  const result = parseUsageRun(runOf('usage-ok', 0), 'fake');
  assert.equal(result.stale, false);
  assert.equal(result.staleReason, null);
  assert.equal(result.fetchedAt, '2026-10-31T21:10:00Z');
  assert.deepEqual(result.usage, {
    planTier: 'plus',
    subscriptionRenewsAt: null,
    quotaWindows: [
      { id: 'five-hour', label: '5 hours', periodType: 'rolling-hours', periodLength: 5, unit: 'percentage', used: 21, total: 100, resetsAt: '2026-10-31T22:10:00Z' },
      { id: 'weekly', label: '7 days', periodType: 'rolling-days', periodLength: 7, unit: 'percentage', used: 42, total: 100, resetsAt: '2026-11-07T21:10:00Z' },
    ],
  });
});

test('usage-count-window: billing-cycle count window and renewal date', () => {
  const { usage } = parseUsageRun(runOf('usage-count-window', 0), 'fake');
  assert.equal(usage.planTier, null);
  assert.equal(usage.subscriptionRenewsAt, '2026-11-30T21:10:00Z');
  assert.deepEqual(usage.quotaWindows.map((w) => [w.id, w.periodType, w.periodLength, w.unit, w.used, w.total]), [['credits', 'billing-cycle', 1, 'count', 250, 1000]]);
});

test('usage-stale: exit 0 with the stale mark and its reason', () => {
  const result = parseUsageRun(runOf('usage-stale', 0), 'fake');
  assert.equal(result.stale, true);
  assert.deepEqual(result.staleReason, { code: 'unavailable', message: 'Provider is temporarily unavailable' });
  assert.equal(result.usage.quotaWindows.length, 2);
});

for (const [name, code] of [
  ['error-signed-out', 'signed_out'],
  ['error-not-ready', 'not_ready'],
  ['error-timeout', 'timeout'],
  ['error-unavailable', 'unavailable'],
] as const) {
  test(`${name}: exit 1 → CoreProviderError ${code}`, () => {
    assert.throws(() => parseUsageRun(runOf(name, 1), 'fake'), (err: unknown) => err instanceof CoreProviderError && err.code === code);
  });
}

test('error-format-drift: becomes the FormatDriftError of the TypeScript services (shape only)', () => {
  assert.throws(() => parseUsageRun(runOf('error-format-drift', 1), 'fake'), (err: unknown) => {
    assert.ok(err instanceof FormatDriftError);
    assert.equal(err.endpointLabel, '/usage');
    assert.deepEqual(err.shape, { active: 'boolean', items: [{ remaining: 'number' }], label: 'string', reset: 'null' });
    return true;
  });
});

test('error-usage: exit 2 is a bug in our arguments, reported with the core message', () => {
  assert.throws(() => parseUsageRun(runOf('error-usage', 2), 'fake'), (err: unknown) => err instanceof CoreOutputError && /rejected the arguments: Unknown provider: nope/.test(err.message));
});

test('version.json: name, version, os, arch', () => {
  assert.deepEqual(parseVersionRun(runOf('version', 0)), { name: 'hypermiler', version: 'dev', os: 'linux', arch: 'amd64' });
  assert.throws(() => parseVersionRun({ exitCode: 2, stdout: fixture('error-usage') }), CoreOutputError);
});

test('documents that contradict the exit code, the provider or the schema are CoreOutputError', () => {
  const cases: CoreRun[] = [
    { exitCode: 0, stdout: fixture('error-unavailable') },
    { exitCode: 1, stdout: fixture('usage-ok') },
    { exitCode: 3, stdout: fixture('usage-ok') },
    { exitCode: 0, stdout: fixture('usage-ok').replace('"schemaVersion":1', '"schemaVersion":2') },
    { exitCode: 0, stdout: 'Codex · 5h 21%\n' },
    { exitCode: 0, stdout: '[]' },
    { exitCode: 0, stdout: fixture('usage-ok').replace('"stale":false', '"stale":true') },
    { exitCode: 0, stdout: fixture('usage-ok').replace('"periodType":"rolling-hours"', '"periodType":"hourly"') },
    { exitCode: 0, stdout: fixture('usage-ok').replace('"used":21', '"used":"21"') },
    { exitCode: 0, stdout: fixture('usage-ok').replace('"quotaWindows":[', '"quotaWindows":null,"x":[') },
  ];
  for (const run of cases) assert.throws(() => parseUsageRun(run, 'fake'), CoreOutputError, run.stdout);
  assert.throws(() => parseUsageRun(runOf('usage-ok', 0), 'codex'), /another provider/);
});

test('an output that is not JSON never reaches the error message (it could hold provider data)', () => {
  assert.throws(() => parseUsageRun({ exitCode: 0, stdout: '{"secret-ish": 42' }, 'fake'), (err: unknown) => err instanceof CoreOutputError && !err.message.includes('secret-ish'));
});

test('an unknown error or stale code is read as unavailable (versioning rule)', () => {
  const unknownError = fixture('error-unavailable').replace('"code":"unavailable"', '"code":"quota_paused"');
  assert.throws(() => parseUsageRun({ exitCode: 1, stdout: unknownError }, 'fake'), (err: unknown) => err instanceof CoreProviderError && err.code === 'unavailable');
  const unknownStale = fixture('usage-stale').replace('"code":"unavailable"', '"code":"quota_paused"');
  assert.equal(parseUsageRun({ exitCode: 0, stdout: unknownStale }, 'fake').staleReason?.code, 'unavailable');
});

test('additive fields are ignored (versioning rule)', () => {
  const extended = fixture('usage-ok').replace('"stale":false', '"stale":false,"futureField":{"a":1}');
  assert.equal(parseUsageRun({ exitCode: 0, stdout: extended }, 'fake').usage.quotaWindows.length, 2);
});

function recordingRunner(result: CoreRun): { runner: CoreRunner; calls: { binary: string; args: string[]; stdin: string | null; timeoutMs: number }[] } {
  const calls: { binary: string; args: string[]; stdin: string | null; timeoutMs: number }[] = [];
  return {
    calls,
    runner: (binary, args, stdin, timeoutMs) => {
      calls.push({ binary, args, stdin, timeoutMs });
      return Promise.resolve(result);
    },
  };
}

test('usage(): --json, the core deadline and the provider flags; a secret only on stdin', async () => {
  const ok = { exitCode: 0, stdout: fixture('usage-ok') };
  const plain = recordingRunner(ok);
  await createCoreClient({ binary: () => '/opt/core/hypermiler', run: plain.runner }).usage({ provider: 'fake', flags: ['--host', 'github.com'] });
  assert.deepEqual(plain.calls, [{ binary: '/opt/core/hypermiler', args: ['usage', 'fake', '--json', '--timeout', '25s', '--host', 'github.com'], stdin: null, timeoutMs: 30000 }]);

  const withSecret = recordingRunner(ok);
  await createCoreClient({ binary: () => '/opt/core/hypermiler', run: withSecret.runner }).usage({ provider: 'fake', flags: [], secret: 'synthetic-token-value' });
  const call = withSecret.calls[0];
  assert.ok(call);
  assert.equal(call.stdin, 'synthetic-token-value');
  assert.equal(call.args.at(-1), '--secret-stdin');
  assert.ok(!call.args.some((arg) => arg.includes('synthetic-token-value')), 'the secret never goes in argv');
});

test('version(): `version --json` with a short timeout', async () => {
  const rec = recordingRunner({ exitCode: 0, stdout: fixture('version') });
  const version = await createCoreClient({ binary: () => 'core', run: rec.runner }).version();
  assert.equal(version.version, 'dev');
  assert.deepEqual(rec.calls.map((c) => [c.args, c.timeoutMs]), [[['version', '--json'], 5000]]);
});

test('a binary that cannot be resolved fails that call, not the client', async () => {
  const client = createCoreClient({ binary: () => { throw new CoreBinaryError('HYPERMILER_CORE_BIN must be an absolute path'); } });
  await assert.rejects(client.version(), CoreBinaryError);
});

test('resolveCoreBinary: override, packaged resources, development core-bin', () => {
  const base = { env: {}, isPackaged: false, resourcesPath: path.join(path.sep, 'app', 'resources'), appPath: path.join(path.sep, 'repo'), platform: 'linux' as const };
  assert.equal(resolveCoreBinary(base), path.join(path.sep, 'repo', 'core-bin', 'hypermiler'));
  assert.equal(resolveCoreBinary({ ...base, isPackaged: true }), path.join(path.sep, 'app', 'resources', 'core', 'hypermiler'));
  assert.equal(resolveCoreBinary({ ...base, isPackaged: true, platform: 'win32' }), path.join(path.sep, 'app', 'resources', 'core', 'hypermiler.exe'));
  const override = path.resolve('custom', 'hypermiler');
  assert.equal(resolveCoreBinary({ ...base, isPackaged: true, env: { HYPERMILER_CORE_BIN: override } }), override);
  assert.throws(() => resolveCoreBinary({ ...base, env: { HYPERMILER_CORE_BIN: 'relative/hypermiler' } }), CoreBinaryError);
});

// The real runner, with Node itself as the "binary" (cross-platform, no shell).
const node = process.execPath;

test('execFileRunner: stdout and exit code of a non-zero exit, stdin delivered and closed', async () => {
  const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({got:s}));process.exit(1)})";
  assert.deepEqual(await execFileRunner(node, ['-e', script], 'synthetic-secret', 10000), { exitCode: 1, stdout: '{"got":"synthetic-secret"}' });
  // Without a secret stdin is still closed: a binary that reads it does not hang.
  assert.deepEqual(await execFileRunner(node, ['-e', script], null, 10000), { exitCode: 1, stdout: '{"got":""}' });
});

test('execFileRunner: missing binary → CoreBinaryError, no answer in time → CoreTimeoutError', async () => {
  await assert.rejects(execFileRunner(path.join(__dirname, 'no-such-core-binary'), [], null, 10000), CoreBinaryError);
  await assert.rejects(execFileRunner(node, ['-e', 'setTimeout(()=>{},10000)'], null, 300), CoreTimeoutError);
});

test('execFileRunner: an output over the size limit is refused', async () => {
  await assert.rejects(execFileRunner(node, ['-e', "process.stdout.write('x'.repeat(2*1024*1024))"], null, 10000), CoreOutputError);
});
