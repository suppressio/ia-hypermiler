// main/coreClient.ts — the Electron side of the Go core CLI (#177, approach on #176).
// For each read the main process runs the bundled `hypermiler` binary with execFile
// (no shell, no console window on Windows), `--json` and a timeout, and parses one
// document of contract v1 (docs/CORE-CLI.md). Secrets go on stdin, never in argv:
// the argument list is visible in the process list. No port and no lifecycle: the
// core is not a child that lives with the app, it runs and exits.
//
// The parser is checked against the language-neutral fixtures in gocore/contract/v1/,
// the same files the Go tests reproduce byte for byte (coreClient.test.ts).

import { execFile } from 'node:child_process';
import path from 'node:path';
import { FormatDriftError } from '../services/_shape';
import type { QuotaWindow, RawAccountUsage } from '../types/index';

/** Contract version this client understands (docs/CORE-CLI.md, "Versioning"). */
export const CORE_SCHEMA_VERSION = 1;
// The core's own deadline for a fetch, and the client's: a little longer, so that the
// core answers with its `timeout` document before the client has to kill it.
export const CORE_FETCH_TIMEOUT_SECONDS = 25;
const CLIENT_TIMEOUT_MS = (CORE_FETCH_TIMEOUT_SECONDS + 5) * 1000;
const VERSION_TIMEOUT_MS = 5000;
// One document is a few KB; anything this large is not a contract document.
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type CoreErrorCode = 'signed_out' | 'not_ready' | 'timeout' | 'format_drift' | 'unavailable';
const ERROR_CODES: readonly CoreErrorCode[] = ['signed_out', 'not_ready', 'timeout', 'format_drift', 'unavailable'];

/** The core binary is missing or cannot be started (not installed, wrong path, not executable). */
export class CoreBinaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CoreBinaryError';
  }
}

/** The core did not exit within the client timeout and was killed. */
export class CoreTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreTimeoutError';
  }
}

/**
 * The core answered something that is not a valid v1 document, or a document that
 * does not match its exit code, or a usage error (exit 2: a bug in the arguments this
 * client built). Never shown with the raw output, which could hold provider data.
 */
export class CoreOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreOutputError';
  }
}

/** A provider error reported by the core with one of the stable codes. */
export class CoreProviderError extends Error {
  readonly code: CoreErrorCode;
  // The provider id the core answered for: the same code reads differently per provider
  // (signed_out is "sign in with Codex" for Codex).
  readonly provider: string;

  constructor(code: CoreErrorCode, message: string, provider: string) {
    super(message);
    this.name = 'CoreProviderError';
    this.code = code;
    this.provider = provider;
  }
}

export interface CoreStaleReason {
  code: CoreErrorCode;
  message: string;
}

/** A successful usage document: the provider data, with the stale mark when it gave last known values. */
export interface CoreUsageResult {
  usage: RawAccountUsage;
  fetchedAt: string;
  stale: boolean;
  staleReason: CoreStaleReason | null;
}

export interface CoreVersion {
  name: string;
  version: string;
  os: string;
  arch: string;
}

// ---------------------------------------------------------------------------
// Binary location
// ---------------------------------------------------------------------------

export function coreBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'hypermiler.exe' : 'hypermiler';
}

export interface CoreBinaryLocation {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  // process.resourcesPath: electron-builder `extraResources` put the binary in <resources>/core/.
  resourcesPath: string;
  // app.getAppPath(): the repository root in development, where scripts/build-core.js writes core-bin/.
  appPath: string;
  platform: NodeJS.Platform;
}

/**
 * HYPERMILER_CORE_BIN (absolute) wins, for development against a core built elsewhere;
 * otherwise the packaged copy, or core-bin/ of the repository in development.
 */
export function resolveCoreBinary(location: CoreBinaryLocation): string {
  const override = location.env.HYPERMILER_CORE_BIN?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new CoreBinaryError('HYPERMILER_CORE_BIN must be an absolute path');
    return override;
  }
  const name = coreBinaryName(location.platform);
  return location.isPackaged
    ? path.join(location.resourcesPath, 'core', name)
    : path.join(location.appPath, 'core-bin', name);
}

// ---------------------------------------------------------------------------
// Running the binary
// ---------------------------------------------------------------------------

export interface CoreRun {
  exitCode: number;
  stdout: string;
}

export type CoreRunner = (binary: string, args: string[], stdin: string | null, timeoutMs: number) => Promise<CoreRun>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * execFile without a shell. stdin is always closed (with the secret written first when
 * there is one), so the core never waits on it. A non-zero exit is a normal result here:
 * the document on stdout says what happened.
 */
export const execFileRunner: CoreRunner = (binary, args, stdin, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile(binary, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    }, (error, stdout) => {
      if (!error) {
        resolve({ exitCode: 0, stdout });
        return;
      }
      const details = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: unknown };
      if (typeof details.code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'UNKNOWN'].includes(details.code)) {
        reject(new CoreBinaryError(`Core binary cannot be started (${details.code})`, { cause: error }));
        return;
      }
      if (details.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(new CoreOutputError('Core output exceeds the size limit'));
        return;
      }
      if (details.killed === true) {
        reject(new CoreTimeoutError(`Core did not answer within ${String(Math.round(timeoutMs / 1000))} s`));
        return;
      }
      if (typeof details.code === 'number') {
        resolve({ exitCode: details.code, stdout });
        return;
      }
      reject(new CoreOutputError(`Core ended abnormally${details.signal ? ` (${details.signal})` : ''}`));
    });
    // A failed spawn surfaces in the callback; the stream error (EPIPE) must not crash the app.
    child.stdin?.on('error', () => { /* reported by the callback */ });
    child.stdin?.end(stdin ?? '');
  });

// ---------------------------------------------------------------------------
// Parsing contract v1
// ---------------------------------------------------------------------------

function parseDocument(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // The parser message can quote the output: never forwarded.
    throw new CoreOutputError('Core output is not a JSON document');
  }
  if (!isRecord(parsed)) throw new CoreOutputError('Core output is not a JSON object');
  if (parsed.schemaVersion !== CORE_SCHEMA_VERSION) {
    throw new CoreOutputError(`Core document has an unsupported schema version (expected ${String(CORE_SCHEMA_VERSION)})`);
  }
  return parsed;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new CoreOutputError(`Core document: ${field} must be a string or null`);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new CoreOutputError(`Core document: ${field} must be a number or null`);
}

function parseWindow(value: unknown, index: number): QuotaWindow {
  const field = `usage.quotaWindows[${String(index)}]`;
  if (!isRecord(value)) throw new CoreOutputError(`Core document: ${field} must be an object`);
  const { id, label, periodType, unit, used } = value;
  if (typeof id !== 'string' || typeof label !== 'string') throw new CoreOutputError(`Core document: ${field} needs a string id and label`);
  if (periodType !== 'rolling-hours' && periodType !== 'rolling-days' && periodType !== 'billing-cycle') {
    throw new CoreOutputError(`Core document: ${field}.periodType is not a known period`);
  }
  if (unit !== 'percentage' && unit !== 'count') throw new CoreOutputError(`Core document: ${field}.unit is not a known unit`);
  if (typeof used !== 'number' || !Number.isFinite(used)) throw new CoreOutputError(`Core document: ${field}.used must be a number`);
  return {
    id,
    label,
    periodType,
    periodLength: nullableNumber(value.periodLength, `${field}.periodLength`),
    unit,
    used,
    total: nullableNumber(value.total, `${field}.total`),
    resetsAt: nullableString(value.resetsAt, `${field}.resetsAt`),
  };
}

function parseUsage(value: unknown): RawAccountUsage {
  if (!isRecord(value)) throw new CoreOutputError('Core document: usage must be an object');
  if (!Array.isArray(value.quotaWindows)) throw new CoreOutputError('Core document: usage.quotaWindows must be an array');
  return {
    planTier: nullableString(value.planTier, 'usage.planTier'),
    subscriptionRenewsAt: nullableString(value.subscriptionRenewsAt, 'usage.subscriptionRenewsAt'),
    quotaWindows: value.quotaWindows.map((w: unknown, i) => parseWindow(w, i)),
  };
}

// A client that sees an unknown error code treats it as `unavailable` (docs/CORE-CLI.md).
function errorCode(value: unknown): CoreErrorCode {
  return ERROR_CODES.find((code) => code === value) ?? 'unavailable';
}

function providerError(doc: Record<string, unknown>, provider: string): Error {
  const error = doc.error;
  if (!isRecord(error) || typeof error.message !== 'string') throw new CoreOutputError('Core document: error needs a code and a message');
  const code = errorCode(error.code);
  if (code === 'format_drift') {
    // Same path as a TypeScript service's drift: main.ts opens the report draft (shape only).
    return new FormatDriftError(error.message, typeof error.endpoint === 'string' ? error.endpoint : 'core', error.shape ?? null);
  }
  return new CoreProviderError(code, error.message, provider);
}

/**
 * Reads the result of `hypermiler usage <provider> --json`: the usage on exit 0, the
 * provider error (thrown) on exit 1. Anything else — a usage error (exit 2), a document
 * that contradicts its exit code, an unknown exit code — is a CoreOutputError.
 */
export function parseUsageRun(run: CoreRun, provider: string): CoreUsageResult {
  const doc = parseDocument(run.stdout);
  if (run.exitCode === 2) {
    const message = isRecord(doc.error) && typeof doc.error.message === 'string' ? `: ${doc.error.message}` : '';
    throw new CoreOutputError(`Core rejected the arguments${message}`);
  }
  if (doc.provider !== provider) throw new CoreOutputError(`Core document is for another provider (expected ${provider})`);
  if (run.exitCode === 1 && 'error' in doc) throw providerError(doc, provider);
  if (run.exitCode !== 0 || 'error' in doc) {
    throw new CoreOutputError(`Core exited with code ${String(run.exitCode)} without a matching document`);
  }
  if (typeof doc.fetchedAt !== 'string' || typeof doc.stale !== 'boolean') {
    throw new CoreOutputError('Core document: fetchedAt and stale are required');
  }
  let staleReason: CoreStaleReason | null = null;
  if (doc.stale) {
    const reason = doc.staleReason;
    if (!isRecord(reason) || typeof reason.message !== 'string') throw new CoreOutputError('Core document: a stale result needs a staleReason');
    staleReason = { code: errorCode(reason.code), message: reason.message };
  }
  return { usage: parseUsage(doc.usage), fetchedAt: doc.fetchedAt, stale: doc.stale, staleReason };
}

/**
 * The usage of a fresh result. A stale one (the provider gave last known values)
 * becomes the error of its reason: the app keeps and shows its own last data as stale
 * with that reason, the same path as a failed read, instead of storing old values as
 * a fresh sample.
 */
export function requireFresh(result: CoreUsageResult, provider: string): RawAccountUsage {
  if (!result.stale) return result.usage;
  const reason = result.staleReason ?? { code: 'unavailable', message: 'Core returned stale values' };
  throw new CoreProviderError(reason.code, reason.message, provider);
}

export function parseVersionRun(run: CoreRun): CoreVersion {
  if (run.exitCode !== 0) throw new CoreOutputError(`Core version check exited with code ${String(run.exitCode)}`);
  const doc = parseDocument(run.stdout);
  const { name, version, os, arch } = doc;
  if (typeof name !== 'string' || typeof version !== 'string' || typeof os !== 'string' || typeof arch !== 'string') {
    throw new CoreOutputError('Core version document is incomplete');
  }
  return { name, version, os, arch };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CoreUsageRequest {
  provider: string;
  // Account parameters as provider flags (e.g. ['--codex-bin', path]). Never secrets.
  flags: string[];
  // Written on stdin with --secret-stdin, only for providers that accept one.
  secret?: string;
}

export interface CoreClient {
  usage(request: CoreUsageRequest): Promise<CoreUsageResult>;
  version(): Promise<CoreVersion>;
}

export interface CoreClientOptions {
  // Resolved on every call: a missing binary is an error of that read, not of startup.
  binary: () => string;
  run?: CoreRunner;
  timeoutMs?: number;
}

export function createCoreClient(options: CoreClientOptions): CoreClient {
  const run = options.run ?? execFileRunner;
  const timeoutMs = options.timeoutMs ?? CLIENT_TIMEOUT_MS;
  return {
    async usage(request) {
      const args = ['usage', request.provider, '--json', '--timeout', `${String(CORE_FETCH_TIMEOUT_SECONDS)}s`, ...request.flags];
      const secret = request.secret ?? null;
      if (secret !== null) args.push('--secret-stdin');
      return parseUsageRun(await run(options.binary(), args, secret, timeoutMs), request.provider);
    },
    async version() {
      return parseVersionRun(await run(options.binary(), ['version', '--json'], null, Math.min(timeoutMs, VERSION_TIMEOUT_MS)));
    },
  };
}
