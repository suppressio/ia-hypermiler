🌐 **English** | [Italiano](SPIKE-CODEX-APP-SERVER.it.md)

# Spike #142 — Codex quotas from `codex app-server` (`account/rateLimits/read`)

> Part of #139. Status: **done on Linux and Windows (#158), go as the Codex source for the Go core.** macOS is tracked in #171. Extra buckets of paid business plans are covered by a schema fixture in the Codex adapter #148, not by a real account.

## Setup

2026-10-27, Linux (Debian testing, ARM64), `codex-cli 0.163.0` installed through npm (`/usr/bin/codex` → `@openai/codex/bin/codex.js`), ChatGPT Plus login made with the CLI. Prototype: `scripts/spikes/codex-rate-limits.js` (Node, no dependencies). The exact shapes below come from the schema the binary itself generates: `codex app-server generate-json-schema --out <dir>` (same source as openai/codex `codex-rs/app-server-protocol`), then checked against real responses. No `generate-ts` output is needed by the app.

2026-10-31 (#158): Windows 11 VM (`codex-cli 0.166.0` through npm, Node 26; VS Code extension `openai.chatgpt` 26.1021.22027 with its bundled `codex 0.164.0-alpha.11.1`), plus the offline case and the extension binary on Linux (`codex-cli 0.163.0`). Same ChatGPT Plus account, signed in with `codex login --device-auth`. Besides the Node prototype, a throw-away Go probe that does what the core will do: find the binary, spawn it with no shell, `initialize` → `account/rateLimits/read`, close stdin, wait.

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
- Errors: signed out → JSON-RPC error `-32600 "codex account authentication required to read rate limits"` (checked with an empty `CODEX_HOME`). Binary not found → spawn `ENOENT`. Offline: see *Results*.
- Shutdown: closing stdin makes `codex app-server` exit by itself (exit code 0, Linux and Windows). That is the clean way to end a probe; a kill is only the fallback after a timeout.

## Results

| Question | Answer |
|---|---|
| Works with the login the user already has? | Yes. The app-server reads the same `CODEX_HOME` (`~/.codex`) as the CLI and refreshes the token itself. We never open `auth.json` and store nothing (the prototype does not read it either). |
| Login made only from the IDE extension? | Shared. The extension resolves its home as `CODEX_HOME` or `~/.codex` (read in its bundled JS; under WSL it asks the WSL environment), the same folder as the CLI, so a login made in either is seen by both. Its bundled binary answered with the same shapes on Linux and was found on Windows. It is not on `PATH`: see *Binary discovery*. |
| Credentials in the OS keyring | Works. With `cli_auth_credentials_store = "keyring"` in `~/.codex/config.toml` the login goes to the Windows Credential Manager, `auth.json` is not written, and the app-server reads the credentials by itself. **But only inside the user's own logon session**: from an SSH key logon (no logon credentials) the store is unreachable (`ERROR_NO_SUCH_LOGON_SESSION` on `codex logout`) and the read fails with the signed-out error `-32600`. So on Windows the core must run in the user's session (started at login), not as a Windows service. |
| Binary discovery | On Windows npm puts only shims on `PATH` (`codex.cmd`, `codex.ps1`, a `sh` script), all of them running `node codex.js`, which starts the native binary. Spawn the native binary directly instead: `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` (same layout on Linux: `…/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`). The wrapper only adds `CODEX_MANAGED_BY_NPM=1` and `CODEX_MANAGED_PACKAGE_ROOT` (update hints), not needed by `app-server`. The extension's binary: `~/.vscode/extensions/openai.chatgpt-<version>-<platform>/bin/<os>-x86_64/codex[.exe]`, a native build, newer than the npm CLI and sometimes an alpha. On Windows the same folder also holds `bin/linux-x86_64/codex` for WSL, so pick the subfolder of the current OS explicitly, never a glob on `bin/*`. Order: user setting with an explicit path; native `codex[.exe]` on `PATH` (skip `.cmd`/`.ps1` shims); npm global prefix; newest extension folder (`.vscode`, `.vscode-server`, forks of VS Code). macOS: #171. |
| Does it send a prompt / use quota? | No. Only account methods are called, no thread or turn. The same 5% / 2% came back unchanged over repeated reads (several processes, up to 5 reads on one). The call is a read of the backend usage endpoint. |
| Side effects | It starts the full app-server: touches `~/.codex` (sqlite state/logs/queue/memories files, `models_cache.json`, `skills/`, `installation_id`), no session file (`~/.codex/sessions` was not created). `--analytics-default-enabled` is off by default for app-server: do not pass it. |
| Cost per probe (one-shot) | ~2.5-4.8 s wall, ~1.1-1.7 s CPU user+sys (the `codex` process tree, measured with shell `time`). Of that, `initialize` ~0.3-1.5 s and the read ~0.4-0.7 s. At a 30 min refresh that is ~0.1% of a core. Most of the start cost is the Node wrapper: the native binary started directly takes ~0.1-0.2 s to `initialize` and ~0.9-1.2 s in all (Linux extension binary, Windows npm `codex.exe`). |
| Console window and process tree (Windows) | Checked from a Go probe built as a GUI app (`-H=windowsgui`, no console of its own, like the core) and run in the desktop session, sampling visible windows while it runs. Without `CREATE_NO_WINDOW` a Windows Terminal window titled `codex.exe` opens (3 new windows); with `SysProcAttr{HideWindow: true, CreationFlags: CREATE_NO_WINDOW}` none. The process-tree worry did not reproduce: with codex 0.166.0, `child.kill()` left no `codex.exe` behind, with `codex.cmd` + `shell: true` or with the `.exe` and no shell, even with the parent still alive. Spawning the `.exe` with no shell avoids the question anyway. |
| Cost kept alive | After the handshake each further read is ~0.4-0.6 s of wall time and little CPU, but the resident app-server is a Rust process with its sqlite state held open. For a 5-30 min cadence **one-shot is simpler and safer** (no zombie, no stale-token handling, survives CLI upgrades); revisit only if the adaptive 5 min pace makes the start cost matter. |
| Offline / backend error | Checked on Linux with no network (`unshare -rn`): `initialize` still answers at once; `account/read` fails after **15 s** with `-32603 "workspace routing discovery timed out"`; `account/rateLimits/read` fails after **5 s** more with `-32603 "failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)"`. Both are the generic internal error code: treat any `-32603` as "no fresh data", keep the last values and mark them stale. An HTTP error from the backend (5xx) was not simulated (it needs TLS interception); it is expected to come back as `-32603` too. |
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

- **Primary Codex source for the Go core: one-shot `codex app-server` over stdio**, `initialize` → `initialized` → `account/rateLimits/read`, then close stdin and wait (kill only after a timeout); stdout lines parsed as JSON, `stderr` drained and never logged. Call `account/read` only when the signed-in state is unknown (first run, after a `-32600`): offline it alone costs 15 s. Timeout per call 10 s, per probe 25 s.
- **Windows:** spawn the native `codex.exe` directly (never `cmd.exe` or the npm shims) with `CREATE_NO_WINDOW`; run the core in the user's logon session, not as a service, or keyring logins are invisible.
- **Hard rules:** run only the unmodified `codex` binary with the user's own login; never read or copy `auth.json`; never pass `--analytics-default-enabled`; do not call `account/login/*`, `account/logout` or `account/rateLimitResetCredit/consume`; signed-out → a "sign in with Codex" state, not an error.
- **No cookie fallback in the Go core.** The chatgpt.com cookie route (#82) stays only in today's Electron app until the Go core replaces it.
- **To do before shipping:** macOS discovery (#171); a fixture built from the generated schema with several buckets and `individualLimit`, tested in the Codex adapter (#148): known windows found by duration, unknown buckets ignored.

## Prototype

`scripts/spikes/codex-rate-limits.js` — throw-away, Node, not part of the build, lint or tests. Default prints a summary (credit balance redacted); `--raw` prints the full response with values; `--repeat N` does N reads on one process; `--bin PATH` picks the binary; `CODEX_HOME=<empty dir>` shows the signed-out error. On Windows it still spawns with `shell: true` (the #142 version): use it only from a terminal. The Go probe of #158 was not kept; its two Windows-specific lines are the `SysProcAttr` above.
