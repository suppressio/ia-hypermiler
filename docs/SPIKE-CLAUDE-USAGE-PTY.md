🌐 **English** | [Italiano](SPIKE-CLAUDE-USAGE-PTY.it.md)

# Spike #141 — Claude quotas from `claude /usage` in a PTY

> Part of #139. Status: **inconclusive, needs one run on a signed-in machine.** The spike environment had Claude Code 2.1.288 but no Claude login (`claude auth status` → `loggedIn: false`), and signing in is not something an unattended agent can or should do. What follows separates what was **verified** from what is **still a hypothesis**.

## Verified (2026-10-26, Linux, Claude Code 2.1.288)

- A PTY drive works: Python `pty.fork()` + `TIOCSWINSZ` (50×140) + `TERM=xterm-256color` starts the interactive TUI, which renders fully and accepts keystrokes. Output needs ANSI/OSC stripping (`scripts/spikes/claude-usage-pty.py`).
- Cold start to a drawn UI takes a few seconds; the probe waits ~8 s before typing.
- Without a login the TUI stops at the first-run flow (theme choice, then "Select login method"). `/usage` is never reachable there. So a probe must treat "not signed in" as its own state (the screen contains `Select login method`) and report it, not as a parse failure.
- `--settings '{"disableAllHooks":true}'` is accepted at startup.

## Not verified (to do on a signed-in machine)

Run `python3 scripts/spikes/claude-usage-pty.py --raw` and record:

| Question | How to check |
|---|---|
| Fields shown (5h, 7d, per-model, extra usage, reset times) | read the `--raw` screen; then write the real parser (the current one is a guess) |
| Does `/usage` consume quota or call a model? | note the status line / `/usage` numbers before and after several probes; also check there is no assistant turn in the session list |
| Cost per probe | `time` the script; sample CPU of the `claude` process; note whether it leaves a session file behind |
| Safe polling interval | depends on the cost above; start from the app's 30 min refresh, no faster than 5 min |
| Windows (ConPTY), macOS | `pty` is POSIX only; in Go use a ConPTY library on Windows and `creack/pty` on Linux/macOS (new dependencies: ask first) |
| Parse stability across versions | save the raw screen per Claude Code version; the parser must fail loudly (format drift, like `FormatDriftError`) when no window is recognized |

## Proposed decision (provisional)

- **Primary source:** `/usage` in a PTY, if the checks above show it costs no quota and well under a second of CPU per probe. The numbers come from the server, so they are right whatever client the user works in (including the VS Code extension, which does not run the status line).
- **Fallback for terminal-only users:** status line forwarding (`rate_limits.five_hour` / `seven_day`), free and push-based, but not available in the VS Code extension (anthropics/claude-code#21943).
- **Hard rules:** run only the unmodified `claude` binary with the user's own sign-in; never read its credential files; never ask the user to sign in inside our app (#140). Probe in a neutral working directory, with hooks disabled, and kill the process after each read.
- **Risks to measure:** the panel is a TUI, not an API, so wording or layout can change between versions; a probe could leave session files that the local insights then count; a first-run or update prompt can block the PTY (needs a timeout and a clear "not ready" state).

## Prototype

`scripts/spikes/claude-usage-pty.py` — throw-away, Python (no Go toolchain in the spike environment), POSIX only, not part of the build, lint or tests. The parser is untested against real output.
