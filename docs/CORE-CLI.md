🌐 **English** | [Italiano](CORE-CLI.it.md)

# Go core CLI

> Implemented in #26: transport-neutral JSON contract v1 and terminal output for layer 1 of #139. Real providers arrive separately.

## Commands and scope

```text
hypermiler usage <provider> [--json] [--timeout <duration>] [--secret-stdin] [provider flags]
hypermiler version [--json]
hypermiler help
```

The CLI fetches on demand and exits. There is no server, port, daemon, shared store or pacing snapshot. #31 will serve the same documents over HTTP; #177 adds the TypeScript client. The registry is currently empty: `hypermiler usage codex` fails with exit 2, `Unknown provider: codex`. Provider account flags are added by #148 (Codex) and #149 (Copilot); none are registered yet. Tests register a synthetic provider named `fake`.

Put the provider before its flags. Unexpected positional arguments and unknown flags are usage errors.

| Common flag | Behavior |
|---|---|
| `--json` | Write one compact JSON document plus a single newline to stdout; stderr carries logs only. A standard boolean flag (`--json=false` means text, the last occurrence wins); for an invocation that fails before or during flag parsing it is recognized anywhere in the arguments, so the usage error is a JSON document too. |
| `--timeout <duration>` | Fetch deadline, default `25s`; must be greater than zero and at most `2m`. Uses Go durations, e.g. `50ms`, `10s`. Providers must honor the context deadline. |
| `--secret-stdin` | Read stdin only if the provider accepts secrets. At most 64 KiB including a trailing newline; remove one final CRLF or LF, preserving other whitespace. Empty input, read failures and oversized input are usage errors. |

Secrets are accepted only on stdin, never as flags: argv is visible in the process list. Account parameters belong in provider flags, credentials do not. Without `--secret-stdin`, stdin is not read and Fetch receives an empty secret. The CLI redacts the supplied secret from provider error messages and stale reasons; providers must keep credentials out of all returned usage fields, diagnostic endpoint labels and messages.

## Text output

Default output is for people and terminal agents, **not a stable contract**. One line per window, for example:

```text
Codex · 5h 21% · resets 22:10
Copilot · Monthly credits 250/1000 (25%) · resets 2026-11-30 22:10
```

Rolling windows use `<n>h` or `<n>d`; billing windows use their label. Percentage windows already contain percentages; count windows show `used/total (percentage%)`, or only `used` if total is null. Percentages round to the nearest integer. A zero total shows `used/0` without an undefined percentage. Resets within the next 24 hours use local `HH:mm`; at exactly 24 hours, later, or in the past they use `YYYY-MM-DD HH:mm`. Missing resets omit that part. Stale values append ` · stale` to each line. Zero windows produce `<Display> · no quota windows` (also suffixed when stale). Text provider errors go to stderr as one line `<provider>: <message>`; usage errors also print help.

## JSON contract v1

All dates are RFC 3339 UTC strings with `Z`, at second precision. All keys of `RawAccountUsage` and `QuotaWindow` are always present: unknown nullable fields are `null`, never omitted. `quotaWindows` is always an array, including `[]`. JSON field names, enum values and error codes are language-neutral; clients must not parse human-readable labels or messages.

### Envelope fields

| Field | Type / presence | Meaning |
|---|---|---|
| `schemaVersion` | integer, always `1` | Contract version, independent of the binary version. |
| `provider` | string, success/provider error only | Registered provider ID; omitted for usage errors. |
| `fetchedAt` | ISO string, success only | CLI clock immediately after Fetch returns, including stale results; not the original freshness timestamp of cached values. |
| `stale` | boolean, success only | Provider returned last known values rather than fresh values. |
| `staleReason` | `{code, message}`, only when stale | Reason for fallback, using provider error codes. No endpoint or shape here. |
| `usage` | `RawAccountUsage`, success only | Provider data, without pacing or history. |
| `error` | object, errors only | Stable `code` and readable `message`; format drift also has `endpoint` and `shape`. |
| `name`, `version`, `os`, `arch` | strings, version document only | Binary identity, build-time version (default `dev`), Go OS and architecture. |

### Usage and quota fields

| Object / field | Type | Meaning |
|---|---|---|
| usage.`planTier` | string or null | Provider plan name. |
| usage.`subscriptionRenewsAt` | ISO string or null | Provider subscription renewal. |
| usage.`quotaWindows` | array of quota windows | Reported limits, possibly empty. |
| window.`id` | string | Window identifier. |
| window.`label` | string | Display label. |
| window.`periodType` | `rolling-hours`, `rolling-days`, `billing-cycle` | Reset model. |
| window.`periodLength` | number or null | Hours, days, or months for billing cycles; null if unknown. |
| window.`unit` | `percentage` or `count` | How to read used/total. |
| window.`used` | number | Already a percentage for percentage windows; absolute consumption for count windows. |
| window.`total` | number or null | Total quota when known. |
| window.`resetsAt` | ISO string or null | Window reset time. |

### Full document examples

These are the normative single-line fixtures from `gocore/contract/v1/`; no README or Go package is needed in that directory. Provider `fake` and all values are synthetic.

#### Success with percentage windows

```json
{"schemaVersion":1,"provider":"fake","fetchedAt":"2026-10-31T21:10:00Z","stale":false,"usage":{"planTier":"plus","subscriptionRenewsAt":null,"quotaWindows":[{"id":"five-hour","label":"5 hours","periodType":"rolling-hours","periodLength":5,"unit":"percentage","used":21,"total":100,"resetsAt":"2026-10-31T22:10:00Z"},{"id":"weekly","label":"7 days","periodType":"rolling-days","periodLength":7,"unit":"percentage","used":42,"total":100,"resetsAt":"2026-11-07T21:10:00Z"}]}}
```

#### Success with a count window

```json
{"schemaVersion":1,"provider":"fake","fetchedAt":"2026-10-31T21:10:00Z","stale":false,"usage":{"planTier":null,"subscriptionRenewsAt":"2026-11-30T21:10:00Z","quotaWindows":[{"id":"credits","label":"Monthly credits","periodType":"billing-cycle","periodLength":1,"unit":"count","used":250,"total":1000,"resetsAt":"2026-11-30T21:10:00Z"}]}}
```

#### Success with last known values

```json
{"schemaVersion":1,"provider":"fake","fetchedAt":"2026-10-31T21:10:00Z","stale":true,"staleReason":{"code":"unavailable","message":"Provider is temporarily unavailable"},"usage":{"planTier":"plus","subscriptionRenewsAt":null,"quotaWindows":[{"id":"five-hour","label":"5 hours","periodType":"rolling-hours","periodLength":5,"unit":"percentage","used":21,"total":100,"resetsAt":"2026-10-31T22:10:00Z"},{"id":"weekly","label":"7 days","periodType":"rolling-days","periodLength":7,"unit":"percentage","used":42,"total":100,"resetsAt":"2026-11-07T21:10:00Z"}]}}
```

#### Signed out

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"signed_out","message":"Sign in required"}}
```

#### Not ready

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"not_ready","message":"Usage is not ready yet"}}
```

#### Timeout

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"timeout","message":"Request timed out"}}
```

#### Format drift

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"format_drift","message":"Unrecognized usage response","endpoint":"/usage","shape":{"active":"boolean","items":[{"remaining":"number"}],"label":"string","reset":"null"}}}
```

#### Unavailable

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"unavailable","message":"Provider is temporarily unavailable"}}
```

#### Usage error

```json
{"schemaVersion":1,"error":{"code":"usage","message":"Unknown provider: codex"}}
```

#### Version

```json
{"schemaVersion":1,"name":"hypermiler","version":"dev","os":"linux","arch":"amd64"}
```

### Error codes and client behavior

| Code | Meaning | Client action |
|---|---|---|
| `signed_out` | No usable authenticated session. | Show sign-in state, not a generic error. |
| `not_ready` | The provider has not produced usage yet. | Retry later. |
| `timeout` | The fetch deadline expired, including wrapped context deadlines. | Keep last values as stale and retry later. |
| `format_drift` | The response structure is no longer recognized. | Offer a drift report using endpoint and shape only, never response values. |
| `unavailable` | Other provider/network failure. | Keep last values as stale and retry later. |
| `usage` | Invalid CLI invocation; only exit 2 documents. | Correct the arguments before retrying. |

`shape` preserves sorted field names and type names (`string`, `number`, `boolean`, `null`), replaces arrays with one representative element (or `[]`), and uses `truncated` beyond depth 4. It never contains response values. Providers pass decoded JSON through `usage.ExtractShape` and must supply safe messages and endpoint labels without account IDs or credentials.

### Exit codes

| Exit | Meaning |
|---|---|
| `0` | Success, including stale values, help and version. |
| `1` | Provider error. Output write failures also return 1 and log the failure. |
| `2` | Usage error: unknown provider/command, bad flags, extra arguments, invalid timeout or secret input. |

With `--json`, usage errors have no provider key. Help is text-only; requesting help with `--json` produces a usage-error document. Without `--json`, help/version retain their plain text behavior.

## Versioning and shared fixtures

Additive fields keep `schemaVersion: 1`; clients must ignore unknown fields. Removing or renaming a field, or changing its meaning, bumps the schema version. A client seeing an unsupported schema version must reject the document explicitly. An unknown error code is treated as `unavailable`, preserving last values as stale.

The language-neutral files in `gocore/contract/v1/` are normative examples. Go CLI black-box tests reproduce every fixture byte for byte through `RunWith`, a fake provider and a fixed clock. The TypeScript client tests added in #177 will read the same files. `version.json` uses `hypermiler`, `dev`, `linux`, `amd64`; its Go test substitutes `buildinfo.Name`, `buildinfo.Version`, `runtime.GOOS` and `runtime.GOARCH` before the byte comparison so build-time versions and cross-platform runs are supported. Every fixture is also checked as valid compact JSON with `schemaVersion: 1` and exactly one trailing newline.
