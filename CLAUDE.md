# CLAUDE.md — IA Hypermiler

Project memory for Claude Code. Read it in full before touching the code.

---

## What this project is

**IA Hypermiler** is an Electron desktop app that monitors AI token usage (Claude and GitHub Copilot) and computes an optimal daily budget so the quota lasts until renewal. It shows an always-visible widget with daily consumption against the ideal budget, end-of-period projection, efficiency metrics and tips derived from real data. UI in English and Italian.

**Languages:** the conversation with the user is in **Italian**. All **code** (identifiers, comments, test names, logs, internal error messages) is in **English**. Human-facing **documents** exist in English (`X.md`, primary) and Italian (`X.it.md`, secondary) with a language switcher at the top; this file is English only.

---

## Stack and dependencies

| Role | Technology |
|---|---|
| Language | TypeScript, `strict: true` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`. No `any` |
| Desktop shell | Electron (current LTS) |
| UI | Vanilla HTML + CSS + SVG — no framework, no bundler. The renderer compiles to native ES modules (`<script type="module">`) |
| i18n | No library: typed flat dictionaries (`renderer/i18n/`, `main/i18n/`) + `Intl` |
| Persistence | electron-store (with encryptionKey for secrets), normalized at startup (`store/normalize.ts`) |
| Advice agent | Anthropic SDK for Node.js (`@anthropic-ai/sdk`) — `agents/advisor.ts` is still a stub |
| Local insights (opt-in) | `@anthropic-ai/claude-agent-sdk` — reads local Claude Code sessions via `listSessions`/`getSessionMessages`, never by parsing the internal JSONL directly (see RESEARCH.md §5) |
| Build | `tsc` (three configs: `tsconfig.json` main/preload/services/store/budget/agents/tests — CommonJS; `tsconfig.renderer.json` renderer — ES modules; `tsconfig.renderer.test.json` renderer tests only, adds Node types) + `scripts/copy-assets.js` |
| Lint | ESLint 10 + typescript-eslint `strictTypeChecked` (`eslint.config.mjs`) |
| Tests | `node:test` + `node:assert` (no external test library); coverage via Node's built-in `--experimental-test-coverage` |
| Packaging | electron-builder |
| Runtime | Node.js 22 LTS |

**Do not add dependencies without asking.** Every new library must be justified and agreed before installing it. (Agreed so far: TypeScript, `@types/node`, `@anthropic-ai/claude-agent-sdk`, ESLint + `@eslint/js` + `typescript-eslint` as dev dependencies.)

---

## Project structure

```
ia-hypermiler/
├── CLAUDE.md                    ← this file (English only)
├── LICENSE                      ← MIT
├── README.md / README.it.md     ← user-facing docs (EN primary, IT secondary)
├── ARCHITECTURE.md / .it.md     ← app design: data model, windows, widget, tray, updates, i18n
├── RESEARCH.md / .it.md         ← what the Claude/Copilot APIs really expose (Day 1 + addenda)
├── EVOLUTION.md / .it.md        ← retrospective and future directions with cost/benefit analysis
├── PLAN.md / .it.md             ← the original 3-day plan (historical)
├── tsconfig.json                ← main-process TS config (CommonJS)
├── tsconfig.renderer.json       ← renderer TS config (ES modules, isolated, no Node types)
├── tsconfig.renderer.test.json  ← renderer unit tests (adds Node types; emitted as ES modules)
├── eslint.config.mjs            ← type-aware lint, all three TS projects
├── types/index.ts               ← shared types (AppSettings, AccountConfig, AccountSnapshot, HypermilerBridge, …)
├── scripts/
│   ├── copy-assets.js           ← copies renderer html/css into dist/renderer/ + writes dist/renderer/package.json {type: module}
│   └── generate-icons.js        ← one-off "gauge" icon generator (build/icon.png, build/icons/*, renderer/assets/*.png)
├── build/                       ← electron-builder resources (icons) — TRACKED, not an output (packages go to release/)
├── main.ts                      ← Electron main process (lifecycle, IPC, refresh, update checks)
├── preload.ts                   ← contextBridge renderer ↔ main
├── main/
│   ├── windows.ts               ← main window (skins filled/filled-dark/transparent-digital) and Settings window
│   ├── tray.ts                  ← cross-platform tray; createTray returns { tray, refreshMenu }
│   ├── claude-auth.ts           ← Claude session capture via login BrowserWindow, one Electron partition per account
│   ├── providers.ts             ← provider-specific part of the account registry (connection, fetch, disconnect, secret redaction)
│   ├── copilot-oauth.ts         ← GitHub OAuth App login (loopback PKCE), experimental alternative to the PAT (+ test)
│   └── i18n/                    ← main-process strings (tray, notifications, dialogs, OAuth page): en.ts, it.ts, index.ts (+ test)
├── renderer/
│   ├── index.html, style.css, app.ts           ← widget
│   ├── settings.html, settings.css, settings.ts ← Settings window (accounts table, language, updates, …)
│   ├── dom.ts                   ← byId(id, ElementType): typed, checked element access
│   ├── schedule.ts              ← one-line summary of an account work schedule (+ test)
│   ├── types.ts                 ← reduced local copy of the shared types (renderer tsconfig is isolated)
│   └── i18n/                    ← UI strings: en.ts (reference), it.ts, index.ts (t, applyTranslations, Intl formatting) (+ test)
├── agents/advisor.ts            ← Claude advice agent (stub)
├── services/
│   ├── _http.ts                 ← shared fetch helper (10s timeout, explicit errors)
│   ├── _shape.ts                ← response → structure only (never values), FormatDriftError (+ test)
│   ├── claude.ts                ← Claude usage fetch (+ test)
│   ├── copilot.ts               ← Copilot usage fetch (+ test)
│   ├── claudeLocalSessions.ts   ← insights from LOCAL Claude Code sessions, opt-in (+ test)
│   ├── claudeLocalSessions.worker.ts ← utility-process entry: the scan runs off the main process
│   ├── updates.ts               ← new-version check via the GitHub Releases list (+ test)
│   └── githubHost.ts            ← github.com or <tenant>.ghe.com: validation + API/OAuth base URLs (+ test)
├── diagnostics/githubIssue.ts   ← pre-filled GitHub issue URLs (format drift, report draft) + response redaction (+ test)
├── diagnostics/report.ts        ← manual diagnostic report file: layout, neutral names (+ test)
├── diagnostics/logBuffer.ts     ← last main-process errors/warnings, memory only
├── store/
│   ├── index.ts                 ← electron-store wrapper: creates the store and normalizes it at startup
│   ├── defaults.ts              ← AppSettings defaults (pure module, usable by tests)
│   ├── merge.ts                 ← deep merge "value on disk over defaults"
│   ├── normalize.ts             ← normalizeSettings: any store on disk → valid AppSettings (+ test)
│   └── migrate.ts               ← per-provider defaults, legacy {claude, copilot} → AccountConfig[] migration (+ test)
├── budget.ts                    ← pure budget/efficiency/projection/verdict/tip/yield logic (+ budget.test.ts)
├── tests/
│   ├── support/at.ts            ← at(array, i) helper for tests under noUncheckedIndexedAccess
│   └── integration/             ← real-API tests, active only with local credentials (see .env.test.example)
├── .env.test.example            ← template for integration-test variables (never commit .env.test)
├── dist/                        ← tsc output + copied assets (gitignored)
└── package.json
```

---

## Architectural rules — DO NOT deviate

### Electron security
- `nodeIntegration` always `false`, `contextIsolation` always `true`.
- The renderer never has direct access to Node.js: everything goes through `preload.ts` via `contextBridge`.
- API keys and session cookies live only in the main process and in encrypted `electron-store` — never in the renderer, never in localStorage. `settings:get`/`settings:set` redact secrets towards the renderer (`providers.redactSecrets`) and preserve the real values on write (`providers.preserveSecrets`).
- Every value coming from the renderer through IPC is `unknown` and is validated in the handler (`requireString`/`requireBoolean`/`requireOneOf` in `main.ts`). `settings:set` accepts only renderer-editable sections (`accounts`, `ui`, `diagnostics`, `updates`) and normalizes the patch before writing.
- URLs opened with `shell.openExternal` come from the main process (store/constants), never from the renderer; update URLs must start with the project repository prefix.

### Cross-platform
- No hard-coded path separators: always `path.join()`/`path.resolve()`.
- No `shell.exec()` or OS-specific commands.
- Think through every path on Windows, macOS and Linux before writing it.

### Service interface
Every usage service (`services/claude.ts`, `services/copilot.ts`) exports exactly (full types in `types/index.ts`, multi-window rationale in ARCHITECTURE.md §0):

```ts
export async function fetchUsage(credentials: ClaudeCredentials | CopilotCredentials): Promise<RawAccountUsage> { ... }

// RawAccountUsage = { planTier, subscriptionRenewsAt, quotaWindows: QuotaWindow[] }
// QuotaWindow    = { id, label, periodType, periodLength, unit: 'percentage'|'count', used, total, resetsAt }
```

When a service cannot get the data it **throws an explicit error** with a readable message — never returns `null`/`undefined` silently. No `dailyHistory` from services: neither Claude nor Copilot exposes it, the daily history is built locally by `main.ts` in `store.history.dailyUsage` on every successful refresh. Adding a provider = a service with `fetchUsage` + a branch in every function of `main/providers.ts` (exhaustive switches make tsc fail if one is forgotten) + a detail template in `settings.html` + dictionary keys.

### Error handling
- Every network call has an explicit timeout (max 10 seconds) — use `services/_http.ts`.
- If the APIs do not answer, the UI shows the last known data with the timestamp of the last successful update.
- Never a blank screen or a silent crash: no floating promises (`runDetached` in main, `runGuarded`/`guarded` in the renderer); startup failure shows an error dialog and quits.

### Diagnostics: automatic "format drift" report
When a service receives a response whose format no longer matches the expected one (no recognized quota window, key field missing, …) it throws a `FormatDriftError` (`services/_shape.ts`) instead of a generic `Error`. `main.ts` catches it in `fetchAccountOrFallback()` (shared by every account) and calls `maybeReportFormatDrift()`:

- **Never automatic publishing**: only a pre-filled GitHub issue draft opens in the system browser (`shell.openExternal`, via `diagnostics/githubIssue.ts`); the user must always review and submit it by hand. The app has and uses no GitHub token.
- **Never real values in the report**: the issue body contains only the response "shape" (field names + `typeof`, from `extractShape()`), never usage percentages, amounts or real dates. The body is in English (public repository).
- **Deduplicated by structure signature** (`shapeSignature()`): the same shape does not reopen a draft on every refresh. Reported signatures live in `store.diagnostics.reportedSignatures`.
- **Can be disabled** in Settings (`diagnostics.autoReportFormatDrift`, default `true`).

**Manual diagnostic report** (Settings → Diagnostics, "Create diagnostic report"): after an explicit confirmation (native dialog listing what goes in and that nothing is sent), one text file in Downloads (`diagnostics/report.ts`) with, per connected account (enabled or not, named "<Provider> #n"): the raw usage response redacted by `redactResponse()` (`diagnostics/githubIssue.ts` — numbers, booleans, null, ISO dates and short enum-like fields kept, other strings replaced by their length, any value under an id key replaced whatever its type), the settings that affect pacing (no labels, host only as github.com/"a .ghe.com tenant"), the app's reading of the data (last snapshot), 7 days of history and today's samples; plus environment and the last 50 main-process errors/warnings (`diagnostics/logBuffer.ts`, memory only). Free texts go through `neutralize()` (labels/ids → neutral names, single pass) and `shortError()` (no response bodies). The folder is shown and a short GitHub issue draft opens: the user attaches the file by hand, or not. Unlike the automatic drift report it **does** carry usage values; never credentials, ids, names or free text.

### Store
- The store on disk is normalized at startup and after every `settings:set` (`store/normalize.ts`: deep merge with `store/defaults.ts`, wrong types replaced, legacy schemas migrated). Therefore `AppSettings` types are true: read top-level keys with their types (`store.get('history').recentSamples`), **never** dotted paths with casts (`store.get('a.b') as T`) and never `?? []` fallbacks. A new field only needs to be added to `store/defaults.ts`.
- Background: electron-store applies defaults with a SHALLOW merge, so a new nested field used to be `undefined` on existing installations — this caused real bugs before normalization existed.

### Internationalization
- Every user-visible string goes through `t()` (renderer: `renderer/i18n`, main: `main/i18n`) or a `data-i18n*` attribute in HTML (English default text in the markup). A new key goes into `en.ts` **and** `it.ts` (the compiler enforces key parity, the tests also check placeholders).
- Main and renderer own their texts separately (separate TS projects); `resolveLocale` must stay identical in both.
- Tips, verdicts and similar are **data** (`{ key, params }`), composed into sentences by the renderer. Technical error messages from services stay English; `friendlyErrorMessage` frames known cases in the user's language.
- Numbers and dates via the `Intl` helpers in `renderer/i18n/index.ts`, never a hard-coded locale.
- Documents: update both `X.md` and `X.it.md` when changing content.

### Code quality
- `npm run lint` must stay at **zero findings** (it gates CI). Do not turn off a rule to hide a real problem; the only documented exception is the `new Function` dynamic import in `services/claudeLocalSessions.ts`.
- No `!` non-null assertions in production code: `byId()` in the renderer, explicit checks elsewhere.
- Values from outside (IPC, network JSON) are typed `unknown` / `T | null` and narrowed.

### Advisor agent
- The system prompt of `agents/advisor.ts` must ask for **specific, practical** advice, not generic.
- Context passed to the agent: consumption of the last 7 days, current daily budget, services used.
- The result is cached in `electron-store` and regenerated at most once every 24 hours.
- `model` is always `claude-sonnet-4-6`, `max_tokens: 1000`.

---

## Core business logic

### Daily budget computation
Implemented in `budget.ts` (do not duplicate it here: update this section only if the model changes). Public API, all pure functions tested in `budget.test.ts`:

- `workingUnitsBetween(start, end, workSchedule)` — working units (1/0.5/0 per day) between two dates; with `workSchedule.enabled === false` every day counts 1
- `todayActivitySpan`, `todayElapsedUnits`, `elapsedWorkingUnits`, `remainingWorkingUnits` — actual working hours: today's span = first to last increase among the day's samples (`history.recentSamples` keeps the whole day), started earlier by today's first local Claude Code session; today's elapsed part = span / `hoursPerDay`, at least 2h, capped at the day unit; calendar fraction of the day with the schedule disabled. Elapsed + remaining = the whole period
- `localDateKey` / `parseDateKey` — LOCAL `YYYY-MM-DD` keys of the history (never `toISOString().slice(0, 10)`, which is the UTC day)
- `updateDailyPoint` — today's history point with its baseline (`dayStartUsed`) and first activity
- `normalizedUtilization(window)` — 0-100 percentage, or `null`
- `pickCriticalWindow(quotaWindows)` — the window with the highest utilization (threshold notification)
- `efficiencyIndex`, `projectedUsage`, `estimatedAutonomyWorkingDays` — pacing on working units, not calendar days; projection and autonomy blend the period average 50/50 with `recentPacePerUnit` (last 3 completed working days); projection NOT capped at 100
- `todayBudget` — today's budget (what was left at the start of the day over the working units from today on) vs today's consumption; `PACE_ALERT_RATIO`
- `redistributedQuota` — what is left NOW over the working units from today on (`perUnit`) next to the even share (`idealPerUnit`): the primary pacing signal, needs no history
- `daysUntilReset` / `workingDaysUntilReset`
- `instantaneousRate`, `sustainableHourlyRate`, `efficiencyRating` — instant gauge (sustainable %/h spread over remaining working hours = working units × `hoursPerDay`, also with the schedule disabled) and star rating
- `hourlyOutlook`, `currentPacePerUnit`, `pickCriticalSnapshot` — rolling-hours windows read in hours (time to reset, projection at reset and autonomy at the instant pace; day metrics hidden); the verdict turns at risk when the pace (not preliminary) exceeds `PACE_ALERT_RATIO` × the redistributed quota; the widget opens on an at-risk/exhausted window first, then the most used
- `dailyDeltas`, `deltaStats`, `windowVerdict` — daily consumption chart, peak/average/streak (completed days only), per-window verdict from the redistribution (at risk < 0.5× / behind < 0.95× / on track / ahead > 1.05× the even share; rolling-hours windows: projection/autonomy)
- `hasPacing`, `repairFirstDayBaseline` — a billing cycle of unknown length has no pacing (also the tie-break of `pickCriticalWindow`); first history point on the period start day gets baseline 0
- `tokenYield`, `consumptionCause` — value per token (Claude local insights; a cause is stated only with a clear signal)
- `generateDailyTip` — `{ key, params }` from explicit conditions on the metrics above, never a generic tip
- `resolveRenewalDate(renewalRule, referenceDate)` — only `{ type: 'dayOfMonth', day }`; `rrule` throws "not supported". Only a fallback: the period end is the window's `resetsAt`, then the provider's `subscriptionRenewsAt`, then the manual day (`main.ts resolvePeriodBounds`); Settings locks the manual field when the provider reports every paced window's reset (`renderer/renewal.ts`)

### Threshold and pace notifications
- System notification when usage passes the configured threshold (default **80%**) of the critical window, at most once per day per account (flag in `store.meta.notifiedToday`).
- Pace notification when today's consumption of any window exceeds `PACE_ALERT_RATIO` (1.5×) today's budget, at most once per day per account (`<account>:pace:<day>` flag). Only today's flags are kept.

### Auto-refresh
- The main process refreshes every **30 minutes** via `setInterval`, also with the window closed (tray only). After each successful fetch the data is stored and sent to the renderer (`usage:update`).

### Update check
- At startup (packaged app only) and every 24h: GitHub Releases list (not `/releases/latest`, which skips pre-releases), one notification per version, download opens in the browser. No electron-updater (unsigned packages).

---

## What NOT to do

- Do not invent API endpoints not documented in `RESEARCH.md`.
- Do not add animations or effects to the UI — plain and readable is the priority.
- Do not expose secrets or credentials in any git-tracked file.
- Do not use `any`. If a type is really dynamic use `unknown` with explicit narrowing.
- Do not paste real credentials (sessionKey, PAT/token) in chat, commits, issues or logs — not even for tests. See "Integration tests" below.
- Do not make unrequested architectural refactors: if you see a structural problem, report it before fixing it.
- Do not write user-visible text outside the i18n dictionaries, and do not write code comments in Italian.

---

## Workflow with Claude Code

1. **New feature:** always use plan mode before writing code — describe what you will do and wait for confirmation.
2. **Bug fix:** describe the bug, the likely cause and the proposed fix before applying it.
3. **Before a release:** `npm run lint`, `npm test`; review `agents/`, `services/` and `main.ts` for calls without timeout, secrets in the renderer, non cross-platform paths, `setInterval` leaks.
4. **UI changes:** verify visually without asking the user for screenshots — offscreen rendering works in this environment: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npx electron --no-sandbox <script>` with a `BrowserWindow` `show: false` + a fake preload + `webContents.capturePage()`. Check both languages.

---

## Build and test

- `npm run build` — compiles the three TS configs and copies html/css into `dist/renderer/` (`scripts/copy-assets.js`). Output always in `dist/`, never committed.
- `npm start` — build + `electron .`
- `npm run lint` — ESLint, must be zero findings.
- `npm run typecheck` — `tsc --noEmit` on every config.
- `npm test` — build + `cd dist && node --env-file-if-exists=../.env.test --test`. **Not** `node --test dist` from the root: on Node 22 a bare directory argument fails with MODULE_NOT_FOUND. Unit tests mock `fetch`/SDK and never touch the network; renderer tests run as ES modules thanks to `dist/renderer/package.json`.
- `npm run coverage` — tests with Node's built-in coverage (counts only files imported by at least one test).
- `npm run package` — build + electron-builder (installers in `release/`, **not** `dist/`).

### CI — cross-platform build (GitHub Actions)
`.github/workflows/build.yml` builds on macos/windows/ubuntu in parallel:
- **Trigger:** only a pushed tag starting with `v` (e.g. `v0.4.0-beta`) or `workflow_dispatch`. No build on every push/PR.
- **Each job:** `npm ci` → `npm run lint` → `npm test` → `npx electron-builder --<mac|win|linux> --publish=always`.
- **Output:** packages attached to the GitHub Release of the tag (`contents: write` permission) and uploaded as run artifacts (14 days). Release notes are written by hand (EN + IT) after the run.
- **No code signing** (`CSC_IDENTITY_AUTO_DISCOVERY: false`): Gatekeeper/SmartScreen warn at install time.
- `package.json` `author` must carry an email (Debian "Maintainer"): the GitHub noreply address is used, never a real one.

### Integration tests (real credentials)
`tests/integration/*.integration.test.ts` call the real Claude/Copilot APIs but **skip themselves** without credentials. To enable them **locally**: copy `.env.test.example` to `.env.test` (gitignored), fill the variables, run `npm test`. **Never provide these credentials in chat**: the assisted environment does not need them.

---

## Milestones

Condensed history; the full session-by-session log is in the git history (CLAUDE.md before 2026-10-01).

| When | Version | Milestone |
|---|---|---|
| Day 1 | — | API research (RESEARCH.md v3), architecture (multi-window quota model), Electron skeleton with mocks |
| Day 2 | — | Real services (Claude internal endpoint + session, Copilot official API), TypeScript migration, unit tests |
| Day 3 | v0.1.0-beta | Notifications, robustness, format-drift diagnostics, first real-account fixes, cross-platform CI |
| post-MVP | v0.1.x | UX rounds (frameless skins, title-bar drag, accent color, Save/Cancel), Copilot OAuth (hypothesis disproved), local Claude Code insights, instant gauge + star rating, data-driven tips, toggleable work schedule, dark skin |
| 2026-09-30 | v0.2.0-beta | N provider-independent accounts with isolated sessions (#4), own chart + window verdicts, value per token, reset time when today (#3) |
| 2026-09-30 | v0.2.1-beta | Fix: hidden window list stayed visible across accounts (`[hidden]` vs `display:flex`) |
| 2026-09-30 | v0.3.0-beta | Update check + browser download (#5) |
| 2026-10-01 | v0.4.0-beta | Robustness: stricter TS, type-aware ESLint gating CI, store normalization, IPC validation, unhandled promises, packaged icon fix; English/Italian UI; code in English; bilingual docs |
| 2026-10-01 | v0.4.1-beta | MIT license (packages metadata included) |
| 2026-10-01 | v0.4.2-beta | Fix: company Claude accounts read the new `spend` object (#6) |
| 2026-10-01 | v0.4.3-beta | Copilot: billing 400 fallback, token-based-billing snapshots (`credits_used`), clear message for enterprise-managed seats (#7) |
| 2026-10-01 | v0.4.4-beta | Copilot: GitHub domain per account — company seats on a `<tenant>.ghe.com` tenant read with a tenant PAT |
| 2026-10-01 | v0.4.5-beta | Copilot: personal scope reads the internal quotas first (billing report as fallback), OAuth no longer experimental; Settings tooltips no longer clipped |
| 2026-10-01 | v0.4.6-beta | Work schedule per account (inside each account detail), the old global one inherited on upgrade; fix: Copilot sync used github.com instead of the account's `.ghe.com` host |
| 2026-10-01 | v0.4.7-beta | Work schedule as the last, collapsed section of each account detail, with a one-line summary |
| 2026-10-01 | v0.4.8-beta | Pacing overhaul: monthly windows (Claude spend, Copilot) finally paced, working day from the day's samples, today's budget + pace notification, recent-pace and uncapped projection, local day keys, renewal date read from the provider |
| 2026-10-02 | v0.4.9-beta | Verdict from the remaining quota redistributed per working day; first-day baseline, phantom activity and running-day fixes; warning colours tied to the notification threshold (#13); "report usage response" issue draft; startup freeze fixed (local insights in a utility process, one store read/write per refresh), Settings loading state |
| 2026-10-02 | v0.4.10-beta | Claude `extra_usage` read as the monthly budget (deduplicated against `spend` on equal amounts), sane values on almost unused quotas, one diagnostic report for every account in Settings → Diagnostics, synthetic-only test data |
| 2026-10-02 | v0.4.11-beta | Diagnostic report file with explicit confirmation (ids redacted, log buffer), rolling-hours windows read in hours, verdict sees the current pace, working-hours gauge target with the schedule disabled, at-risk window shown first, Settings: info tooltips, locked fields visible, plan/Claude scope removed; local insights as their own section |

### Lessons learned (still relevant)
- **electron-store shallow merge**: new nested fields were `undefined` on existing stores → solved by `store/normalize.ts`.
- **ESM-only SDK in a CommonJS main process**: `require()` and even a TS-compiled `import()` fail with ERR_REQUIRE_ESM inside Electron → `new Function('s', 'return import(s)')` in `services/claudeLocalSessions.ts`.
- **claude.ai behind Cloudflare**: `sessionKey` alone gets a 403 challenge; the full cookie header (incl. `cf_clearance`) + a browser User-Agent are needed. Usage field names are obfuscated and rotate → windows are recognized by value shape.
- **Copilot company seats**: the seat may live on a GitHub Enterprise Cloud tenant with data residency (`<tenant>.ghe.com`, API on `api.<tenant>.ghe.com`), not on github.com — there `copilot_internal/user` has token-based-billing `quota_snapshots` (`credits_used`, `entitlement`), read with VS Code's rules. A github.com account linked to an enterprise (`access_type_sku: enterprise_managed`) has no data at all → `CopilotUsageUnavailableError`, not a drift. Each Copilot account has a validated `host` (`services/githubHost.ts`): the token is only ever sent to github.com or a `.ghe.com` tenant.
- **Logout reused the session**: cookies lived in `session.defaultSession` → one partition per Claude account, cleared on disconnect/remove/before login.
- **`[hidden]` vs author `display`**: a class with `display:flex` overrides `hidden` → global `[hidden] { display: none !important }`.
- **`build/` in .gitignore**: it is electron-builder's resources dir; icons were never committed (fixed — verify the packaged icon on the next release).
- **Optional parameters with a "safe" default hide wiring bugs**: the Copilot host was optional (default github.com) and `main/providers.ts` never passed it, so v0.4.4/0.4.5 sent tenant tokens to api.github.com (401). `CopilotCredentials.host` and `resolveUsername(token, host)` are now required, so the compiler catches a missing host.
- **Release tags** must start with `v` for CI to run.
- **`periodLength: null` silently disabled pacing**: the Claude company `spend` window and every Copilot window had it, so efficiency/projection/autonomy/verdict/tips were always empty there (noticed only after heavy use on day one went without warning). Billing-cycle windows known to be monthly declare `periodLength: 1` (months). Also: the current day only counted once over, so day one of a period had 0 elapsed units.
- **Synchronous work on the main process froze the app** (Settings blank for seconds at the first open): the encrypted store re-reads and decrypts the whole file on every `get` and rewrites it on every `set`, and the local Claude Code scan parsed up to 300 session files in-process. A refresh now reads the history once and writes it once (`HistoryDraft` in `main.ts`), refreshes do not overlap (one queued at most), and the scan runs in an Electron utility process (`services/claudeLocalSessions.worker.ts`), the stale cache shown meanwhile.
- **UTC day keys**: `toISOString().slice(0, 10)` is the UTC day, `new Date('YYYY-MM-DD')` is UTC midnight — both wrong for local working days → `localDateKey`/`parseDateKey`.

### Open items
- Next agreed steps: a single shared IPC contract (channels + types for main/preload/renderer, replacing the manual `renderer/types.ts` copy), then extracting a testable core from `main.ts` (EVOLUTION.md 2a) and working test-first.
- **Milestone v0.5.0** (GitHub): rename to "AIpermiler" (#9 — userData path, appId, repo, update-check prefix), AppStream metadata for Linux packages (#10), architecture review and simplifications (#12, includes the IPC contract and core extraction below). **Milestone v1.0.0** (out of beta): signed Windows/macOS installers (#11).
- `agents/advisor.ts` is a stub.
- Copilot tab occasionally not clickable right after login (not reproduced; if it happens, open the widget DevTools and check the console).
- Verify with real use the pacing constants (`PACE_ALERT_RATIO` 1.5×, 2h minimum of observed work, 50/50 recent-pace blend, preliminary below 2 working units, redistribution verdict bands 0.5× / ±5%, `NEGLIGIBLE_UTILIZATION` 0.1%) and the `consumptionCause` thresholds, and with the next release the packaged icon and the update notification end to end.
- Measure RAM/CPU in tray-only mode before considering EVOLUTION.md point 5.
