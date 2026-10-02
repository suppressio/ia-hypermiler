🌐 **English** | [Italiano](README.it.md)

# IA Hypermiler

Electron desktop app (Windows / macOS / Linux) that monitors AI token usage — Claude and GitHub Copilot — and computes an optimal daily budget so the periodic quota does not run out before renewal. Built for the individual developer keeping an eye on their own usage, not for an admin monitoring a team.

It shows an always-visible widget with the current usage, daily consumption against the ideal budget, an efficiency index and star rating, an end-of-period projection and tips derived from your real data. The interface is available in **English and Italian** (automatic from the system language, or chosen in Settings).

> Personal project in active development, built in pair programming with Claude. Pre-releases (`v0.x-beta`) are published on GitHub; see "Project status" below for what works today.

---

## Features

- **Several accounts, any mix of providers** — e.g. two Claude accounts and one Copilot, each with its own isolated session; "Disconnect" really deletes the saved session.
- **Your own pace per account** — each account has its own work schedule: e.g. a personal account with no constraints and a work account paced on working days (full, half or off per day of the week).
- **A view of its own, not a copy of the provider dashboard** — consumption per day against the ideal share, a list of quota windows with a verdict based on the remaining quota redistributed per working day (on track / quota reduced / room to spare / at risk), instant consumption gauge, efficiency rating.
- **Today's budget, on your real working hours** — how much you can still use today so the quota lasts until renewal; the working day is measured from the day's data (first to last increase in usage), and a notification warns you on the day you go well over (not only at 80%). The renewal day is asked only when the provider does not report it.
- **Value per token** (Claude, opt-in) — reads local Claude Code sessions (token counts and tool names only, never message content) to show how many tokens you produce per 1% of quota and, when the signal is clear, why you are consuming faster.
- **Update check** — at startup and every 24 hours; the right package for your system opens in the browser.
- **Format-drift report** — if a provider changes its response format, a pre-filled GitHub issue draft opens (structure only, never real values) for you to review.

## Requirements

- Node.js 22 LTS or later
- npm

## Install

```bash
git clone https://github.com/suppressio/ia-hypermiler.git
cd ia-hypermiler
npm install
```

Or download a pre-built package (`.exe`, `.dmg`, `.AppImage`, `.deb`) from [Releases](https://github.com/suppressio/ia-hypermiler/releases).

## Run in development

```bash
npm start
```

Compiles TypeScript (main process + renderer) and starts Electron. On first start there are no accounts: open Settings (gear icon in the widget, or from the tray) and add a Claude and/or GitHub Copilot account.

## Build, lint and test

```bash
npm run build      # TypeScript (main + renderer) + static assets into dist/
npm run lint       # ESLint with type-aware rules (must stay at zero findings)
npm run typecheck  # tsc --noEmit on every TypeScript project
npm test           # build + unit tests (Node's built-in node:test runner)
npm run coverage   # tests with Node's built-in coverage
```

- **Unit tests** run always and never touch the network (`fetch` and the SDK are mocked).
- **Integration tests** (`tests/integration/`) call the real Claude and GitHub APIs and **skip themselves** when credentials are missing. To enable them locally — **never pasting credentials in chat or commits**:

```bash
cp .env.test.example .env.test
# fill .env.test with your credentials (see the comments in the file)
npm test
```

`.env.test` is already in `.gitignore` and is loaded automatically by Node (`--env-file-if-exists`), with no extra dependency.

## Packaging

```bash
npm run package
```

Build + `electron-builder`: produces the installer for the current platform (`.dmg` on macOS, `.exe`/NSIS on Windows, `.AppImage` and `.deb` on Linux) in `release/`.

### Cross-platform build (GitHub Actions)

`.github/workflows/build.yml` builds on macOS/Windows/Linux in parallel from the same commit. It runs when a `v*` tag is pushed (e.g. `v0.4.0-beta`) or manually from the Actions tab: lint, tests, then the packages are attached to the GitHub Release of the tag. Packages are not signed: macOS Gatekeeper and Windows SmartScreen show a warning at install time.

---

## Project structure

```
ia-hypermiler/
├── main.ts, preload.ts        ← Electron main process + secure bridge to the renderer
├── main/                      ← windows, tray, Claude login, OAuth, per-provider logic, main-process i18n
├── renderer/                  ← widget and Settings window (vanilla HTML/CSS/TS) + UI i18n
├── services/                  ← Claude/Copilot usage fetch, local sessions, update check (+ tests)
├── diagnostics/               ← format-drift report via a GitHub issue draft
├── store/                     ← local persistence (encrypted electron-store), defaults, normalization, migration
├── budget.ts                  ← budget/efficiency/projection logic (+ budget.test.ts)
├── agents/                    ← Claude agent for usage advice (stub)
├── types/                     ← shared TypeScript types
├── tests/                     ← test helpers + integration tests gated by local credentials
└── *.md / *.it.md             ← project documentation, English + Italian
```

Further reading:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — data model, windows, indicators, extensibility
- [`RESEARCH.md`](./RESEARCH.md) — what can really be read from the Claude and Copilot APIs, and with which limits
- [`EVOLUTION.md`](./EVOLUTION.md) — retrospective and future directions with a cost/benefit analysis
- [`PLAN.md`](./PLAN.md) — the original day-by-day plan
- [`CLAUDE.md`](./CLAUDE.md) — project memory for Claude Code: stack, rules, milestones

---

## Security and credentials

- `nodeIntegration: false` and `contextIsolation: true` always: the renderer never has direct access to Node.js; every value coming from it through IPC is validated.
- The Claude session comes from a real login in an embedded window (classic or SSO), in a partition dedicated to the account: the app never asks you to paste a cookie.
- The GitHub Copilot token is a Personal Access Token (fine-grained, "Plan" read-only) or an OAuth App token, stored encrypted locally.
- No credential is ever exposed to the renderer or logged; `.env.test` is excluded from git.

## Project status

- ✅ Real data from Claude (internal endpoint + session) and Copilot (official API for personal plans; company seats have no self-service data source, see `RESEARCH.md`)
- ✅ Several accounts, multi-language UI (EN/IT), update check, format-drift diagnostics
- ✅ Own visualizations: daily consumption vs budget, window verdicts, instant gauge, rating, value per token
- ✅ Strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …), type-aware ESLint at zero findings, unit tests on every pure module
- ✅ Cross-platform CI publishing pre-releases
- 🟨 Advice agent (`agents/advisor.ts`) still a stub
- ⬜ Next: shared IPC contract, then extracting a testable core from `main.ts` to work test-first

## License

[MIT](./LICENSE) © 2026 Daniele 'suppressio'.
