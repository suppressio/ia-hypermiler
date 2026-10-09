🌐 **English** | [Italiano](ARCHITECTURE.it.md)

# ARCHITECTURE.md — Application structure (Day 1, Session 2 — Plan Mode)

> Design document produced in **plan mode**, following the workflow in `CLAUDE.md`: it describes what is built, and has been updated as features were implemented (sections marked *implemented* / *updated*).
> It is based on the real constraints found in `RESEARCH.md` (v3): Claude mostly exposes **usage percentages** over multiple concurrent windows (5 hours + weekly), not a token pool with a single total; Copilot instead exposes discrete counters (premium requests / credits) over a monthly billing cycle.

---

## 0. A design decision that comes before everything else

The original concept in `CLAUDE.md` (`{ used, total, resetDate }`) assumes **a single counter per service**. Research shows that is not enough:

- **Claude**: 2-3 concurrent, independent quota windows — `five_hour` (rolling 5h), `seven_day` (rolling 7 days, all models), `seven_day_opus` (rolling 7 days, Opus only). Each has its own `utilization` (%) and its own `resets_at`. There is no "monthly token total" to read from the account: the monthly renewal exists only as the **subscription billing date**, unrelated to the usage windows.
- **Copilot**: a discrete counter (`premium_requests` + `ai_credit`) tied to the monthly billing cycle — here the original "used/total/resetDate" model works as is.

**Proposal (adopted):** generalize the service interface from a single counter to a **list of "quota windows"** (`quotaWindows`) per account, each with its own period type (`rolling-hours`, `rolling-days`, `billing-cycle`) and unit (`percentage` for Claude, `count` for Copilot). The requested "tokens/day" indicator is therefore redefined as **"% of quota used per working day"** for Claude, and "premium requests used per working day" for Copilot — still normalizing everything to a percentage for visual comparison in the widget when a single aggregated number must be shown.

This had to be confirmed explicitly because it changes the `fetchUsage()` interface written in `CLAUDE.md`:

```js
// Extended interface (replaces { used, total, resetDate, dailyHistory })
{
  planTier: string,
  subscriptionRenewsAt: Date | null,        // billing date, if known
  quotaWindows: Array<{
    id: string,                              // 'five_hour' | 'seven_day' | 'seven_day_opus' | 'ai_credits' | ...
    label: string,
    periodType: 'rolling-hours' | 'rolling-days' | 'billing-cycle',
    periodLength: number | null,             // hours, days or months by periodType (5, 7, 1); null = unknown, no pacing
    unit: 'percentage' | 'count',
    used: number,                            // 0-100 for percentage, absolute value for count
    total: number | null,                    // null when the service exposes no total (Claude case)
    resetsAt: Date,
  }>,
  dailyHistory: Array<{ date: string, perWindow: Record<string, number> }>,
}
```

A reduced scope (only the most relevant window per service, e.g. only `seven_day` for Claude, ignoring 5h and Opus) was possible, but it would lose the "I am about to exceed the 5-hour window today" view, probably the most actionable information to avoid being blocked mid-day.

---

## 1. Settings — data schema

Extends `store/index.ts` (defaults in `store/defaults.ts`, normalization of the file on disk in `store/normalize.ts`). Everything secret (session cookie, PAT, token) stays encrypted through `electron-store`'s `encryptionKey` and never reaches the renderer except through IPC towards the main process.

```js
{
  // Registry of N provider-independent accounts (issue #4, EVOLUTION.md point 3):
  // common part + specific part, discriminated union on `provider`. Up to v0.1.2 these
  // were two fixed slots { claude, copilot }: converted once at startup by
  // store/migrate.ts, keeping the ids 'claude'/'copilot' (so history.* stays valid
  // without rewrites). The provider-specific main-process part lives in main/providers.ts.
  accounts: Array<{
    // --- common ---
    id: string,                // 'claude'/'copilot' if migrated, otherwise '<provider>-<uuid8>'
    provider: 'claude' | 'copilot',
    label: string,             // name shown in the table and the widget tabs ("Claude", "Claude 2"…)
    enabled: boolean,
    subscription: {
      renewalRule: { type: 'dayOfMonth', day: number } | { type: 'rrule', rrule: string },
    },
    workSchedule: {  // per account since 0.4.6 (it used to be one global setting, inherited by every account on upgrade)
      enabled: boolean, // when false, every day counts as a full day (pacing not tied to specific days/hours — e.g. a personal account)
      days: {
        mon: 'full' | 'half' | 'off',
        tue: 'full' | 'half' | 'off',
        wed: 'full' | 'half' | 'off',
        thu: 'full' | 'half' | 'off',
        fri: 'full' | 'half' | 'off',
        sat: 'full' | 'half' | 'off',
        sun: 'full' | 'half' | 'off',
      },
      hoursPerDay: number, // a single number, not a start/end range (user feedback, Day 2): the
                           // working span is read from the day's samples, first to last increase
                           // (budget.todayActivitySpan, started earlier by today's first local
                           // Claude Code session); today's elapsed part = span / hoursPerDay
                           // (budget.todayElapsedUnits, at least 2h).
    },
  } & (
    { // --- provider: 'claude' ---
      authMethod: 'password' | 'google' | 'sso',
      session: {
        sessionKey: string,        // encrypted
        organizationId: string | null, // resolved automatically at login (GET /api/organizations)
        capturedAt: string,        // ISO date
        expiresAt: string | null,  // estimated ~30 days, to re-validate
      },
      partition: string,         // 'persist:account-<id>': claude.ai cookies isolated per account,
                                 // cleared by Disconnect/Remove and before every login (issue #4)
      localInsights: boolean,    // local Claude Code sessions attributed to this account (max 1)
    } | { // --- provider: 'copilot' ---
      authMethod: 'pat' | 'oauth',  // chooses which connection panel to show; updated from the last successful connection
      accountScope: 'personal' | 'organization', // chooses the endpoints read (personal plan vs company seat)
      credentials: { token: string, username: string | null },  // encrypted token (PAT or OAuth App access token — see main/copilot-oauth.ts)
      oauthApp: { clientId: string | null },  // not a secret; the client secret is never persisted
      manualQuota: number, // the billing API does not expose the plan total: value entered by the user
      experimentalWarningAcknowledged: boolean,
    }
  )>,


  ui: {
    language: 'auto' | 'en' | 'it',       // 'auto' follows the system language (see §4c)
    windowStyle: 'filled' | 'filled-dark' | 'transparent-digital',
    alwaysOnTop: boolean,
    accentColor: string,
    bounds: { x, y, width, height },       // persisted position/size
    chartRange: 'week' | 'month',
    notificationThresholdPercent: number,  // default 80, configurable
  },

  history: {
    // append-only, one record per day per quota window; configurable retention (default 90 days) so the file does not grow forever
    dailyUsage: Array<{ date: string, accountId: string, windowId: string, used: number }>,
    lastGood: Record<accountId, RawAccountUsage>, // last successful data per account (fallback)
  },

  advisorCache: { generatedAt: string, adviceText: string },

  meta: {
    notifiedToday: Record<string, boolean>, // anti-duplicate notification flag per account/day
    claudeCookiesMigrated?: boolean,         // one-off copy of cookies from defaultSession into the migrated Claude account partition
  },
}
```

Sections of the Settings panel (separate window `renderer/settings.html`, opened from the tray or a gear icon in the widget):

1. **Accounts and sessions** — *(updated, issue #4)* a **table** of accounts (Name | Provider | Status | Active | actions Configure/Connect/Disconnect/Remove) with "Add account"; "Configure" opens the provider panel below the row (common + specific fields). Original description: for Claude and Copilot, connection status, method (password/SSO/PAT/OAuth device), a "Connect/Reconnect" button opening a login `BrowserWindow` for Claude or the device flow for Copilot, estimated session expiry, a "company seat" toggle with an automatic warning when active on Copilot ("experimental feature, may stop working without notice").
2. **Renewal** — subscription renewal day *(the plan type and the Claude account scope were removed in 2026-10: entered by hand and used by no computation; the account name tells accounts apart)* (a simple "day of month" picker; stored as a minimal rule so different recurrences can be added later without changing the schema). *(Since 2026-10:)* the manual day is only a fallback — a window's period end is its own `resetsAt`, then the provider's `subscriptionRenewsAt` (Copilot `quota_reset_date`; the billing report restarts on the 1st of the next UTC month by definition), then the manual day. Settings locks the field and shows the provider's date when every paced window has one (`renderer/renewal.ts`); today only the Claude company `spend` limit needs it.
3. **Work schedule** — *(per account since 0.4.6: last section of each account detail, collapsed with a one-line summary)* 7 day selectors with 3 states (full/half/off), an "enabled" switch (off = every day counts as a full day, e.g. a personal account) and hours/day (reserved). Used to compute budget and projections on "remaining working days", not calendar days.
4. **Appearance** — language (Automatic / English / Italiano), window style (the three skins below), always-on-top, accent color, default chart range (week/month).
5. **Notifications** — alert percentage threshold (default 80%, as in `CLAUDE.md`, now configurable), possibly per window (e.g. a separate alert for Claude's 5h limit).
6. **Advanced** — placeholder for future evolutions (see §5): future local server, data export.

---

## 2. Main window — the three "skins"

They all read the same data (IPC from main, no duplicated logic) and only change `renderer/style.css` + `BrowserWindow` creation flags.

**"Filled" style (classic - light):**
opaque background, block layout with borders. *(Updated:)* always `frame: false` with the app's custom title bar, revealed on hover — with `frame: true` the native OS title bar showed above the custom one (user feedback).

**"Filled" style (dark):** *(added, user feedback)*
Same opaque structure as the classic skin, with inverted colors (dark background, light text) — see the `--*-filled-dark` tokens in `renderer/style.css`. No behavioural difference from the classic skin besides colors (same custom title bar, same hover behaviour, same layout).

**"Transparent/digital" style:**
`frame: false`, `transparent: true`. HUD-style numbers/bars (monospace font, light glow — still plain to respect "no animations" in `CLAUDE.md`: no pulsing, only static contrast/opacity). System buttons (close/minimize) recreated as custom overlay controls, `opacity: 0` by default and `opacity: 1` only on hover, with `-webkit-app-region: drag` on the title bar strip to move the window without a native title bar.

**Always-on-top:** toggle in Settings and in the tray menu, applied with `win.setAlwaysOnTop(bool, 'floating')`; persisted and re-applied at startup.

---

## 3. Widget content

Central body — big "current usage" number: the most critical quota window right now (highest `utilization`), labelled with which window it is (e.g. "Weekly limit: 62%").

Below it, a chart, selectable week/month, with the ideal budget line (linear pacing) to see at a glance whether usage is above or below.

*(Implemented this way after EVOLUTION.md point 1 — the chart used to show the cumulative % per day, a copy of the provider dashboard.)* Each bar is **that day's consumption** (`budget.dailyDeltas`: difference with the day's baseline `dayStartUsed`, or with the previous day for older points, resets excluded), next to a thin bar with the even share of a full working day (coloured for the working part of that day, grey for the rest: half on a half day, all of it on a day off) and a dashed line with the **moving budget** (`budget.chartDays`): on a past day what was available that morning (what was left at the start of the day over the working units from that day to the reset, times the day's unit), today's budget today, and on the 2 (7-day view) or 5 (30-day view) days to come the remaining quota redistributed — a heavy day lowers the line of the days after it. Bars above that day's budget use `--warning`. Days of a previous period show only their consumption. Not shown for `rolling-hours` windows. When the account has several quota windows, a **list with a verdict** computed by the app (`budget.windowVerdict`) sits above the current value, the critical one first (on equal utilization the one with pacing), replacing tabs that only lined up the provider's metrics. The verdict rests on the **remaining quota redistributed** (`budget.redistributedQuota`: what is left now over the working units from today on, next to the even share of the period): at risk below half the even share, *quota reduced* below 95%, on track within ±5%, *room to spare* above — with the quota per working day in the text. It needs no history, so it is there from the first refresh of the morning, and after a heavy day it says what is left to spend instead of extrapolating that day to the whole period. Rolling-hours windows keep the projection/autonomy verdict; exhausted and no pacing are unchanged.

**Value per token** *(EVOLUTION.md point 4, Claude accounts with local insights only)*: "Yield" = output tokens of local Claude Code sessions per 1% of quota used (`budget.tokenYield`, with trend), and a causal tip about large context (`budget.consumptionCause`) shown **only** when the signal is clear. Stated limit: the SDK does not expose per-message times, every session is attributed to the day it was last modified.

Metrics panel:

- **Tokens (or % of quota) per current working day** — requested. *(Implemented as "Today: used / budget", `budget.todayBudget`:)* today's budget = what was left at the start of the day spread over the working units from today on, fixed for the day; today's consumption is measured from the day's own baseline (`DailyUsagePoint.dayStartUsed`, exact also on a reset day). Above `PACE_ALERT_RATIO` (1.5×) a system notification fires, at most once a day per account — the 80% threshold alone came too late (heavy use on day one of the month went unnoticed).
- **Weekly trend** — requested (the chart above)
- **Efficiency index** — requested. Formula: ratio between the ideal and actual consumption pace, computed on elapsed **working units** (not calendar days):
  `efficiencyIndex = idealPace / actualPace` where `idealPace = 100% / totalWorkingUnitsInPeriod` and `actualPace = currentUtilization / elapsedWorkingUnits`. Around 1 = on track; >1 = using less than planned (room to use more); <1 = consuming faster than sustainable.
- **Projection** — requested: projected usage at the end of the period, extrapolating the pace over the remaining working units. The pace blends 50/50 the period average with the last 3 completed working days (`budget.recentPacePerUnit`), so a change of habit shows at once; not capped at 100% (e.g. "227%" says how far over the pace leads). Elapsed time counts the part of today already worked (`budget.todayElapsedUnits`). With fewer than 2 working units elapsed, projection and autonomy are marked as a *preliminary estimate* and the tips built on them are skipped. Rating, peak/average and streak count only completed days (today's running 0% scored as a perfect day).
- **Days to reset** — requested: both calendar days and remaining **working** days (often more useful).
- **Estimated autonomy days** *(added)* — after how many working days the quota runs out at the current pace; useful when it is < days to reset (a more direct risk signal than the efficiency index alone).
- **Peak vs daily average** *(added; computed on daily deltas, `budget.deltaStats`)* — to tell whether problems are concentrated on unusual days or spread out.
- **Streak under budget** *(added)* — consecutive working days within the ideal budget, as light positive reinforcement (consistent with "plain": just a number, no badges/flashy gamification).
- **Combined multi-service view** *(added, when both Claude and Copilot are active)* — an "overall health" indicator aggregating the most critical windows of the two services, for an overview before opening the details.
- **Tip of the day** — requested. *(Implemented:)* derived from real data by `budget.generateDailyTip` (explicit conditions on the computed metrics, never a generic sentence); `agents/advisor.ts` (Claude Sonnet, 24h cache as in `CLAUDE.md`) is still a stub.

---

## 4. Cross-platform system tray

Native Electron `Tray` with a per-platform icon (`.ico`/`.png`/`.icns` assets handled by `electron-builder`). Uniform behaviour:
- Left click → show/hide the main window (on macOS a left click usually opens the menu: show/hide is therefore also an explicit menu entry, for consistency on every platform).
- Right click (or click on macOS) → context menu: Show/Hide, Settings, Refresh now, Always on top (quick toggle), Quit; plus "Update available (X)…" when a new version exists.
- Icon tooltip: quick summary (e.g. "Claude 62% · Copilot 40%").

---

## 4b. App updates (issue #5)

- **What it does:** at startup (after ~10s, packaged app only) and every 24h, `services/updates.ts` reads the project's GitHub Releases list and compares the highest version (semver with pre-releases, drafts excluded) with `app.getVersion()`. When newer: one system notification per version (`updates.notifiedVersion`), a tray menu entry and an "Updates" card in Settings with "Download X" (opens the package for the current OS in the browser) and "Check now". Can be disabled (`updates.autoCheck`).
- **Endpoint:** `GET https://api.github.com/repos/suppressio/ia-hypermiler/releases` (official REST API, anonymous, 60 requests/h per IP: ample margin). **Not** `/releases/latest`, which skips pre-releases — and every release of the project is one (`releaseType: "prerelease"`). No user data in the request.
- **Package choice:** `.exe` on Windows, `.dmg` of the same architecture on macOS (CI builds arm64 only: on an Intel Mac the release page opens), `.AppImage` when the app runs as an AppImage (`process.env.APPIMAGE`), otherwise `.deb` on Linux.
- **Why no automatic installation (electron-updater):** the user's choice — no new dependency, and with unsigned packages in-app updates would not work on macOS anyway. The URL opened always comes from the store (written by the main process) and must start with `https://github.com/suppressio/ia-hypermiler/`, never from a value passed by the renderer.

## 4c. Interface language (multilingual)

- **Languages:** English (primary) and Italian. `ui.language`: `'auto'` (Italian when the system language is `it*`, English otherwise) or an explicit choice; applied immediately to widget, Settings and tray, without a restart.
- **No library:** typed flat dictionaries + `Intl` for numbers and dates. The renderer has no bundler, so it cannot import from `node_modules`; for two languages a dictionary per process is enough. `en.ts` is the reference, `it.ts` is typed on the same keys: a missing or extra key does not compile.
- **Each process owns its texts** (two separate TypeScript projects): `renderer/i18n/` for the UI (including tips and verdicts), `main/i18n/` for tray, notifications, dialogs, login window and OAuth callback page.
- **Data, not sentences:** `budget.generateDailyTip` returns `{ key, params }` and the renderer composes the sentence; quota window labels are translated by `id`. Technical error messages from services stay in English (they are code); the main process frames them in the user's language for known cases (session expired).
- **Text in HTML:** English by default + `data-i18n`, `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder` attributes.
- **Code and documents:** all code is in English; human-facing documents exist in English (`X.md`) and Italian (`X.it.md`).

## 5. Future evolutions (not implemented, only prepared for)

**Integration with external desktop tools (Rainmeter, KDE Plasma, etc.):**
To avoid duplicating logic, `budget.ts` and the metric computation stay pure modules in the main process, callable both from the IPC channel to the renderer and — in the future — from a small **local loopback HTTP server** (`127.0.0.1`, configurable port, local access token generated at startup) exposing a read-only endpoint such as `GET /api/status` with the same JSON used internally. Rainmeter could read it with a WebParser/JSON plugin; a KDE Plasmoid with a small QML doing periodic fetches. No implementation now: only the architectural constraint "keep the computation logic separate from the UI", already respected by the structure in `CLAUDE.md`.

**Advanced usage analysis (model used, number of agents, parallel activity):**
For Claude Code this data is already in the local session files (model, token counts by type, session id) — the richest source, at almost zero cost, to start this feature from (the first part is implemented: local insights and value per token). For claude.ai web usage and for Copilot the available data is poorer (aggregate usage only). The `history.dailyUsage` schema has an optional `meta` field (ignored by the v1 aggregation) to avoid migrations when this feature arrives:
```js
{ date, accountId, windowId, used, meta: { model?, sessionId?, parallelAgents?, activityType? } }
```

**Retrospective and undecided future directions:**
After the MVP (Day 3), the user opened a conceptual retrospective on the direction of the project (moving away from the provider's view, separating data/backend from the UI with an internal API, multi-provider genericity, redefining "efficiency" towards value per token, Electron's resource cost in tray-only mode). Moved to a dedicated document so "what is being built" (this file) is not mixed with "directions not decided yet, under cost/benefit evaluation" — see **`EVOLUTION.md`**.

---

## 6. Impact on the file structure (compared with the skeleton in `CLAUDE.md`)

Additions proposed in Session 2 (confirmed and implemented):
- `renderer/settings.html` + `renderer/settings.ts` + `renderer/settings.css` — separate Settings window.
- `main/windows.ts` — creation/management of the main `BrowserWindow` (skins) and of the Settings window, so `main.ts` is not weighed down.
- `main/tray.ts` — isolated tray logic.
- `budget.ts` — extended for multiple windows, efficiency, projection, estimated autonomy (still a pure module, tested by `budget.test.ts` as required in `PLAN.md`).

Further additions on Day 2, Session 1 (real services layer):
- `main/claude-auth.ts` — Claude session capture through an embedded login `BrowserWindow` (classic or SSO), never asked to the user in clear.
- `services/_http.ts` — HTTP helper shared by the services (explicit timeout, readable errors, never a silent `null` — CLAUDE.md rule).
- Migration to TypeScript (user feedback, after Day 2 Session 1): every file converted to `.ts`, shared types in `types/index.ts`, tests with `node:test` (`budget.test.ts`, `services/*.test.ts`, `tests/integration/*`). Details in CLAUDE.md, "Build and test".
- `store.history.lastGood.<accountId>` — cache of the last successful snapshot per account, used as a fallback when a fetch fails (shown in the UI with its timestamp and a "data not up to date" note).

Later additions are listed in the `CLAUDE.md` file structure (account registry and providers, store normalization, i18n, update check).

---

## Open questions confirmed before writing the code (historical)

1. Generalize `fetchUsage()` to the multi-window model (§0), or start with a simplified version (one "main" window per service)? → multi-window, adopted.
2. Is the efficiency formula in §3 useful as is? → adopted.
3. Confirm the proposed additions (estimated autonomy days, peak vs average, streak, combined view)? → the first three implemented.
4. Tray: "left click = toggle, right click = menu" on every platform? → adopted, with show/hide also as a menu entry.
