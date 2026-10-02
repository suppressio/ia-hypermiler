// services/claudeLocalSessions.worker.ts — entry point of the Electron utility process
// that computes the local Claude Code insights (main.ts, computeLocalInsightsInProcess).
// Reading and parsing up to MAX_SESSIONS_SCANNED session files is CPU work: on the main
// process it froze the app for ~10 s at startup on a machine with long sessions (the
// Settings window stayed blank). Here it runs in its own process.
// Protocol: one request { windowDays }, one reply { ok: true, result } or
// { ok: false, message }; the main process then kills this process.

import { computeClaudeLocalInsights } from './claudeLocalSessions';

process.parentPort.once('message', (event) => {
  const data: unknown = event.data;
  const windowDays = typeof data === 'object' && data !== null && 'windowDays' in data && typeof data.windowDays === 'number'
    ? data.windowDays
    : null;
  if (windowDays === null) {
    process.parentPort.postMessage({ ok: false, message: 'invalid request' });
    return;
  }
  computeClaudeLocalInsights(windowDays).then(
    (result) => { process.parentPort.postMessage({ ok: true, result }); },
    (err: unknown) => { process.parentPort.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) }); },
  );
});
