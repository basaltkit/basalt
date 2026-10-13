# RFC 0008 — `basalt-deploy` machine protocol: `--json`, `--answers=stdin`, detached runs

- **Status:** Accepted — implemented in `@basaltkit/deploy` 0.5.0 (2026-10-13); where the code differs from this text, §17 says so
- **Author:** Marcio Zebedeu
- **Date:** 2026-10-13
- **Affects:** `@basaltkit/deploy` only (the CLI, `Host`, the pipeline's step reporting, the lock holder, the audit record). No runtime package, no AI package.
- **Builds on:** RFC 0006 (the pipeline; §14 phase-0 hardening), RFC 0007 (`check`, `init`, `bootstrap`)
- **Non-negotiables honoured:** no HTTP surface, no daemon, no listening socket; nothing runs inside the booted app; root never runs the app user's code; secrets never on a command line, in an event, in a log or outside a `0600` file; fail-closed

---

## 0. TL;DR

Phase 2 will ship a **local** UI that drives a server the only way an operator
already can: `ssh` as the app user, then `basalt-deploy <command>`. For that the
CLI needs a contract a program can read. This RFC specifies it:

1. **`--json`** (§3–§5): on the app user's read and deploy commands, stdout
   carries **only** NDJSON events, one per line, in a versioned envelope
   `{v:1, type, ts, seq, …}`. Human text is not written in this mode.
2. **Secret safety at one choke point** (§6): every string of every event goes
   through a redactor before serialisation; secret prompts carry no default and
   no value; children's output is wrapped in `log` events, never passed through
   and never interpreted.
3. **`--answers=stdin`** (§7): answers arrive as NDJSON on stdin, validated
   strictly; a prompt nobody answers fails closed.
4. **Detached runs** (§8): `run --detach` / `rollback --detach` start the deploy
   in its own session (it survives an SSH disconnect), writing its events to
   `<stateDir>/runs/<runId>.ndjson`; `attach` resumes from any `seq`; `cancel`
   sends the phase-0 signal; `status` reports the active and the last run.

The UI gets no capability the SSH user does not already have. The server trusts
the protocol exactly as much as it trusts the same user typing at a terminal.

**Not in this RFC:** the UI itself (phase 2), `--json` for root's commands
(§9), any server-side listener, an `ssh2` dependency, any AI or MCP tool.

## 1. What the code does today (the ground this builds on)

| Fact | Where | Consequence for `--json` |
|---|---|---|
| Every side effect goes through `Host`; all human text through `Host.out` (`step`, `info`, `ok`, `warn`, `error`), written to **stderr** by `consoleOutput` | `host.ts` | One decorator over `Host` can turn the whole pipeline into events; nothing in `pipeline.ts` writes to stdout |
| Only three stdout writers exist: `USAGE` (help/unknown command) and `install-plan --out=-` | `cli.ts:100,155,224` | All three are handled explicitly (§3.3) |
| `exec({ stream: true })` gives the child **fd 1 and 2 of the deploy** (`['ignore','inherit','inherit']`): `pnpm install`, prisma, the build, hooks, `docker build`, `compose up`, compose jobs, migrations | `host.ts` exec; `pipeline.ts` build/migrate/runHooks; `compose.ts:196,213,225` | Under `--json` a child would write raw text into the event stream: streamed children must be piped and wrapped (§5.3) |
| `deploy.config.ts` is imported **in-process** (`loadConfig`), and its functions (`env.derive`, `migrate.env`) run during the pipeline | `cli.ts` loadConfig; `env-step.ts` planEnv; `pipeline.ts` migrationValues | A `console.log` in the config lands on stdout: foreign stdout writes must be captured (§5.4) |
| Children never inherit stdin except `exec({ interactive: true })`, used only by `bootstrap` (root, out of scope) | `host.ts`; `bootstrap.ts:174,264` | Invariant to keep: the answers channel (secrets) is never readable by a child (§7.5) |
| The only prompts in app-user commands are the `.env` questions (`answerQuestions` → `host.prompt`, up to 3 attempts, the deploy's own environment answers first) | `env-step.ts:81` | These become `prompt` events (§7.2). `host.confirm` is called only by root's code (`apache.ts:201`, `caddy.ts:126`, `install-plan.ts:413,431,439`) |
| A git credential prompt is avoided when `!host.interactive()` (`NO_PROMPT`), and the preflight then reports the missing credentials as an error | `pipeline.ts:54,250,568` | `--json` makes `interactive()` false: no prompt can reach a human through git |
| There is **no output redaction** today. Phase-0 "masking" is the prompt's echo suppression (`muteEcho`) plus a discipline: messages name keys and line numbers, never values | `host.ts` muteEcho; `dotenv.ts`; `env-step.ts` describeEnv | Event-level redaction is new (§6), and is the safety net under that discipline, not a replacement |
| Errors are classes: `DeployLockedError` (exit 3), `DeployAbortedError` (130), `DeployError` / `DeployConfigError` (1), anything else (1, stack only with `BASALT_DEBUG`). A second signal calls `process.exit(130|129|143)` mid-step | `cli.ts` main; `host.ts` onSignal | The exit-code table (§4.4) is these, documented |
| `deploy.lock` holds `{pid, host, startedAt, actor, command}`, `O_EXCL`, read `O_NOFOLLOW`, removed by `unlink` only, stale takeover through `deploy.lock.takeover` | `lock.ts` | The detached child is the holder; the holder gains `runId` (§8.3) |
| Audit: `actor` (`--actor`, `$BASALT_DEPLOY_ACTOR`, `$USER`), `client` from `$SSH_CONNECTION`, `via` ∈ `ssh`/`ci`/`terminal`/`batch` | `audit.ts` | `via: 'ui'` is added (§8.6) |
| There is no `diff`, `preflight` or `logs` command. `diff.ts` is the line diff root's `install` shows; preflight runs inside `plan` and `run` | `diff.ts`, `pipeline.ts` | `plan --json` is the preflight/diff surface; `attach` is the run-log surface (§3.1) |

## 2. Goals and non-goals

**Goals.** A program can (a) read what any app-user command did, step by step,
without parsing English; (b) answer the `.env` questions without a terminal;
(c) start a deploy that a dropped SSH connection does not stop, and reconnect to
it without losing an event; (d) never learn a secret it did not itself send.

**Non-goals.** A server-side agent or panel; a network listener of any kind; an
API other than the CLI; remote root; replacing the terminal experience — with
neither flag, every command behaves byte-for-byte as today.

## 3. Commands and flags

### 3.1 Commands covered

| Command | `--json` | `--answers=stdin` | `--detach` | `result` payload |
|---|---|---|---|---|
| `status` | yes | — | — | §4.3 `StatusResult` |
| `check` | yes | — | — | `CheckResult` |
| `plan` | yes | — | — | `PlanResult` (includes the questions a `run` would ask) |
| `run` | yes | yes | yes | `RunResult` (or `DetachResult` with `--detach`) |
| `rollback` | yes | — (never asks) | yes | `RollbackResult` |
| `env` | yes | yes | no (§8.1) | `EnvResult` |
| `install-plan` | yes (§9) | — | — | `InstallPlanResult` |
| `attach <runId>` (new) | **only** with `--json` | — | — | none: replays the run (§8.4) |
| `cancel <runId>` (new) | yes | — | — | `CancelResult` |
| `init`, `install`, `bootstrap` | **refused** (§9) | — | — | — |

### 3.2 Flags

- `--json` — protocol version 1. `--json=1` is the same; any other value is
  refused (`error` `protocol-version`, exit 1) so a newer UI talking to an older
  server learns it at once. Phase 2 always sends `--json=1`.
- `--answers=stdin` — only with `--json` (refused otherwise: a human-mode prompt
  and a protocol channel on the same stdin cannot both be right). `stdin` is the
  only accepted value in v1.
- `--answer-timeout=<seconds>` — 1–3600, default 600; only with
  `--answers=stdin` (§7.4).
- `--detach` — only with `--json` and `run`/`rollback` (§8).
- `--via=ui` — only value accepted; recorded as the audit `via` (§8.6).
- `--from-seq=<n>`, `--follow` — `attach` only.
- `--run-id=<id>` — internal: set by the detaching parent on the child (§8.2).
  Refused when given by hand without the internal marker env var
  `BASALT_DEPLOY_DETACHED_CHILD=1`; neither carries a secret.

### 3.3 What changes on stdout and stderr under `--json`

- **stdout:** NDJSON events only. One event per line, `\n`-terminated, UTF-8,
  `JSON.stringify` (no raw control character can appear inside a line). The
  first line is always `hello`; the last line of a process that ends normally is
  always `done`.
- **stderr:** the tool writes nothing to it, except one plain line if the event
  writer itself fails (e.g. it cannot serialise). Node's own warnings may still
  appear there; the UI may show stderr as raw diagnostics and must never parse it.
- `-h/--help`, an unknown command, `install-plan --out=-` and `--out=<file>`
  together with `--json`: an `error` event (`usage`), exit 1 — `USAGE` is never
  written to stdout in this mode.
- A broken stdout (`EPIPE`, the SSH client gone) never fails the command: the
  writer stops writing to stdout and keeps writing the run log (§8.2). The
  phase-0 signal handling is what decides whether the command stops.

## 4. The event schema (v1)

### 4.1 The envelope

```ts
interface Envelope {
  v: 1
  type: EventType
  /** ISO-8601 UTC with milliseconds, from Host.now(). */
  ts: string
  /** 0, 1, 2, … per event stream; strictly +1, no gaps (see §4.5). */
  seq: number
  /** Set when the command writes a run log (run, env, rollback; §8.2). */
  runId?: string
  /** True when the redactor replaced anything in this event (§6). */
  redacted?: true
}
```

Readers ignore unknown fields (forward compatibility within v1); writers never
remove or retype a field within v1. A new event `type` is a minor addition: a
v1 reader skips types it does not know. Anything else is `v: 2`.

### 4.2 Event types

| `type` | Fields | When |
|---|---|---|
| `hello` | `tool: '@basaltkit/deploy'`, `version` (`VERSION`), `protocol: 1`, `command`, `pid`, `host` (`Host.hostname()`), `detached?: true` | First line, before the config is loaded (a config that fails to load still gets a `hello`, an `error` and a `done`) |
| `step-start` | `id: StepId`, `title` | A pipeline step begins |
| `step-end` | `id`, `status: 'ok'\|'failed'\|'skipped'\|'aborted'`, `durationMs` | It ends; every `step-start` has exactly one `step-end` unless the process is killed (§8.5) |
| `log` | `stream: 'tool'\|'child'\|'foreign'`, `level: 'info'\|'ok'\|'warn'\|'error'`, `text`, `redacted: boolean`, `step?: StepId`, `source?` (child's command basename, e.g. `pnpm`, `docker`), `truncated?: true` | `Host.out.info/ok/warn/error`; a line of a child's output; a foreign stdout write (§5.4) |
| `finding` | `id` (`C1`…`C11`, `git`, `backup`, `health`, `dumps`, …), `level: 'error'\|'warning'`, `message`, `fix?` | Each `Finding` passed to `report()` — structured, instead of the formatted `[id] message → fix` text |
| `prompt` | `id`, `kind: 'text'\|'secret'\|'confirm'\|'choice'`, `message`, `key?`, `optional`, `attempt`, `default?` (never for `secret`), `choices?` (`choice` only) | An answer is needed (§7.2) |
| `result` | `command`, `data` (per command, §4.3) | The command produced its payload |
| `error` | `code: ErrorCode`, `message`, `hint?`, `holder?` (`locked` only), `findings?` (the blocking ones) | The command failed or refused |
| `done` | `exitCode` | Last line |

`StepId` is a closed set, the steps `pipeline.ts` already has: `lock`,
`preflight`, `fetch`, `env`, `infra`, `build`, `validate`, `backup`, `migrate`,
`release`, `health`, `verify`, `record`, `restore` (`restoreCode`, after a
failure or in a rollback), `plan`, `check`. Today `step()` takes a title that is
the id for most steps; three places print a step with a computed title
(`restoring the code to <sha>`, `release <sha>`, `plan — nothing below has
run`, `<app> — last n release(s)`). The implementation gives `step()` an id and
an optional title, and those call sites an id (`restore`, `release`, `plan`,
none for `status`).

`ErrorCode`, from the existing error paths:

| Code | Raised by | Exit |
|---|---|---|
| `locked` | `DeployLockedError` | 3 |
| `aborted` | `DeployAbortedError` (first signal, at a step boundary) | 130 |
| `config` | `DeployConfigError` | 1 |
| `refused-root` | `refuseRoot` | 1 |
| `preflight` | `stopOnErrors` (`findings` carries the blocking ones) | 1 |
| `held` | `refuseHeld` | 1 |
| `release-failed` | `run`'s `recover()` (rolled back, or not because destructive/same sha), `public-unreachable`, an unhealthy rollback | 1 |
| `failed` | any other `DeployError` | 1 |
| `answer-missing`, `answer-invalid`, `answer-unknown`, `answer-timeout` | §7 | 1 |
| `protocol`, `protocol-version`, `usage`, `unsupported` | §3, §7.3, §9 | 1 |
| `not-found`, `detach-unconfirmed`, `run-vanished` | §8 | 1 |
| `unexpected` | anything else (the stack only with `BASALT_DEBUG`, as a `log` line, redacted) | 1 |

`DeployError` gains an optional `code` (a non-breaking addition); `cli.ts`
maps the classes above, as it maps them to exit codes today.

### 4.3 `result` payloads

Typed in `src/protocol.ts` and exported (types plus `parseEvent`, §11).
Nothing in a payload is a secret value: `.env` changes are keys and reasons
(`describeEnv` already prints only those).

```ts
interface StatusResult {
  app: string
  stateDir: string
  lock: null | { holder?: LockHolder; stale: boolean; corrupt: boolean }   // readLock()
  activeRun?: { runId: string; pid: number; command: string; actor: string; startedAt: string; alive: boolean }
  lastRun?: { runId: string; command: string; exitCode?: number; complete: boolean; endedAt?: string }
  hold: Hold | null                                                        // readHold()
  releases: Release[]                                                      // last 10, newest first
  process: { kind: 'pm2'; name: string; status?: string; pid?: number; running: boolean }
         | { kind: 'compose'; lines: string[] }                            // composeStatus() as today
}
interface CheckResult { file: string; app: string; runtime: 'pm2' | 'compose'; proxy?: string; types: 'ok' | 'failed' | 'not-typescript' | 'no-tsc' }
interface PlanResult {
  findings: Finding[]
  lines: Array<{ step: string; text: string }>        // the lines plan() prints, split at the first ': '
  questions: PromptDescriptor[]                       // what env/run would ask now (§7.2), never with a value
  blocking: boolean                                   // plan() would exit 1
}
interface RunResult { sha: string; previous: string; status: Release['status']; migrations: string[]; backup?: string; url?: string; heldOverride?: true }
interface RollbackResult { from: string; to: string; status: 'ok' | 'rollback-unhealthy'; held: string }
interface EnvResult { file: string; changes: Array<{ kind: 'set' | 'remove'; key: string; reason: string }>; port?: number }
interface DetachResult { runId: string; pid: number; log: string }
interface CancelResult { runId: string; pid: number; signal: 'SIGTERM'; second: boolean }
interface InstallPlanResult { plan: InstallPlan; path?: string; rootCommand: string }
```

`run` emits `result` whenever it reached the point of recording a release
(`ok`, `rolled-back`, `failed-migration`, `public-unreachable`, `aborted`, …),
followed by `error` when the exit code is not 0. A run that never got that far
emits only `error`.

### 4.4 Exit codes

Unchanged; documented in one place (USAGE, README, this table):

| Exit | Meaning | Last events |
|---|---|---|
| 0 | done | `result`, `done` |
| 1 | failed, refused, bad usage or protocol | (`result`), `error`, `done` |
| 3 | another deploy holds the lock — nothing was done | `error{code:'locked', holder}`, `done` |
| 130 | stopped by the first signal at a step boundary (any of SIGINT, SIGTERM, SIGHUP — `DeployAbortedError`) | (`result{status:'aborted'}`), `error{code:'aborted'}`, `done` |
| 130 / 129 / 143 | a **second** SIGINT / SIGHUP / SIGTERM: `process.exit` mid-step (`onSignal`) | **no `done`** — the stream just ends; the lock is stale, the next deploy takes it over |

A reader must treat "EOF without `done`" as an abnormal end, never as success.

### 4.5 `seq`

`seq` counts the events of one stream from 0. In the run log it is the resume
key (§8.4). A `log` event dropped by the size cap (§8.7) gets no `seq`, so the
sequence stays contiguous; a gap, a repeat or a decrease means the stream is
corrupt (§10).

## 5. Producing events

### 5.1 A `Host` decorator, not a second pipeline

`jsonHost(base, writer, answers)` wraps the real host and overrides:

- `out` — `step`/`info`/`ok`/`warn`/`error` become `step-start`/`log` events.
- `prompt` — §7. `confirm` — returns `false` and emits `prompt{kind:'confirm'}`
  answered only from `--answers`; no app-user command calls it today, so this is
  the fail-closed default, not a feature.
- `interactive()` — `false`: stdin is the protocol, not a person. Effects that
  already follow from it: the git fetch runs with `NO_PROMPT`; a remote that
  needs credentials is a preflight **error** (`remoteFindings`); the audit `via`
  is not `terminal`.
- `exec` — `stream: true` is turned into piped stdout/stderr whose lines become
  `log{stream:'child'}` events (§5.3); `interactive: true` throws (only
  `bootstrap` uses it, and `bootstrap --json` is refused).

Everything else (files, lock, clock, TLS, HTTP) is the base host unchanged. The
pipeline does not learn about JSON; it gains only what it lacks today — a
step's end:

- `Output` gains two **optional** members: `stepEnd?(id, status, durationMs)`
  and `finding?(finding)`. `consoleOutput` does not implement them, so human
  output is unchanged. `step()` in `pipeline.ts` calls `stepEnd` in a
  `try/finally` (`ok`, `failed`, or `aborted` for `DeployAbortedError`);
  `report()` calls `out.finding` when present, the text form otherwise.
- `locked()` reports the lock as a step (`lock`), so a UI sees "waiting for the
  lock → held" and the detaching parent has a confirmation point (§8.2).

### 5.2 The writer

One writer per process: it assigns `seq` and `ts`, applies the redactor (§6) to
every string field **before** `JSON.stringify` (redacting serialised JSON would
miss a secret that contains `"` or `\`, which JSON escapes), writes the line to
stdout and, when there is one, to the run log. It holds the original
`process.stdout.write` captured at startup.

### 5.3 Children's output

A child started with `stream: true` in JSON mode gets `['ignore', 'pipe',
'pipe']`. Its output is split into lines (`\n`, `\r\n`; a lone `\r` — progress
bars — also ends a line), each line:

1. decoded as UTF-8 (invalid sequences replaced),
2. stripped of ANSI/VT escape sequences (CSI, OSC, DCS) and of C0/C1 control
   characters except tab,
3. cut at 8 KiB (`truncated: true`),
4. redacted,
5. emitted as `log{stream:'child', level: stdout ? 'info' : 'warn', source, step}`.

A child's text is **data**: it is never parsed as an event, never matched for
control, and cannot break framing (it is a JSON string inside our line). A
build that prints `{"v":1,"type":"done","exitCode":0}` produces a `log` event
whose `text` is that string. Non-streamed `exec` is unchanged (output captured
in memory, as today), and its `stdin` stays `ignore` unless the call passes
`stdin` (SQL with a password, `services.ts`), which is a separate pipe to that
child only.

### 5.4 Foreign writes to stdout

`deploy.config.ts` and its functions run inside the deploy process. In JSON
mode, before `loadConfig`, `process.stdout.write` is replaced by a function
that turns whatever it is given into `log{stream:'foreign', level:'warn'}`
events (split, sanitised and redacted as in §5.3); `console.log` goes through
it. The writer keeps the original. A write to fd 1 that bypasses
`process.stdout` (`fs.writeSync(1, …)`) is not caught — that is code of the app
user doing something deliberate, and §10 covers what the reader does with a
line that is not a valid next event.

## 6. Secret safety

### 6.1 The rule

**No event ever carries a secret value.** That holds by construction where the
code already guarantees it (messages name keys and line numbers; `.env`
changes are reported without values; answers are never echoed), and by the
redactor everywhere else (children, foreign writes, error messages that quote a
child's stderr, e.g. `git ${args[0]} failed: ${stderr}`).

### 6.2 The redactor

A set of strings that only grows during the command, applied by the writer to
every string field of every event. Each occurrence becomes `[redacted:KEY]`
(the key, never a hash or a length). It is filled from:

1. the `.env` as read by `createContext` and after every `prepareEnv`/`writeEnv`:
   the value of every key that is declared `env.generate`, declared
   `ask.secret`, or whose name matches the `SENSITIVE` pattern `init.ts`
   already uses (`SECRET|TOKEN|PASSWORD|PASS\b|_KEY\b|^KEY_|CREDENTIAL|_URL$|_DSN$`);
2. the password component of every URL-shaped value in the `.env`
   (`scheme://user:password@…`), decoded and as written;
3. `InfraPlan.secrets` (`BASALT_PG_PASSWORD`, `BASALT_REDIS_PASSWORD`,
   `BASALT_MINIO_USER`, `BASALT_MINIO_PASSWORD`) once planned;
4. every answer received for a `secret` prompt, the moment it is parsed (§7),
   before anything else can print it.

For each value both the raw form and `encodeURIComponent(value)` (when it
differs) are matched, longest first. Values shorter than 6 characters are not
matched (they would shred ordinary text): the preflight reports a `secret-short`
**warning** finding naming the key, so the gap is visible instead of silent.
Base64 or other re-encodings by a child are not detected; that limit is
documented, and is why the code-side discipline in §6.1 stays the first line.

### 6.3 Prompts

A `secret` prompt has no `default` field and its answer is never sent back in
any event — not in `prompt` retries, not in `error`, not in `result`. A
rejected secret answer is reported by key and reason only
(`UnwritableValueError`'s message already names only the key).

### 6.4 Human mode

Unchanged in phase 1: streamed children keep the terminal (fd inheritance), so
colours, progress bars and TTY detection behave as today, and nothing is
redacted on a terminal. Redacting human mode would mean piping every child —
see open question Q1.

## 7. `--answers=stdin`

### 7.1 Lines

```json
{"v":1,"type":"answer","id":"env.SMTP_URL","value":"smtp://mailer.example.com:587"}
```

- One JSON object per line, at most 64 KiB per line and 256 lines; `v` must be
  1, `type` must be `answer`, `id` a string matching `^env\.[A-Z_][A-Z0-9_]*$`
  in v1, `value` a string without NUL. Any other field is ignored. A line that
  breaks a rule fails the command (`error` `protocol`, exit 1) **before
  anything changes**: the answers are read and validated before the lock is
  taken (up-front answers) or as they arrive (live answers, §7.4).
- **Unknown id** — not a key of `config.env.ask` — fails closed
  (`answer-unknown`): a typo must not turn into "the question was never
  answered and the run silently took a default". The set is known at start:
  questions come only from `config.env.ask`, and the config is loaded once,
  before the fetch.
- **Duplicate id** — fails closed (`protocol`), except a live answer to a
  re-prompt (`attempt > 1`, §7.2).
- An answer for a question that is not asked (the key is already in the `.env`,
  or the deploy's own environment provides it — which keeps precedence, as
  today) is not an error: a `log` warning names the key; the value is dropped
  and, if secret, still redacted.
- The answer bytes are never echoed, logged, written to the run log, passed to
  a child's argv or environment, or written anywhere but the `.env` (0600) by
  `writeEnv`, exactly as a typed answer is today.

### 7.2 How the `.env` questions become prompt events

`answerQuestions` stays the one place that asks. Under `--json`,
`host.prompt(message, {secret})` gains the question's identity (a third,
optional argument `{ id, key, optional, default }`, ignored by `nodeHost`):

```json
{"v":1,"type":"prompt","ts":"…","seq":14,"runId":"…","id":"env.SMTP_URL","kind":"secret","key":"SMTP_URL","message":"SMTP URL [SMTP_URL]","optional":false,"attempt":1}
```

- `kind` is `secret` when `ask.secret`, else `text`; `default` is included only
  for `text`.
- The id is `env.<KEY>`, stable across `plan` and `run`, so a UI can collect
  answers from `plan --json`'s `questions` and send them before `run` starts.
- An answer that fails validation (empty and required, or
  `UnwritableValueError`) is reported as a `log` warning by key, and — only on a
  live channel — the same id is prompted again with `attempt + 1`, up to the 3
  attempts `answerQuestions` already allows. With up-front answers there is no
  second chance: `answer-invalid`, before any change.

### 7.3 When there is no answer

- `--json` **without** `--answers`: a question that needs asking fails the
  command (`answer-missing`, with the keys and the hint "pass them with
  `--answers=stdin`, or in the command's environment"). This is today's
  non-TTY behaviour (`no answer for … (no terminal to ask)`) with a code.
- stdin reaches EOF with a prompt unanswered: fail closed (`answer-missing`).
  An **optional text** question with a `default` takes the default (as it does
  today with an empty answer); an optional question without a default takes
  `''` (as today). A `secret` question never takes a default, optional or not:
  an unanswered optional secret is left out of the `.env`, said in a `log`
  warning. A `confirm` is `false`.
- Where this happens: `answerQuestions` runs in the `env` step, before
  `writeEnv`, and `run` puts the code back on any failure after the fetch
  (`restoreCode`). Nothing is written.

### 7.4 Live answers and timeouts

The tool reads stdin for the whole command. Answers that arrive before a prompt
are buffered (validated on arrival). A prompt waits at most
`--answer-timeout` seconds (default 600) for its answer, then fails closed
(`answer-timeout`). The lock is held while it waits — as it is at a terminal
today; a UI that wants no wait sends everything up front (`plan --json` first).

### 7.5 Invariant

No child process can read the answers channel: streamed and captured children
get `stdin: 'ignore'` or their own pipe (§5.3), and `exec({interactive})` is
refused in JSON mode. A test asserts it for every `exec` call the pipeline makes.

## 8. Detached runs

### 8.1 What can detach

`run --detach --json` and `rollback --detach --json`. Not `env`: it is the
first-setup command, it may need answers a person decides on, and it is short.
A detached run **cannot prompt**: the parent refuses before detaching unless
every question `run` would ask is answered (by the deploy's environment or by
`--answers=stdin`) and valid. A config whose `.env` is complete needs no
answers at all.

### 8.2 Sequence

**Parent** (the process the SSH session started; never takes the lock):

1. `hello{command:'run', detached:true}`; load the config, `refuseRoot`,
   `createContext` — the same order as today.
2. Read and validate all of stdin to EOF (§7.1); compute the questions the run
   would ask now (`planEnv` on the current `.env`, read-only, no lock) and
   refuse with `answer-missing`/`answer-invalid` if any is unanswered or
   unwritable.
3. Advisory lock check (`readLock`): held and not stale → `error{code:'locked',
   holder}`, exit 3. The child's `acquireLock` is the authority; this only
   saves a pointless spawn.
4. `runId = <UTC yyyymmddThhmmssZ>-<12 hex>` (`Host.now()`, `Host.randomHex(6)`).
5. `<stateDir>/runs`: created 0700 if absent; refused (`failed`) if it is a
   symlink, not a directory, not owned by `Host.uid()`, or group/other-
   accessible. The log `<runId>.ndjson` is created with `O_CREAT|O_EXCL|
   O_NOFOLLOW`, mode 0600 (`Host.createExclusive` semantics).
6. Spawn the child through a new optional `Host.spawnDetached(command, args,
   { cwd, env, stdin, stdoutFd })`: `process.execPath` on this package's
   `bin.js`, argv `run --json --run-id=<id> [--answers=stdin] [--actor=…]
   [--via=ui] [--skip=…] [--unhold]`, environment = the parent's plus
   `BASALT_DEPLOY_DETACHED_CHILD=1`; `detached: true` (`setsid(2)`: a new
   session and process group, no controlling terminal, so no SIGHUP when the
   SSH session ends); stdin a pipe the parent writes the validated answer lines
   to and closes; stdout the run-log descriptor; stderr `/dev/null`;
   `unref()`. Answers travel only through that pipe — never argv, environment
   or disk. A host without `spawnDetached` refuses `--detach` (`unsupported`).
7. Wait (≤ 30 s) on the run log for the child's `step-end{id:'lock'}`:
   - `status:'ok'` → `result{data:{runId, pid, log}}`, `done{exitCode:0}`;
   - the child's `done` first (e.g. `locked`) → relay its `error`, exit with
     its code (3 for `locked`);
   - timeout → `error{code:'detach-unconfirmed', hint:'attach <runId>'}`, exit
     1; the child is not killed (it may be loading a slow config).

**Child:** an ordinary `run --json` whose writer targets the run-log descriptor
(its stdout) and which:

- takes `deploy.lock` itself, with `runId` in the holder;
- reads answers from its stdin pipe to EOF before the lock (§7.1 rules again —
  the child does not trust that the parent validated);
- prunes old run logs after taking the lock (§8.7);
- behaves exactly as an attended `run` otherwise: same steps, same phase-0
  signal semantics, same release record.

Attended commands (`run`/`env`/`rollback --json` without `--detach`) also write
a run log, so a UI whose connection drops mid-run can `attach` to what it
already started (that process is then stopped at the next step boundary by the
SIGHUP sshd sends, or keeps going without a pty and with `EPIPE` ignored —
either way the log records it).

### 8.3 The lock

`LockHolder` gains `runId?: string` (written only by JSON-mode locked
commands; `parseHolder` keeps old locks valid). Everything else in `lock.ts` is
unchanged: `O_EXCL` creation, `O_NOFOLLOW` reads, `unlink`-only removal, the
takeover file. The detached child holds the lock; the parent never does, so a
parent killed after step 7 changes nothing.

### 8.4 `attach <runId> --json [--from-seq=<n>] [--follow]`

- `runId` must match `^\d{8}T\d{6}Z-[0-9a-f]{12}$`; the file is opened with
  `O_NOFOLLOW` and must be a regular file owned by `Host.uid()` with no
  group/other bits, else `failed` (named "the run log is not one this deploy
  wrote"). Missing → `not-found`.
- Output: attach's own `hello{command:'attach'}`, then each run event with
  `seq ≥ n`, **wrapped**: `{v:1, type:'event', ts, seq, event:{…original…}}`.
  The outer `seq` is attach's stream; the inner `event.seq` is the run's and is
  the resume key. Wrapping keeps "who said this" unambiguous: attach's own
  `error`/`done` can never be confused with the run's.
- Every line read is parsed and checked (envelope, `v`, known shape, inner `seq`
  = previous + 1) before it is wrapped; a bad line ends the replay with
  `error{code:'failed', message:'run log corrupt at line …'}`, never a pass-
  through of raw text. The file is read in chunks, never whole.
- `--follow` polls the file (250 ms) after EOF until the run's `done`. If no
  `done` arrives and the lock no longer names this `runId` with a live pid for
  2 s → `error{code:'run-vanished'}` (a second signal, `SIGKILL`, the OOM
  killer). Attach's exit code: the run's `exitCode` when `done` was seen, else 1.
- Attach takes no lock and changes nothing.

### 8.5 `cancel <runId> [--json]`

Reads the lock. It sends `SIGTERM` to `holder.pid` only when: the holder's
`runId` is this one, its `host` is this host, the pid is alive, and (Linux)
`/proc/<pid>/cmdline` contains `--run-id=<runId>` — so a recycled pid is never
signalled. Otherwise `not-found`, exit 1. The child's `onSignal` does the rest,
exactly as phase 0 defines it: before the migration `run` stops at the next
step boundary and puts the code back (`aborted`, 130); from the migration on,
and in `rollback`, it finishes first. A second `cancel` sends the second
`SIGTERM` (`second: true` in the result), which ends the child at once (exit
143, no `done`, stale lock) — the UI must say so before sending it. Only the
deploy process is signalled, not its group: the current step's child finishes,
as with a `SIGTERM` from `kill` today.

### 8.6 Audit

`Audit.via` gains `ui`, set by `--via=ui` (the only accepted value; it
overrides the computed `ssh`/`batch`). `client` is still taken from
`$SSH_CONNECTION`, which the detached child inherits. The UI passes `--actor=<a
local name>`, validated by the existing `ACTOR` pattern. Both are
self-declared, as `--actor` already is: they attribute, they do not
authenticate (the SSH key and the OS account do). `syslogRelease` prints `via`
as today.

### 8.7 Retention and size

- Run logs: the newest 50 are kept and none older than 30 days, pruned by a
  locked command after it takes the lock; never the file of the current lock
  holder's `runId`; only names matching the `runId` pattern plus `.ndjson`;
  removal by `Host.removeFile` (`unlink`), never recursive.
- A run log stops taking `log` events at 64 MiB: one
  `log{level:'warn', text:'run log cap reached: further output lines dropped'}`
  is written, and `step-*`, `finding`, `prompt`, `result`, `error`, `done`
  continue. Stdout of an attended run is not capped.
- `status --json` `lastRun`: the newest run log's last 64 KiB, scanned for its
  final `result`/`done` (`complete:false` when there is none).

## 9. Root's commands and `init`

`install` and `bootstrap` run as root from a root-owned copy, read a validated
data plan and confirm raw configuration at a terminal (RFC 0006 §14.1). Driving
them from a protocol would put a "yes" for root-equivalent changes on a pipe,
and their confirmations are the control. `--json` is refused for both
(`unsupported`, exit 1). `init` writes code into the checkout and is a
developer-side command: refused too, for now.

`install-plan --json` is included because it is trivial and safe: it is the app
user's, and its output is already data (`buildInstallPlan`). The `result`
carries the plan, the path written (unless `--out=-`, which is refused with
`--json`: the plan is in the result) and the root command
(`rootInstallCommand`) for the UI to **show** — never to run.

## 10. Threat model

The setting: a local UI on an operator's machine runs `ssh -T <app-user>@<host>
-- 'cd <checkout> && node node_modules/@basaltkit/deploy/dist/bin.js <cmd>
--json=1 …'` (the checkout path quoted with `shellQuote`), with the system
`ssh`, the operator's key and the server's known host key.

| Threat | Position |
|---|---|
| **The UI gains power** | None beyond the SSH account: every protocol command is a CLI command the same user can type. There is no listener to reach, no new credential, no root path (§9). The server trusts protocol input exactly as it trusts argv from that user — and validates it more strictly (§7.1). |
| **stdin injection** (malformed, oversized, duplicate or unexpected answers; prototype keys) | Strict line parser: size and count caps, exact `v`/`type`, `id` pattern, string-only value, unknown ids and duplicates refused, before the lock. Only named fields are read from the parsed object. A bad line fails the command; it is never skipped. |
| **A secret on the wire** | Answers go client → server only, over SSH. No event echoes them; the redactor (§6.2) covers what children print. Secret answers never reach argv, the environment of a child, or a file other than the `.env`. |
| **Event spoofing by app output** (a build, a hook, `compose up`, a migration, the config printing a fake `done` or `prompt`) | Children's and foreign output is always a `text` string inside a `log` event, sanitised (§5.3–5.4). Nothing the server reads from a child is interpreted. The UI dispatches only on the envelope's `type`, never on `log.text`, and renders text as text (no ANSI, no HTML, no links auto-opened, `fix`/`hint` never executed). |
| **Raw fd-1 writes by hostile config code** | Can produce a line that looks like an event. Such code already runs as the deploy user and can do anything the deploy can; the protocol does not raise its power. Readers reject a line that is not valid JSON, has the wrong `v`, or breaks `seq` continuity, and then treat the stream as corrupt and stop. |
| **Run log tampering** | Other users: `runs/` is 0700 inside the 0700 state directory, logs are 0600, created `O_EXCL|O_NOFOLLOW`, read `O_NOFOLLOW` with an owner and mode check. **The app user itself** (and a PM2 app, which runs as that user) can rewrite its run logs, as it can rewrite `releases.json` and `deploy.lock` today: the log is the operator's view, not tamper-evident evidence. Tamper-evident history is `audit.syslog`. |
| **Signalling the wrong process** | `cancel` signals only the lock holder whose `runId` and `/proc/<pid>/cmdline` match (§8.5). |
| **Losing the deploy with the connection** | `--detach`: own session, no SIGHUP, the lock and run log outlive the SSH session. Attended runs: phase-0 SIGHUP semantics, and `EPIPE` on stdout is ignored rather than crashing mid-migration (§3.3). |
| **A UI talking to an incompatible server** | `hello.protocol` and `--json=1` refusal (§3.2). |
| **Denial of service by run logs** | 64 MiB cap per log, 50 logs / 30 days. |

## 11. Implementation sketch (for sizing, not a contract)

- `src/protocol.ts` — event and payload types, `parseEvent(line)` (shared by
  `attach`, tests and the phase-2 UI), the answer-line parser, `StepId`,
  `ErrorCode`.
- `src/json-host.ts` — `jsonHost()`, the writer, the redactor, the line
  sanitiser, the foreign-stdout capture.
- `src/runs.ts` — run ids, the runs directory checks, run-log creation and
  pruning, `attach`, `cancel`, `lastRun`.
- `host.ts` — optional `spawnDetached`, optional `signal(pid, name)`, optional
  `processCmdline(pid)`; `exec` honours a per-call `onLine` sink for `stream`.
- `pipeline.ts` — step ids and `stepEnd`; `report()` → `out.finding`;
  `PlanResult` built from the same lines; `locked()` emits the `lock` step;
  each command returns its payload to `cli.ts` (the human path keeps printing
  as today).
- `lock.ts` — `runId` in the holder. `audit.ts` — `via: 'ui'`. `context.ts` —
  `DeployError.code`.
- `cli.ts` — flag parsing and refusals (§3.2), the error→code map, `attach`,
  `cancel`, USAGE.

New exports are types and `parseEvent`; `Output`, `Host`, `LockHolder`,
`Audit` change only by optional members or a widened union. A minor version
(the package is 0.x), with a changeset.

**Not added:** no package, no dependency (no `ssh2`, no JSON-schema library —
the v1 schema is small and hand-checked), no daemon, no HTTP, no MCP tool, no
`@basaltkit/ai` hook. Phase 2's UI is a separate local program that only spawns
`ssh`.

## 12. Backwards compatibility

- Without `--json`, every command is unchanged: same text on stderr, same
  `USAGE` on stdout, same prompts at a TTY (`muteEcho`, three attempts), same
  exit codes. The existing tests' `printed` assertions are the guard.
- Old locks (no `runId`) parse as before; old `releases.json` entries without
  `via: 'ui'` are untouched.
- Third-party `Host` implementations keep compiling: new members are optional,
  and their absence disables only `--detach`/`cancel` (`unsupported`).
- Protocol: additive within v1 (§4.1).

## 13. Test plan

All on `FakeHost` unless noted; every existing test keeps passing.

1. **Framing.** For each covered command, success and failure: stdout lines all
   parse with `parseEvent`, first is `hello`, last is `done`, `seq` 0…n
   contiguous, nothing else on stdout; `FakeHost.printed` empty in JSON mode.
2. **Exit codes ↔ events.** `locked` (3, with holder), `aborted` (130 via
   `FakeHost` signal at a step boundary), `refused-root`, `preflight` with
   findings, `held`, `release-failed` with a `result`, `config`, `unexpected`.
3. **Steps.** `run` emits `lock, preflight, fetch, env, infra, build, validate,
   backup, migrate, release, health, record` each with one `step-end`; a
   failure at `build` gives `build: failed` then `restore`; skips are
   `skipped`.
4. **Secrets never leak.** A config with generated, asked and infra secrets;
   children (build, hook, migration, `git` stderr) print those values raw,
   URL-encoded, inside a URL, and inside a JSON-looking line: no event string
   and no run-log byte contains any secret; affected events have `redacted`.
   Short secret → `secret-short` finding. Prompt events of `kind:'secret'`
   never have `default`.
5. **Spoofing.** A child and a `console.log` in the config print a complete fake
   `done`/`prompt`/`result` line: it appears only as `log.text`; the stream's
   real `done` has the real exit code; ANSI and control characters are
   stripped; an 8 KiB+ line is `truncated`.
6. **Answers.** Up-front answers fill `.env` (0600) and never appear in output;
   unknown id, duplicate id, oversized line, non-string value, wrong `v` → exit
   1 with no file changed and no lock taken; EOF with a required, a secret, an
   optional-with-default and an optional-without-default question (§7.3);
   live re-prompt with `attempt: 2`; timeout; `--json` without `--answers`
   → `answer-missing`; environment precedence kept.
7. **No child reads stdin.** Every recorded `exec` call in JSON mode has stdin
   `ignore` or its own `stdin` payload; `interactive` refused.
8. **Detach.** Parent refuses before spawning when an answer is missing or the
   lock is held (3); spawns with the expected argv/env (no answer in either),
   answers only on the child's stdin; returns after the child's `lock` step;
   relays the child's `locked`; `detach-unconfirmed` on timeout. Runs dir:
   symlink, wrong owner, 0755 → refused; log created 0600 `O_EXCL`.
9. **Attach.** Replays from `--from-seq`, wraps events, stops at `done` with its
   exit code; corrupt line, `seq` gap, symlinked or 0644 log → refused;
   `--follow` with a vanished holder → `run-vanished`.
10. **Cancel.** Signals only a matching live holder; recycled pid (cmdline
    mismatch) refused; second cancel marks `second`.
11. **Retention.** Keeps 50 / 30 days, never the active run, never a non-matching
    name, `unlink` only; log cap writes one notice and keeps `done`.
12. **Status.** `activeRun` from a lock with `runId`; stale lock; corrupt lock;
    `lastRun` complete and incomplete.
13. **Refusals.** `--json` on `init`/`install`/`bootstrap`; `--answers` without
    `--json`; `--detach` on `env`/`plan`; `--json=2`; `install-plan --json
    --out=-`.
14. **Human mode unchanged.** Snapshot of `run`/`plan`/`status` printed output
    before and after.
15. **Real host (node-host tests).** `spawnDetached` survives the parent's exit
    and its session id differs; `EPIPE` on stdout does not stop the writer from
    finishing the run log.

## 14. What phase 2 (the local UI) consumes

- Transport: the system `ssh -T` (BatchMode, strict host keys), one process per
  command; no agent on the server.
- Discovery: `status --json` (lock, active run, last run, hold, releases,
  process) and `check --json`.
- Before deploying: `plan --json` → findings to show, `lines` as the plan,
  `questions` to collect (secret fields as password inputs, never stored by the
  UI beyond the request).
- Deploying: `run --detach --json=1 --answers=stdin --via=ui --actor=<name>`
  with the answers on stdin, then `attach <runId> --json --follow
  --from-seq=<last seen + 1>` across reconnects; `cancel <runId>` with an
  explicit second confirmation for the second signal.
- Rolling back: `rollback --detach --json=1 [--to=<sha>]`, same attach.
- Types: `import type { DeployEvent, … } from '@basaltkit/deploy'` and
  `parseEvent` — the UI validates every line with the server's own parser.

## 15. Decisions taken here

1. Events in a **versioned envelope** with per-stream `seq`; additive changes
   within v1; `--json=1` pinned by the UI.
2. **Redaction at the writer**, before serialisation, over every string field —
   one choke point instead of call-site discipline alone.
3. **Children and foreign stdout are always data** inside `log` events.
4. **Answers fail closed**: unknown or duplicate ids refused, unanswered
   secrets never defaulted, invalid up-front answers fatal, all before the lock.
5. **The detached child owns the lock**; the parent only confirms it was taken.
6. **Every JSON-mode locked command writes a run log**, so attach works for
   attended runs too.
7. `env` does not detach; root commands and `init` do not speak JSON.
8. No new exit codes; error detail is the `error.code`.

## 16. Open questions

- **Q1. Redact human mode too?** Piping every streamed child through the
  redactor would protect terminals and CI logs as well, at the cost of children
  no longer seeing a TTY (colours, progress, some tools change behaviour).
  Proposed: a later minor, behind an opt-out, after measuring what changes.
- **Q2. Short secrets.** 6 characters is a judgement call between shredding
  ordinary output and missing a weak secret; the `secret-short` warning makes
  it visible. Should `ask.secret` refuse answers below a minimum instead?
- **Q3. `cancel` off Linux.** Without `/proc`, pid identity cannot be checked;
  proposed: refuse `cancel` there (servers are Linux; RFC 0007 §7).
- **Q4. App logs.** A `logs` command tailing `pm2 logs` / `compose logs` would
  put the running app's output (user data, PII) on the protocol. Deferred; the
  UI can show the `logsHint` command the CLI already prints.
- **Q5. Structured compose status.** `StatusResult.process` carries
  `composeStatus()`'s lines for compose apps; a typed per-service shape is a
  later additive change.
- **Q6. Retention numbers** (50 logs, 30 days, 64 MiB) — and whether they belong
  in `deploy.config.ts`.

## 17. As built — where the implementation differs

The code is the reference; these are the places it departs from the text
above, and why.

- **Hooks, by name.** `Output` gains `step(title, id?)`, `stepEnd?`,
  `finding?` and also `result?` (each command hands its payload to it).
  `ExecOptions.onOutput(text, stream)` hands a streamed child's decoded
  output over in chunks (the line splitting is the writer's, §5.3), not an
  `onLine`. `Host` gains the optional `createLog`, `readFileRange`,
  `spawnDetached`, `kill` and `processCmdline`; `RunOptions` gains `via` and
  `protocol` (`runId`, `beforeLock`, `afterLock`, `afterAnswers`), set only by
  the CLI. `DeployError` gains `code` and `hint`. `processIO()` and `CliIO`
  are the CLI's stdin/stdout, injectable for tests.
- **Steps hold what they decide.** The `env` step now covers the questions
  and the `.env` write, and `preflight` stops inside its own step, so a
  `prompt` belongs to `env` and a blocking preflight ends `failed`. The
  human output is the same (a snapshot recorded on the code before this RFC
  is in the tests).
- **`secret-short`** is a `finding` emitted when the short value is learnt
  (the `.env` read by `createContext`, a child's environment), not an entry in
  the preflight's list; it exists only under `--json`.
- **The redactor also learns every child's environment** — keys matching the
  sensitive pattern or `BASALT_(PG|REDIS|MINIO)_*`, and URL passwords —
  which is where `InfraPlan.secrets` (and `PGPASSWORD`) reach a child.
- **The log cap applies to stdout too.** `seq` is shared by stdout and the
  run log, so a `log` event dropped from one is dropped from both; past
  64 MiB an attended run's stdout carries the notice and the non-`log`
  events, like its run log.
- **Answers.** Without `--answers`, no `prompt` event is written: the command
  fails `answer-missing`. With it, an attended run checks the lines sent so
  far before the lock (it waits for EOF or 50 ms, so a channel left open for
  live answers does not hold it up); a bad line arriving later fails at the
  next prompt. Reading stops when the `.env` questions are done
  (`afterAnswers`): later lines are never read. A detached run's parent and
  child read stdin to EOF first, as specified.
- **Detach.** The parent computes the questions with `planEnv` on the `.env`
  as it is, with its `PORT` (a `derive` that depends on a port not yet chosen
  could differ; the child asks nothing and fails `answer-missing` if so).
  The child's `hello` also carries `detached: true`.
- **`attach`** without `--follow` on a run still alive replays what exists and
  exits 0 with a `log` line saying so; a run whose process is gone without
  `done` is `run-vanished`. When the run's exit code is not 0, attach exits
  with it but writes no `error` of its own (the run's is in the replay).
- **`cancel`** requires `--run-id=<runId>` in the process's own argv (Q3
  resolved as proposed: refused, `unsupported`, where `/proc` cannot be
  read). Only a detached run carries it, so an attended run is not
  cancellable this way — it stops with its SSH session (SIGHUP, phase 0). A
  second `cancel` is recognised by `<runId>.cancel`, created `O_EXCL` in the
  runs directory and pruned with the log.
- **Outcomes without an exception.** A `run`/`rollback` that returns 1 after
  recording (rolled back, public URL unreachable, rollback unhealthy) emits
  `error{code:'release-failed'}`, a blocking `plan` `error{code:'preflight'}`,
  a failing `check` `error{code:'failed'}`. `RunResult` gains `note` (why it
  did not end `ok`). Blank lines a child prints are not events.
- **Retention never fails a deploy:** an entry that cannot be unlinked (a
  directory with a log's name) is left alone.

Known limits, unchanged from the text: a secret re-encoded by a child
(base64, hex) is not recognised; a write to fd 1 that bypasses
`process.stdout` is not captured; human mode is not redacted (Q1); run logs
are not tamper-evident against the app user itself; the detaching parent
reads at most the first 1 MiB of the run log while it waits for the `lock`
step (which a run writes within its first few events).

