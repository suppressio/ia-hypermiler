// diagnostics/logBuffer.ts — the last main-process errors and warnings, kept in memory
// only (never written to disk) for the manual diagnostic report (diagnostics/report.ts):
// an installed app has no visible console. Messages are shortened like report errors
// (githubIssue.shortError: no response bodies); the report also replaces account
// labels and ids with neutral names before writing them.

import { shortError } from './githubIssue';

export interface LogEntry {
  time: string;
  level: 'error' | 'warn';
  message: string;
}

const MAX_MESSAGE_LENGTH = 300;

export class LogBuffer {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly limit: number) {}

  push(level: LogEntry['level'], args: unknown[], now: Date = new Date()): void {
    const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
    this.entries.push({ time: now.toISOString(), level, message: shortError(text, MAX_MESSAGE_LENGTH) });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  list(): LogEntry[] {
    return [...this.entries];
  }
}

function safeJson(value: unknown): string {
  try {
    // undefined for undefined/functions, despite the declared return type.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/** Copies every console.error/console.warn of this process into `buffer` (still printed). */
export function captureConsole(buffer: LogBuffer): void {
  const { error, warn } = console;
  console.error = (...args: unknown[]) => { buffer.push('error', args); error(...args); };
  console.warn = (...args: unknown[]) => { buffer.push('warn', args); warn(...args); };
}
