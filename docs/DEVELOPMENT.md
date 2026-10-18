🌐 **English** | [Italiano](DEVELOPMENT.it.md)

# Development

How to build IA Hypermiler from source, test it and package it. For what the app does and how to read it, see the [README](../README.md).

## Requirements

- Node.js 22 LTS or later
- npm

## Run from source

```bash
git clone https://github.com/suppressio/ia-hypermiler.git
cd ia-hypermiler
npm install
npm start
```

`npm start` compiles TypeScript (main process + renderer) and starts Electron. On first start there are no accounts: open Settings and add one.

## Build, lint and test

```bash
npm run build      # TypeScript (main + renderer) + static assets into dist/
npm run lint       # ESLint with type-aware rules (must stay at zero findings)
npm run typecheck  # tsc --noEmit on every TypeScript project
npm test           # build + unit tests (Node's built-in node:test runner)
npm run coverage   # tests with Node's built-in coverage
```

- **Unit tests** always run and never touch the network (`fetch` and the SDK are mocked). Test data is synthetic only.
- **Integration tests** (`tests/integration/`) call the real Claude, Codex and GitHub APIs and **skip themselves** when credentials are missing. To enable them locally, **never pasting credentials in chat or commits**:

```bash
cp .env.test.example .env.test
# fill .env.test with your credentials (see the comments in the file)
npm test
```

Codex requires both `HYPERMILER_TEST_CODEX_COOKIE_HEADER` and `HYPERMILER_TEST_CODEX_USER_AGENT` from the same account partition (see `.env.test.example`).

`.env.test` is already in `.gitignore` and is loaded automatically by Node (`--env-file-if-exists`), with no extra dependency.

## Packaging

```bash
npm run package       # installer for the current platform in release/
npm run package:test  # local test build: lint + tests, then .deb and Windows packages in release/test/
```

- `npm run package`: build + `electron-builder` → `.dmg` on macOS, `.exe`/NSIS on Windows, `.AppImage` and `.deb` on Linux, in `release/`.
- `npm run package:test`: version `<version>.dev.<timestamp>`, never published. The Windows NSIS `.exe` needs Wine (or Windows); without it, a ready-to-run `.zip`. This is the preferred way to try a change on a real machine.
- Linux: software centers read AppStream metadata, not the `.deb` control file. `build/linux/com.suppressio.ia-hypermiler.metainfo.xml` (license, author, EN + IT description, releases) is installed to `/usr/share/metainfo/` by the `deb.fpm` config in `package.json`; the `.desktop` entry has `Name=IA Hypermiler`. Update the file's `<release>` on every version and validate it with `appstreamcli validate`.

### Cross-platform build (GitHub Actions)

`.github/workflows/build.yml` builds on macOS, Windows and Linux in parallel from the same commit:

- a pushed `v*` tag (e.g. `v0.4.0-beta`) → lint, tests, packages attached to the GitHub Release of the tag;
- a manual run (`gh workflow run build.yml`, or the Actions tab) → test build: packages only as run artifacts (14 days), no release, no update notification.

Packages are not signed: macOS Gatekeeper and Windows SmartScreen show a warning at install time.

---

## Project structure

```
ia-hypermiler/
├── main.ts, preload.ts        ← Electron main process + secure bridge to the renderer
├── main/                      ← windows, tray, Claude/Codex login, OAuth, per-provider logic, refresh pace, main-process i18n
├── renderer/                  ← widget and Settings window (vanilla HTML/CSS/TS) + UI i18n
├── services/                  ← Claude/Copilot/Codex usage fetch, local sessions, update check (+ tests)
├── diagnostics/               ← format-drift report and diagnostic report file
├── store/                     ← local persistence (encrypted electron-store), defaults, normalization, migration
├── budget.ts                  ← budget/efficiency/projection/chart logic (+ budget.test.ts)
├── agents/                    ← Claude agent for usage advice (stub)
├── types/                     ← shared TypeScript types
├── tests/                     ← test helpers + integration tests gated by local credentials
├── docs/                      ← documentation, English + Italian (this file too) + README screenshots (synthetic data)
└── README.md, CLAUDE.md       ← user guide, project memory for Claude Code
```

Further reading:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — data model, windows, indicators, extensibility
- [`RESEARCH.md`](RESEARCH.md) — what can really be read from the Claude, Copilot and Codex APIs, and with which limits
- [`EVOLUTION.md`](EVOLUTION.md) — retrospective and future directions with a cost/benefit analysis
- [`PLAN.md`](PLAN.md) — the original day-by-day plan
- [`CLAUDE.md`](../CLAUDE.md) — project memory for Claude Code: stack, rules, milestones

## Security rules

- `nodeIntegration: false` and `contextIsolation: true` always: the renderer never has direct access to Node.js; every value coming from it through IPC is validated.
- Secrets stay in the main process: Claude sessions and Copilot tokens use the encrypted store; Codex cookies stay in the account partition and its access token is never stored. They never reach the renderer or logs.
- URLs opened in the browser are built in the main process from fixed prefixes, never taken from the renderer.

## Project status

- ✅ Real data from Claude (internal endpoint + session) and Copilot (personal plans, and company seats on a `.ghe.com` tenant; a github.com seat managed by an enterprise exposes no data, see `RESEARCH.md`)
- ✅ Codex usage through a ChatGPT web session, with rolling quota windows (see `RESEARCH.md` §6 for verification limits)
- ✅ Several accounts, English/Italian UI, update check, format-drift diagnostics, diagnostic report
- ✅ Own visualizations: daily consumption vs moving budget, window verdicts, instant gauge, rating, value per token
- ✅ Strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …), type-aware ESLint at zero findings, unit tests on every pure module
- ✅ Cross-platform CI publishing pre-releases; local test builds
- 🟨 Advice agent (`agents/advisor.ts`) still a stub
- ✅ Shared IPC contract between main, preload and renderer (`types/ipc.ts`)
- ⬜ Next: extracting a testable core from `main.ts` to work test-first
