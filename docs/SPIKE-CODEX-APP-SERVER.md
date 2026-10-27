🌐 **English** | [Italiano](SPIKE-CODEX-APP-SERVER.it.md)

# Spike #142 — Codex quotas from `codex app-server` (`account/rateLimits/read`)

> Part of #139. Status: **done on Linux, go as the Codex source for the Go core.** Windows and macOS binary discovery, and a login made only from the IDE extension, are still untested.

## Setup

2026-10-27, Linux (Debian testing, ARM64), `codex-cli 0.163.0` installed through npm (`/usr/bin/codex` → `@openai/codex/bin/codex.js`), ChatGPT Plus login made with the CLI. Prototype: `scripts/spikes/codex-rate-limits.js` (Node, no dependencies). The exact shapes below come from the schema the binary itself generates: `codex app-server generate-json-schema --out <dir>` (same source as openai/codex `codex-rs/app-server-protocol`), then checked against real responses. No `generate-ts` output is needed by the app.

## Protocol

- `codex app-server` speaks JSON-RPC 2.0 **as one JSON object per line over stdio** (default transport `stdio://`; `unix://`, `ws://` also exist, not needed). The `"jsonrpc":"2.0"` member can be left out: it is accepted without.
- Handshake, in this order:
  1. request `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"…","title":null,"version":"…"}}}` → result with server info;
  2. notification `{"method":"initialized"}`.
- Requests that matter:
  - `account/read` `{"refreshToken":false}` → `{account: {type:"chatgpt", email, planType} | {type:"apiKey"} | null, requiresOpenaiAuth, workspaceRouting}`. Use it to tell "not signed in" from "signed in with an API key" (an API key has no subscription quota).
  - `account/rateLimits/read`, `params: null` (or `{excludeResetCreditDetails: true}` for background polling) → `GetAccountRateLimitsResponse`.
- `GetAccountRateLimitsResponse` (only `rateLimits` is required):
  - `rateLimits`: the historical single bucket. `rateLimitsByLimitId`: the same, keyed by metered `limit_id` (`codex` here), possibly more buckets on other plans/models.
  - bucket (`RateLimitSnapshot`): `limitId`, `limitName`, `planType`, `primary`, `secondary` (windows or `null`), `credits` (`hasCredits`, `unlimited`, `balance` as **string**), `individualLimit` / `spendControlReached` (spend control of business workspaces), `rateLimitReachedType`, `normalModelSlug`.
  - window (`RateLimitWindow`): `usedPercent` (int, consumed 0-100, required), `windowDurationMins` (int or null), `resetsAt` (Unix **seconds**, int or null). Seen on Plus: primary 300 min / secondary 10080 min, i.e. the same 5 h and weekly windows as today. Like today, identify a window by its duration, never by the field name (a weekly-only plan may put it in `primary`).
  - also: `ordinaryUsageAllowed`, `accountId`, `rateLimitResetCredits` (`availableCount`, optional detail rows), `rateLimitUpsell`.
- Errors: signed out → JSON-RPC error `-32600 "codex account authentication required to read rate limits"` (checked with an empty `CODEX_HOME`). Binary not found → spawn `ENOENT`.

## Results

| Question | Answer |
|---|---|
| Works with the login the user already has? | Yes. The app-server reads the same `CODEX_HOME` (`~/.codex`) as the CLI and refreshes the token itself. We never open `auth.json` and store nothing (the prototype does not read it either). |
| Login made only from the IDE extension? | **Not tested** (no extension here). By design the extension runs this same app-server on the same `CODEX_HOME`, so the login is shared; if the extension keeps its own `codex` binary inside its folder, it is not on `PATH`, so discovery must also look there. To verify on a machine with only the extension. If Codex is configured to keep credentials in the OS keyring instead of `auth.json` (from memory, not checked here), the app-server would read them itself: another reason not to parse `auth.json`. |
| Binary discovery | `PATH` lookup of `codex` (`codex.cmd` shim on Windows when installed by npm; spawn with `shell: true` there, or resolve the `.cmd`/`.exe`). Fallbacks to try, none tested yet: user setting with an explicit path; npm global prefix; Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`); the IDE extension's bundled binary (location from memory, e.g. `~/.vscode/extensions/openai.chatgpt-*/bin/<platform>/codex`: check it). Windows/macOS: untested. |
| Does it send a prompt / use quota? | No. Only account methods are called, no thread or turn. The same 5% / 2% came back unchanged over repeated reads (several processes, up to 5 reads on one). The call is a read of the backend usage endpoint. |
| Side effects | It starts the full app-server: touches `~/.codex` (sqlite state/logs/queue/memories files, `models_cache.json`, `skills/`, `installation_id`), no session file (`~/.codex/sessions` was not created). `--analytics-default-enabled` is off by default for app-server: do not pass it. |
| Cost per probe (one-shot) | ~2.5-4.8 s wall, ~1.1-1.7 s CPU user+sys (the `codex` process tree, measured with shell `time`). Of that, `initialize` ~0.3-1.5 s and the read ~0.4-0.7 s. At a 30 min refresh that is ~0.1% of a core. |
| Cost kept alive | After the handshake each further read is ~0.4-0.6 s of wall time and little CPU, but the resident app-server is a Rust process with its sqlite state held open. For a 5-30 min cadence **one-shot is simpler and safer** (no zombie, no stale-token handling, survives CLI upgrades); revisit only if the adaptive 5 min pace makes the start cost matter. |
| Offline / backend error | Not simulated. Expect a JSON-RPC error: keep the last values and mark them stale, as for the other providers. |
| Format stability | Experimental command (`[experimental]` in `--help`), but the protocol is versioned and generates its own schema. Keep a raw response fixture per Codex version and raise a `FormatDriftError` when neither window is found. |

## What we lose compared with the chatgpt.com cookie fetch (#82-#90)

Today's `services/codex.ts` reads `wham/usage` directly. `rateLimits/read` is a typed projection of the same endpoint, so the 5 h and weekly windows, reset times, plan and credits flag are all there. Not carried over (or not yet seen in the projection):

- `code_review_rate_limit`, `additional_rate_limits` and per-model `model_usage` (`available_at`, `credits_would_enable`): only what the app-server maps into `rateLimitsByLimitId` buckets; whether extra buckets show up on Pro/Team is **not verified**.
- `credits.approx_local_messages` / `approx_cloud_messages` and `overage_limit_reached`.
- `reset_after_seconds` (not needed: `resetsAt` is absolute).
- Email / user id from the usage response (`account/read` gives email and plan).
- Windows with a duration that is not a whole number of hours or days: `windowDurationMins` is minutes, so the existing hour/day label logic needs minutes ↔ seconds care.

What we gain: no ChatGPT cookie, no Electron login window or partition, no Cloudflare/User-Agent fragility, no bearer handling, and the same login the user already trusts (also covers SSO and Team/Enterprise workspaces the web-cookie route never verified, `workspaceRouting` is handled by the binary). What we lose in practice: the user needs Codex CLI or the extension installed and signed in; a probe is a process start (~1.5 s CPU) instead of two HTTP calls.

## Decision

- **Primary Codex source for the Go core: one-shot `codex app-server` over stdio**, `initialize` → `initialized` → `account/read` → `account/rateLimits/read`, kill after the read, 10 s timeout, stdout lines parsed as JSON, `stderr` drained and never logged.
- **Hard rules:** run only the unmodified `codex` binary with the user's own login; never read or copy `auth.json`; never pass `--analytics-default-enabled`; do not call `account/login/*`, `account/logout` or `account/rateLimitResetCredit/consume`; signed-out → a "sign in with Codex" state, not an error.
- **No cookie fallback in the Go core.** The chatgpt.com cookie route (#82) stays only in today's Electron app until the Go core replaces it.
- **To do before shipping:** (#158) probe Windows and macOS (discovery, `.cmd` shim, no console window flashing, kill the whole process tree: with `shell: true`, `child.kill()` in the prototype kills only the shell), an extension-only login, a Pro/Team account (extra buckets, `individualLimit`), and the offline case.

## Prototype

`scripts/spikes/codex-rate-limits.js` — throw-away, Node, not part of the build, lint or tests. Default prints a summary (credit balance redacted); `--raw` prints the full response with values; `--repeat N` does N reads on one process; `--bin PATH` picks the binary; `CODEX_HOME=<empty dir>` shows the signed-out error.
