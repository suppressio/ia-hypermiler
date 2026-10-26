🌐 **English** | [Italiano](SPIKE-CLAUDE-USAGE-PTY.it.md)

# Spike #141 — Claude quotas from `claude /usage` in a PTY

> Part of #139. Status: **done on Linux, go.** Windows (ConPTY) and macOS are still untested.

## Setup

First run (2026-10-26, unattended agent) had no Claude login and stopped at "Select login method". Rerun the same day on a signed-in Linux machine (Debian testing, Claude Code 2.1.311, claude.ai Max login), with `scripts/spikes/claude-usage-pty.py`: Python `pty.fork()`, 50×140 window, `TERM=xterm-256color`, `--settings '{"disableAllHooks":true}'`, cwd in a scratch folder, then type `/usage` + Enter and kill the process.

## Results

| Question | Answer |
|---|---|
| Does a PTY drive work? | Yes. The TUI starts, the slash menu opens, `/usage` opens the *Usage* tab of the settings panel. |
| Fields shown | `Current session` (5h window) and `Current week (all models)`, each with `NN% used` and `Resets <time> (<IANA zone>)`, e.g. `Resets 12:10am (Europe/Rome)`, `Resets Oct 28, 10pm (Europe/Rome)`. Below: `Usage credits` (on/off), a local "what's contributing" breakdown (not needed). Per-model weekly lines did not show on this account; the parser keeps any `<label>` + `NN% used`, so they would be picked up. |
| Does `/usage` consume quota or call a model? | No. The same panel shows `Total cost: $0.0000`, `0 input, 0 output` tokens, and 21% / 41% stayed identical over 5 probes. |
| Does it leave a session file? | No: no transcript under `~/.claude/projects` for the probe folder (no message is sent). It does touch Claude's own state on startup (`.claude.json` backup, changelog cache, skills/plugin sync), as any start would. |
| Cost per probe | ~8.6 s wall (3 s start wait) and ~1.9 s CPU (user+sys, Python + `claude`). At the app's 30 min refresh this is ~0.1% of one core. |
| Polling interval | 30 min default, never below 5 min. A probe is a full Claude Code start, not a cheap HTTP call. |
| Not signed in | Screen shows `Select login method`: report "not signed in", not a parse error. |
| Gotchas | Strip `CLAUDE_CODE_*` from the child env when the app itself runs inside Claude Code (inherited markers change behaviour, e.g. "transcript saving is off"). `--no-session-persistence` is rejected outside `--print`. Strip ANSI/OSC; cursor moves glue words together (`21%used`), so match with `\s*`. |
| Parse stability | It is a TUI, not an API. Keep a raw screen fixture per Claude Code version and fail loudly (format drift) when neither window is found. |

## Decision

- **Primary source: `/usage` in a PTY.** The numbers come from the server, so they are right whatever client the user works in (including the VS Code extension, which does not run the status line).
- **Fallback for terminal-only users:** status line forwarding (`rate_limits.five_hour` / `seven_day`), free and push-based, but not available in the VS Code extension (anthropics/claude-code#21943).
- **Hard rules:** run only the unmodified `claude` binary with the user's own sign-in; never read its credential files; never ask the user to sign in inside our app (#140). Scratch working directory, hooks disabled, process killed after each read, timeout with a clear "not ready" state (first-run or update prompts can block the PTY).
- **Go core (#139):** `creack/pty` on Linux/macOS and a ConPTY library on Windows. Both are new dependencies: ask before adding. Windows and macOS need their own probe run.

## Prototype

`scripts/spikes/claude-usage-pty.py` — throw-away, Python, POSIX only, not part of the build, lint or tests. `--raw` prints the cleaned screen; extra `claude` flags go after `--`.
