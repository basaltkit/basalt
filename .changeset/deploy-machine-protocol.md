---
'@basaltkit/deploy': minor
---

Machine mode (RFC 0008): a program can drive the deploy over the system `ssh`, as the app user, with no daemon and no listener.

- **`--json`** on `status`, `check`, `plan`, `run`, `env`, `rollback`, `install-plan`, `attach` and `cancel`: stdout carries only NDJSON events in a versioned envelope (`{v:1, type, ts, seq, runId?}`) — `hello`, `step-start`/`step-end`, `log`, `finding`, `prompt`, `result` (a typed payload per command), `error` (with a `code`), `done`. Children's and `deploy.config.ts`'s output is always the text of a `log` event, sanitised, never interpreted. Every string of every event is redacted (generated, asked-secret and secret-named `.env` values, URL passwords, infra passwords, secret answers; raw and URL-encoded) before it is serialised. `init`, `install` and `bootstrap` refuse `--json`.
- **`--answers=stdin`** for `run` and `env`: answer lines `{"v":1,"type":"answer","id":"env.KEY","value":"…"}`, checked strictly; an unknown id, a duplicate or a malformed line fails before the lock; an unanswered secret never takes a default; `--answer-timeout` (default 600 s). `plan --json` lists the questions.
- **`run --detach` / `rollback --detach`**: the run starts in its own session and owns the deploy lock (`LockHolder.runId`); `attach <runId> [--from-seq] [--follow]` replays its run log (`<stateDir>/runs/<runId>.ndjson`, 0600, kept 50 / 30 days, 64 MiB cap); `cancel <runId>` sends SIGTERM only to the matching lock holder. `status --json` reports the active and last run. `--via=ui` is recorded as the release's `via`.
- New subpath **`@basaltkit/deploy/protocol`**: the event and payload types, `parseEvent` and `parseAnswerLine`, with no CLI and no Node API at load.
- API (additive): `Output` gains `step(title, id?)` and the optional `stepEnd`, `finding`, `result`; `Host` gains the optional `createLog`, `readFileRange`, `spawnDetached`, `kill`, `processCmdline`, and `prompt` an optional third argument; `ExecOptions.onOutput`; `DeployError` gains `code` and `hint`; `RunOptions` gains `via` and `protocol`; `main` takes an optional `CliIO`.

Without `--json` every command prints exactly what it printed before (a snapshot recorded on the previous code guards it). Behaviour changes in human mode: `--via` accepts only `ui`; `cancel` is a new command; `--answers`/`--detach`/`attach` without `--json` are refused.
