🌐 **English** | [Italiano](PLAN.it.md)

# IA Hypermiler — Development plan (3 days)

> **Historical document:** the initial plan, kept as it was. For the current state see the milestones in `CLAUDE.md` and the directions in `EVOLUTION.md`.

> **Stack:** Electron · Node.js · vanilla HTML/CSS/SVG · Anthropic SDK · electron-store · electron-builder
> **Target:** Cross-platform (Windows, macOS, Linux)
> **Pace:** ~4-5 hours a day

---

## Before starting — one-off setup (30 min, outside the 3 days)

Create the project structure and the `CLAUDE.md` file that guides Claude Code for the whole session.

```
ia-hypermiler/
├── CLAUDE.md               ← project memory for Claude Code
├── main.js                 ← Electron main process
├── preload.js              ← secure renderer ↔ main bridge
├── renderer/               ← UI (vanilla HTML + CSS + JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── agents/                 ← Claude agents
│   └── advisor.js
├── services/               ← token data fetch
│   ├── claude.js
│   └── copilot.js
├── store/                  ← local persistence (electron-store)
│   └── index.js
└── package.json
```

---

## Day 1 — API research + Electron skeleton

**Goal:** understand what can really be read from the APIs, and have the app start with mock data.

### Session 1 · API research with an agent (1.5 hours)

The most critical session: a Claude Code agent with web search and filesystem access answers concrete questions **before a single line of code is written**.

**Prompt for the agent:**

> Search GitHub, the official Anthropic and Microsoft forums, public documentation and open source repositories (terms: `Claude API usage tokens`, `Anthropic usage endpoint`, `Copilot token consumption API`, `GitHub Copilot billing API`, `copilot-usage-action`) for how to retrieve the current token consumption and monthly quota of a Claude Pro account and a GitHub Copilot account.
>
> For each one tell me: the exact endpoint or URL to scrape, the required authentication (API key, OAuth, session cookie), how often the data is updated, the response format (JSON, HTML, other). If there is no official endpoint, tell me the workaround most used by the community.
>
> Write the results in `RESEARCH.md`.

**Likely scenarios to keep in mind:**

- **Claude:** the Anthropic API exposes no public usage endpoint for Pro users. The most common workaround is parsing the `console.anthropic.com/settings/usage` page with an authenticated session (cookie). For Team/Enterprise plans there is `GET /v1/usage` — the agent will look for up-to-date confirmation.
- **Copilot:** GitHub exposes `GET /orgs/{org}/copilot/usage` for organizations, but not for personal accounts. The workaround is the `github.com/settings/billing` page. The agent will check what changed recently.

> ⚠️ **Main risk:** if neither API exposes useful data and the workaround is fragile, better to know right away and reduce the scope to a single service (preferably Claude).

The agent produces `RESEARCH.md`. That document drives the Day 2 architecture.

---

### Session 2 · Electron skeleton with mock data (2.5 hours)

With Claude Code in **plan mode**, build the app shell fed by hard-coded fake data.

**`main.js`**
- Main window 800×600
- `Tray` icon with a context menu (show/hide/quit)
- `ipcMain` for the data channels

**`preload.js`**
- Expose only the needed channels via `contextBridge`
- Never `nodeIntegration: true`

**`renderer/`**
- UI with three blocks: tokens today, weekly chart, monthly projection
- Chart in vanilla SVG/Canvas — zero external libraries (Electron is heavy enough)

**`store/index.js`**
- `electron-store` to persist: API key, renewal date, monthly quota

**✅ End of Day 1:** app starts with `npm start`, working tray icon, UI visible with mock data.

---

## Day 2 — Real data integration + advice agent

**Goal:** replace the mocks with real data and integrate the agent that generates advice.

### Session 1 · Services layer (2 hours)

Based on `RESEARCH.md`, implement the two services with a uniform interface:

```js
// Interface expected from both services
export async function fetchUsage(credentials) {
  // Returns: { used, total, resetDate, dailyHistory: [...] }
}
```

**Authentication:**
- API key → store it in `electron-store` with `encryptionKey`, never expose it to the renderer
- Session cookie → use the Electron session or a hidden `BrowserWindow` for the OAuth login; never ask the user to paste cookies by hand

Test each service from the terminal with `node services/claude.js` before wiring it into Electron.

---

### Session 2 · Budget logic + advisor agent (2 hours)

**Computation logic (`budget.js`):**

```js
function dailyBudget({ used, total, resetDate }) {
  const daysLeft = differenceInDays(resetDate, today());
  const remaining = total - used;
  return Math.floor(remaining / daysLeft); // tokens/day
}
```

**Advice agent (`agents/advisor.js`):**
- Anthropic API call with the consumption of the last 7 days as context
- System prompt asking for practical, specific advice (not generic)
- Result cached in `electron-store`, refreshed once a day
- Shown in a "Tips of the day" panel in the UI

**✅ End of Day 2:** real data in the UI, correct budget computation, advice generated by the agent.

---

## Day 3 — Polishing, notifications, build

**Goal:** robust app, useful notifications, distributable package.

### Session 1 · Notifications and robustness (2 hours)

- **System notification** (Electron `Notification` API) when daily consumption passes 80% of the budget
- **Error handling:** if the APIs do not answer, show the last known data with a timestamp — never a blank screen
- **Auto-refresh** every 30 minutes in the background via `setInterval` in the main process (even without an open window)
- **Onboarding:** at first start, a configuration window for API key and renewal date

---

### Session 2 · Subagent review + Build (2 hours)

**Code review subagent** before the build:

> Read every file in `agents/`, `services/` and `main.js`. Report: API calls without a timeout, secrets exposed to the renderer, non cross-platform paths, memory leaks in setInterval. Write the fixes directly.

**Cross-platform build with `electron-builder`:**

```json
"build": {
  "appId": "com.yourname.ia-hypermiler",
  "mac":   { "target": "dmg" },
  "win":   { "target": "nsis" },
  "linux": { "target": "AppImage" }
}
```

> 💡 On GitHub Actions the multi-platform build can run in parallel — the fastest way to get `.dmg`, `.exe` and `.AppImage` from the same commit without three physical machines.

**✅ End of Day 3:** buildable app, working notifications, code reviewed by the agent.

---

## Reference stack

| Component | Choice | Reason |
|---|---|---|
| Shell | Electron | already known, cross-platform |
| UI | vanilla HTML/CSS/SVG | no bundle, fast startup |
| Persistence | electron-store | simple, encryptable |
| Advice agent | Anthropic SDK (Node) | already used in the course |
| Build | electron-builder + GH Actions | multi-platform without VMs |
| Claude Code | plan mode + subagent review | as in the course |

---

## Left out (to evaluate later)

- Native OAuth authentication for Copilot (if the cookie workaround is not stable enough) — *later implemented as an experimental alternative to the PAT*
- Multiple accounts (several API keys / several services) — *later implemented (issue #4)*
- App auto-update (`electron-updater`) — *later implemented as an update check + browser download, without electron-updater (issue #5)*
- Historical chart beyond 7 days — *later implemented (30-day view)*
- Advanced native tray integration (animations, counter badge)
