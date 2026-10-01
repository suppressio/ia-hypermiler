🌐 **English** | [Italiano](EVOLUTION.it.md)

# EVOLUTION.md — Future directions and cost/benefit analysis

> A tracking document, not a design one. Unlike `ARCHITECTURE.md` (what is being built) and `RESEARCH.md` (real API constraints), this file collects a conceptual retrospective opened by the user after the MVP: evolution directions for the project **not yet decided nor scheduled**, with a first cost/benefit evaluation to guide priorities. It is updated when new considerations emerge or when a direction moves from "evaluated" to "decided" (at that point the decided part moves into `ARCHITECTURE.md`/`CLAUDE.md` like any other feature).

---

## Baseline frame (assumptions confirmed by the user, 2026-08-31)

These assumptions correct/narrow the scope compared with a first, more "open" reading of the directions below — they must be kept in mind in every later evaluation:

- **The user is and remains the developer**, owner of their own credit budget (bought, obtained with a free plan, or assigned by their company). There is no multi-user audience to serve.
- **An agent or an external CLI reading the app's data acts on behalf of the developer**, it is not a foreign consumer — an extension of the same user, not a third-party audience owed a contract that stays stable over time. This lowers the perceived cost/risk of a local API (point 2 below), but does not remove it: an unauthenticated local process can still be reached by any other process on the same machine, not only by the developer's tools.
- **A large transformation is fine**, not just an internal refactor — the user explicitly calls it an **evolution**, not a problem to minimize.
- **Inherited technical debt is to be paid off along the way**, not all at once (e.g. the open bug of the Copilot tab after login, `workSchedule.hoursPerDay` not used yet by `budget.ts`) — no urgency stated on these, they stay in the `CLAUDE.md` log.
- **The interface is considered relatively mature** (skins, dragging, tabs, icons — recent work judged enough for now). The most felt gap is not the UI itself but that the content shown stays too close to what Anthropic already offers in its own dashboard.

---

## The 5 directions

1. **Move away from the provider's view.** The goal is not to show the same numbers/charts Claude or GitHub already expose in their dashboards, but to decide independently which data really helps efficiency. The existing derived metrics (`efficiencyIndex`, instant/sustainable gauge, star rating, `generateDailyTip`) already go this way; still a direct copy of the provider UI are the "Weekly trend" chart (the same bar-chart-per-day as claude.ai) and the per-quota-window tabs (a plain side-by-side of the two metrics Anthropic exposes).

2. **Separate data/backend from the UI, with an internal API.** `main.ts` today mixes fetch orchestration, snapshot computation (`computeAccountSnapshot`/`computeWindowSnapshot`) and IPC/broadcast in the same file, with the snapshot computation written against the Electron store (not pure like `budget.ts`). The goal is for data to come before the interface — the UI is a "courtesy", not the product. The app must be able to live in the system tray only (the main process already runs headless with the window closed — that part exists), exposing the same data outside its own renderer too: an agent building its own MCP on top, or an independent client written by others (e.g. a Go CLI), both always on behalf of the developer who owns the data.

3. **Multi-provider genericity (OpenAI, z.ai, others).** The contract already imposed by CLAUDE.md (`fetchUsage(credentials): Promise<RawAccountUsage>` with a normalized `QuotaWindow`) is already a suitable base to add new providers at the single-service level. The real bottleneck is higher up: `AppSettings.accounts` has only two named slots (`claude`/`copilot`), not a dynamic registry — and so do the Settings panels and the account tabs in the widget.

4. **Redefine "efficiency" from pacing to value per token.** `efficiencyIndex`/`efficiencyRating` measure today how much the real consumption pace deviates from an ideal pace that avoids running out of quota — not whether that consumption is well spent. The signal for a value-per-token analysis already exists but is isolated: `services/claudeLocalSessions.ts` reads context size, session length, tool/MCP usage, but today it is an informational panel disconnected from the quota consumption numbers (and it covers only Claude, not Copilot). The leap in value would be crossing the two sources for actionable advice ("you consume fast *because* X") instead of just a thermometer.

5. **Electron's resource cost, even with the window closed.** Even in tray-only mode the main process and much of the Chromium/GPU runtime stay resident to keep the icon and polling alive — a conceptually simple workload pays the overhead of a full browser. It ties into point 2: if the core is extracted as a standalone Node process, the always-on piece might no longer be Electron. A trade-off not to underestimate: the tray icon and auto-start at login are provided for free and cross-platform by Electron today; removing it from the always-on piece means reimplementing them per platform.

---

## Points of attention from the "outside" analysis

- The 5 points are not independent initiatives: they are the same direction (from "widget" to "personal data platform about AI usage, with the UI as one client among many") seen from 5 angles.
- The structural irony of point 2: the app already has a whole diagnostics discipline for when *a provider's API* changes format under it (`FormatDriftError`). If the app itself becomes an API consulted by other developer tools, it will face the same problem in reverse (stability of its own contract over time) — there is no thinking on how yet.
- A non-trivial tension between points 1/3 (parity between providers) and point 4 (the richest insight exists only for Claude via local files): the more is invested in deep analysis, the more asymmetric the product becomes in favour of Claude.
- Point 5 is an unmeasured hypothesis today: nobody has verified how much RAM/CPU the app really uses in tray-only mode on a real machine — before investing in a solution (expensive: independent daemon + packaging/auto-start per platform), the problem is worth quantifying.
- There is a low-cost alternative for much of the need in point 2: an on-demand headless CLI command (e.g. `--json`/export) instead of an always-on server with network authentication — see row "2b" in the table below.

---

## Cost/benefit evaluation

| # | Direction | Benefit | Cost | Risk | Dependencies |
|---|---|---|---|---|---|
| **1** | Move away from the provider's view (own chart/tabs, not a copy of Anthropic) | High — really sets the product apart from the Anthropic dashboard; the derived metrics already exist, the right visual hierarchy is missing | Low — no new infrastructure, mainly deciding what to promote and what to demote in the UI | Low, reversible | None — can start right away |
| **2a** | Extract a pure core (fetch+snapshot) from `main.ts` | Medium directly, high as a prerequisite — unlocks 2b/2c, testability, reuse | Medium — a real refactor, but covered by 91+ existing tests, low regression risk | Low | None |
| **2b** | On-demand headless CLI (`--json`/export) invoked by the developer or their agent | High for its cost — covers "the agent does the developer's bidding" with no network, ports, daemons | Low, builds on 2a | Low — no new network surface | 2a |
| **2c** | Always-on local HTTP server (continuous/remote access) | High but only if continuous access is really needed, not on demand | High — local authentication still needed, lifecycle management, unresolved whether it lives inside or outside Electron | Medium — new resident surface | 2a, and only if 2b proves insufficient |
| **3** | Multi-provider genericity (schema/UI) | Low today — no second real provider connected yet | Medium if done now on its own; much lower if done together with the 2a refactor | Risk of over-engineering for a hypothetical need | Better done during 2a, not as a separate intervention |
| **4** | Redefine efficiency: pacing → value per token | High — the closest to the app's stated purpose | Medium-high — crossing two sources separated today, risk of weak correlations if rushed | Medium — a bad insight undermines trust more than no insight | Pays off more after point 1 |
| **5** | Reduce Electron's cost in tray-only mode | Unknown — nobody has measured how much it really weighs today | High if really solved (independent daemon + packaging/auto-start for 3 OSes) — the most expensive item on the list | High: risk of investing heavily in a problem that may be more theoretical than real | None for the measurement; 2a if it is then decided to act |

---

## Suggested sequence

1. **Point 1** — low cost, high benefit, no dependency.
2. **2a**, together with **point 3** — touch the account schema once, not twice.
3. **2b** — almost free once 2a is done.
4. **Point 4** — after point 1, so as not to repeat the mistake of the disconnected panel.
5. **Point 5** — measure real tray consumption first, then possibly act (the most expensive of all).
6. **2c** — only if, after using 2b for a while, a real need for continuous/remote access emerges.

---

## Status (updated 2026-09-30)

The user's choice: evolve the app "along with my usage", **without upending its architecture** — hence points 1, 3 and 4, feasible within the current structure (Electron + main.ts + IPC + store). 2a (core extraction) was not done: point 3 was achieved without it, at a contained cost. Sequence executed: issue #3 → point 3 → point 1 → point 4, one commit per phase.

| # | Status | What was done |
|---|---|---|
| **1** | ✅ done | "Daily consumption vs budget" chart (delta per day + ideal share, `budget.dailyDeltas`) instead of the cumulative %; window list with a verdict computed by the app (`budget.windowVerdict`) instead of tabs; peak/average and streak computed on deltas (on the cumulative value they were effectively wrong). |
| **3** | ✅ done (with issue #4) | Registry of N provider-independent accounts (`AccountConfig[]`, common part + specific part), `main/providers.ts` for everything provider-dependent, accounts table in Settings, automatic migration from the two-slot schema (`store/migrate.ts`). One Electron partition per Claude account: fixes the logout bug that did not clear the session. Adding a new provider (e.g. OpenAI) = a service with `fetchUsage` + a branch in each function of `main/providers.ts` + a detail template in `settings.html`. |
| **4** | ✅ done (first version) | "Yield" (output tokens per 1% of quota, with trend) and a causal tip about large context, shown only with a clear signal. The **tension** noted above remains: it exists only for Claude (the only local source). Known limit: a session is attributed to the day it was last modified (the SDK does not expose message times). |
| 2a/2b/2c, 5 | ⏸ not addressed | As in the suggested sequence; point 5 must be **measured** before any intervention. |

## Open questions / next step

- Check with real usage whether the `consumptionCause` thresholds (≥5 days, ≥1.5×, ≥20 points) are too strict (the sentence never appears) or too loose.
- Measure point 5 (RAM/CPU in tray-only mode) before deciding whether to tackle 2a/5.

## Update (2026-10-01): 2a becomes the next step

The user's next request — making the app more robust and moving to test-driven development — changed the priority of **2a**: without extracting from `main.ts` a pure core (with the store injected), the orchestration logic cannot be tested without starting Electron, so test-first work is not possible. Done meanwhile: stricter TypeScript, type-aware ESLint at zero findings and gating in CI, store normalization, IPC input validation. Agreed order: first a single IPC contract (channels + types shared by main, preload and renderer), then the core extraction (2a), with tests written first to pin the current behaviour. 2b stays "almost free" once 2a is done.
