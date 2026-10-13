# RFC 0009 — `basalt-deploy` phase 2: a local UI over `ssh`

- **Status:** Accepted — implemented in `packages/deploy-ui` (unreleased) and the `ui` hint in `@basaltkit/deploy`; where the code differs from this text, §15 says so
- **Author:** Marcio Zebedeu
- **Date:** 2026-10-13
- **Affects:** new package `@basaltkit/deploy-ui` (operator's machine only); `@basaltkit/deploy` gains one hint command (`ui`, §3.4) and nothing else. No runtime package, no AI or MCP package, no app code.
- **Builds on:** RFC 0006 (the pipeline; §14 phase-0 hardening), RFC 0007 (`check`, `init`, `bootstrap`), RFC 0008 (the `--json` protocol, `--answers=stdin`, detached runs, `attach`, `cancel`)
- **Non-negotiables honoured:** nothing listens on the server; nothing listens off the operator's machine; the UI can do exactly what the SSH account can, no more; the system `ssh` only, with the operator's own keys, agent and `known_hosts`; secrets travel once, browser → loopback → `ssh` stdin, and are never written, logged, put in argv or in an environment; root's commands are never driven from the UI; fail-closed

---

## 0. TL;DR

RFC 0008 gave `basalt-deploy` a contract a program can read. This RFC is the
program: a **local web UI** the operator starts on their own machine.

```
npx @basaltkit/deploy-ui@<exact version>
  → listens on 127.0.0.1:<random port>, opens the browser with a one-time code
  → for every action, spawns:  ssh … -- deploy@203.0.113.10 "cd '/srv/myapp' && exec 'node' 'node_modules/@basaltkit/deploy/dist/bin.js' 'status' '--json=1'"
  → validates every line with parseEvent from @basaltkit/deploy/protocol, streams it to the page
```

Decisions, each justified below:

1. **A separate package**, `@basaltkit/deploy-ui`, with its own bin, depending on
   `@basaltkit/deploy` for its `protocol` subpath only. The server's install
   (`pnpm install` of the app, which includes devDependencies) never carries a
   byte of UI. `basalt-deploy ui` only prints how to start it (§3).
2. **No framework, no bundler.** A `node:http` server of ~10 POST routes and a
   vanilla-TypeScript client compiled by `tsc` to ES modules shipped in `dist`
   — the repo's build convention, no CDN, no runtime fetch but the local
   server (§3.2).
3. **Loopback-only, one session, every request authenticated**: 256-bit
   launch code (one-time, in the URL fragment) exchanged for a 256-bit session
   token held by the tab and sent as `Authorization: Bearer`; exact `Host` and
   `Origin` checks; POST-only JSON API; strict CSP; no CORS; idle shutdown (§4).
4. **Targets** live in the operator's config directory, never in the app
   repository (a cloned repo must not be able to point the UI, and the
   secrets typed into it, at another host). Every field is validated against a
   closed grammar (§5).
5. **The system `ssh`**, argv array, `BatchMode=yes`,
   `StrictHostKeyChecking=yes`, no agent/X11/port forwarding, no `LocalCommand`,
   `--` before the destination; the remote command is built from validated
   pieces, each single-quoted for the remote POSIX shell, and runs the app's
   **lockfile-pinned** `node node_modules/@basaltkit/deploy/dist/bin.js` — never
   `npx` (§6).
6. **MVP flows:** targets and connection check, status, plan (findings and the
   `.env` questions), `.env` form, run (detached by default), live log with
   re-attach from `seq`, cancel, rollback, release history (§8).

**Not in this RFC:** any listener, panel, agent or daemon on the server; a port
reachable from another machine; `ssh2` or any JS SSH; a web terminal; `install`
/ `bootstrap` / `init` from the UI; AI or MCP deploy tools; anything inside the
app's runtime, admin or dashboard; storing passwords, keys or `.env` values
anywhere.

## 1. What exists today (the ground this builds on)

| Fact | Where | Consequence for the UI |
|---|---|---|
| `@basaltkit/deploy/protocol` is pure — types, constants, `parseEvent`, `parseAnswerLine`; it imports nothing and needs no Node types | `packages/deploy/src/protocol.ts`; `package.json` `exports["./protocol"]` | The UI's server **and** its browser code type-check against the same declarations; the server validates every line with the server's own parser |
| `@basaltkit/deploy` has **no runtime dependencies** | `packages/deploy/package.json` | Depending on it costs the UI nothing but the package itself |
| The remote invocation is `node node_modules/@basaltkit/deploy/dist/bin.js <cmd>`, not `pnpm exec` (pnpm ≥ 12 may rewrite the lockfile) | `cli.ts` `USAGE`; README "Machine mode"; RFC 0008 §10 | The UI runs exactly this, pinned by the app's lockfile on the server |
| `@basaltkit/deploy` is a **devDependency** of the app, installed on the server by the deploy's own `pnpm install` | `create-app/src/templates.ts:134`; RFC 0006 §2 | `deploy-ui` must **not** be one: it would be installed on every server (§3.1) |
| Covered commands: `status`, `check`, `plan`, `run`, `env`, `rollback`, `install-plan`, `attach`, `cancel`; `init`/`install`/`bootstrap` refuse `--json` | RFC 0008 §3.1; `cli.ts` `checkFlags` | The UI's command set is a subset of these; root's commands are not reachable even by mistake |
| `run --detach` / `rollback --detach` return `DetachResult{runId,pid,log}` once the child holds the lock; `attach <runId> --json --follow --from-seq=n` replays wrapped `event`s; `cancel <runId>` sends one SIGTERM, a second sends the second | `detach.ts`, `runs.ts`; RFC 0008 §8 | Run, re-attach and cancel are three ssh invocations, no state on the server beyond what exists |
| A detached run cannot prompt: the parent refuses unless every question is answered | `detach.ts` `checkAnswers`; RFC 0008 §8.1 | The UI collects answers **before** a run, from `plan --json`'s `questions` |
| `plan --json` → `PlanResult{findings, lines, questions, blocking}`; `status --json` → `StatusResult{lock, activeRun, lastRun, hold, releases (10), process}` | `protocol.ts` | The status, plan and history screens are renderings of these two payloads |
| `--actor` must match `^[A-Za-z0-9._@+-]{1,64}$`; `--via` accepts only `ui` | `audit.ts:19`; `cli.ts` `checkFlags` | The UI validates `actor` with the same pattern before it ever reaches argv |
| `rollback` forwards `--to=<sha>` to a detached child | `cli.ts` `forwarded()` | Rollback to a picked release is one flag |
| Every string of every event is sanitised (escapes and C0/C1 out) and redacted before it is written | `events.ts` writer; RFC 0008 §17 | The UI still treats every string as hostile (§9): defence in depth, not trust |
| Existing `*-ui` packages (`teams-ui`, `billing-ui`, `api-keys-ui`) are **app plugins**: server-rendered HTML strings with one hash-locked inline script, built by `tsc`; the React admin packages (`admin-react`, `admin-shadcn`) ship components with `react` as a peer and no bundle | `packages/*-ui/src/html.ts`; `packages/admin-react/package.json` | Neither model fits a standalone local tool: the first runs inside the app, the second needs the app's bundler (§3.2) |
| Build is `tsc -p tsconfig.build.json` everywhere; tests are vitest per package, jsdom for DOM code (`admin-react/vitest.config.ts`); coverage is aggregated from `packages/*/src/**/*.ts` with thresholds 92/84/90/94 | `vitest.coverage.config.ts` | The new package follows the same build and is **in** the coverage gate (§11.4) |
| CI runs on `ubuntu-latest` only | `.github/workflows/ci.yml` | Windows argv is covered by unit snapshots, not by a real `ssh.exe` run (Q4) |

## 2. Goals and non-goals

**Goals.** An operator who can already `ssh` into the app user can, from a
browser on their own machine: see the state of each server (current release,
lock, active run, hold, last results); see what a deploy would do and what it
would ask; answer the `.env` questions without the values touching a disk or a
log; start a deploy that a closed laptop lid does not stop; watch it live,
re-attach after a disconnect without losing an event, cancel it, roll back.
Time from "I have SSH access" to "first deploy from the UI" is one command and
one form.

**Non-goals.** A hosted or shared panel; multi-user access to one UI; managing
servers the operator cannot `ssh` into; provisioning (`bootstrap`, `install`
stay root's, at a terminal, RFC 0006 §14.1); tailing the app's logs (RFC 0008
Q4); editing `deploy.config.ts`; anything a terminal session as that user could
not do.

## 3. Packaging and stack

### 3.1 A separate package, not a `basalt-deploy` subcommand

| | `basalt-deploy ui` (in `@basaltkit/deploy`) | `@basaltkit/deploy-ui` (separate) |
|---|---|---|
| Where it gets installed | everywhere `deploy` is — **every server** (devDependency, installed by the deploy's own `pnpm install`) | only where the operator installs it |
| What the server carries | HTML, CSS, client JS, an HTTP server — on a machine that must never listen | nothing |
| Dependency direction | the deploy tool grows a browser surface | the UI depends on the deploy's pure `protocol` subpath; the deploy knows nothing of the UI |
| Release cadence | UI fixes bump the server tool | independent semver; compatibility is `hello.protocol === 1` |

**Decision: `@basaltkit/deploy-ui`**, bin `basalt-deploy-ui`, `engines.node`
`>=22.5.0` like `deploy`. `dependencies: { "@basaltkit/deploy": "workspace:^" }`
and nothing else. A test asserts that every import of `@basaltkit/deploy` in
`src/` is `@basaltkit/deploy/protocol` (§11.1): the UI never loads the CLI or
the pipeline.

**How an operator runs it:** `npx @basaltkit/deploy-ui@<exact version>` or a
global install. The docs say plainly: **do not add it to the app's
`package.json`** — not even as a devDependency — because the deploy installs
devDependencies on the server.

### 3.2 Stack: `node:http` + vanilla TypeScript, compiled by `tsc`

- **Server:** `node:http`, ~10 POST routes (§7). Not `@basaltkit/http`: that is
  the application framework (container, plugins, adapters, `@basaltkit/core`);
  pulling it into a dependency-free operator tool to serve ten routes on
  loopback adds weight and surface for no gain. Not Fastify/Express/Hono for
  the same reason.
- **Client:** plain TypeScript modules in `src/client/`, compiled by a second
  `tsc` project (`tsconfig.client.json`: `lib: ["ES2023","DOM","DOM.Iterable"]`,
  no Node types, `module`/`target` ES2022) to `dist/client/*.js`, loaded with
  `<script type="module" src="/client/main.js">`. Relative imports resolve in
  the browser as emitted; no bundler and no import map (an inline import map
  would need a CSP hash). The client imports from `@basaltkit/deploy/protocol`
  **only with `import type`** (erased at compile time) — the server re-validates
  everything, the browser renders it.
- **HTML and CSS** are TypeScript string constants (`src/page.ts`), the way the
  `*-ui` packages already ship markup, served as `/` and `/app.css`. No copy
  step, nothing but `tsc` in `build`.
- **Not React.** `admin-react` needs the app's bundler and a `react` peer; a
  CDN is forbidden; vendoring React into `dist` means adding a bundler to a
  repo that has none. The UI is six screens of forms, tables and a log — DOM
  APIs and a 100-line render helper are the smaller thing.

Package layout (sizing, not a contract):

```
packages/deploy-ui/
  src/
    bin.ts        flags (--targets, --ssh, --no-open, --idle-minutes), start, open the browser
    server.ts     node:http, the route table, body limits, streaming responses
    security.ts   Host/Origin/Sec-Fetch-Site/Content-Type checks, response headers (pure)
    session.ts    launch code, session token, constant-time compare, idle timer
    targets.ts    file location, read/validate/write (0600, atomic)
    ssh.ts        argv builder, remote command quoting, spawner (injectable)
    stream.ts     line splitter with caps, parseEvent, seq continuity, attach unwrap
    commands.ts   one function per remote command: status, plan, env, run, rollback, attach, cancel
    open.ts       the platform opener's argv
    page.ts       index.html and app.css as strings
    client/       main.ts, api.ts (fetch + NDJSON reader), render.ts (text-only DOM helpers),
                  sanitize.ts, views/{targets,status,plan,env,run,history}.ts
  tests/
    fake-ssh.mjs, transcripts/*.ndjson, *.test.ts
```

### 3.3 Compatibility

The UI speaks protocol 1 (`--json=1`). A server whose `hello` is missing, not
protocol 1, or whose `@basaltkit/deploy` predates RFC 0008 (the command fails
with a usage error and no `hello`) is shown as "this server's
`@basaltkit/deploy` does not speak protocol 1 — upgrade it in the app
(the first release with RFC 0008) and deploy once from a terminal". `hello.version`
is shown on the status screen.

### 3.4 `basalt-deploy ui`

One command added to `@basaltkit/deploy`, a hint and nothing else: it writes to
stderr that the UI runs on the operator's machine, never on the server, and how
to start it (`npx @basaltkit/deploy-ui@<version>`), and exits 0. With `--json`
it is refused (`unsupported`). It spawns nothing and imports nothing new: the
deploy package gains no dependency and no listener.

## 4. The local server: security model

The UI's server is reachable by **every process on the operator's machine**
(loopback TCP is not per-user) and by **every web page the operator's browser
opens** (as a target of requests, via DNS rebinding or cross-site requests).
Every rule below answers one of those.

### 4.1 Binding

- `listen(0, '127.0.0.1')`: IPv4 loopback only, a port the OS picks. Never
  `0.0.0.0`, never `::`, never `localhost` (which may resolve to another
  address). There is no `--host` flag. A `--port` flag is not offered either:
  a predictable port helps nobody but an attacker.
- The URL is always `http://127.0.0.1:<port>/`.

### 4.2 Launch and the session

1. At start: `launchCode`, `sessionToken` and `serverKey`, each 32 bytes
   from `crypto.randomBytes`, base64url.
2. The browser is opened at `http://127.0.0.1:<port>/#launch=<launchCode>`
   (§4.6). The fragment is never sent in a request, a `Referer` or a server
   log.
3. The page's module script reads `location.hash`, immediately replaces it
   (`history.replaceState`), and posts `{code}` to `POST /api/session`.
4. The server compares in constant time (`timingSafeEqual` on equal-length
   buffers). On the **first** match within 120 s it returns `{token:
   sessionToken, serverKey}` and burns the launch code. Any later exchange — right code or
   not — is refused (409 "this UI already has its browser session; restart
   basalt-deploy-ui for a new one"), and the terminal prints one line each time
   ("a second browser tried to claim the session"), so a stolen code is
   visible.
5. The tab keeps the token in `sessionStorage` (scoped to scheme + host +
   **port** and to this tab; survives a reload; never `localStorage`, never a
   cookie) and sends it as `Authorization: Bearer <token>` on every API call,
   the event streams included. It keeps `serverKey` next to it and **never
   sends it**.
6. The page makes the server prove itself (below) once after every load, and
   again before every `run` or `env` that carries answers.

**The server proves itself.** The bearer token authenticates the page to the
server, not the other way round. Once the UI stops (idle, Quit, `Ctrl-C`),
its port is free, and any local process — another user's included — may bind
it. A tab still open would then post the token, and any `.env` answers typed
into it, to that listener. So the page checks its server before an answer
leaves it: it sends `POST /api/hello {nonce}` (32 random bytes from WebCrypto),
the server answers `HMAC-SHA256(serverKey, "basalt-deploy-ui hello v1\n" +
nonce)`, and the page verifies it with WebCrypto. A listener that took the
port has at most seen the bearer token, never the key. A wrong or missing
proof, a refused connection, or a stream cut short puts the page in a
**stopped** state: every form is removed (typed values with it), the token
and the key are removed from `sessionStorage`, and nothing more is sent. Quit
removes them too. What this does not cover is stated in §15.

**Why a bearer header and not a cookie.** Cookies are not port-scoped: a cookie
for `127.0.0.1` is sent to **every** server on `127.0.0.1`, whatever its port —
the operator's other dev servers, or a listener another local user started. A
header set by our own script is sent only where our script sends it, and a
custom `Authorization` header on a cross-origin request forces a CORS
preflight, which this server never answers (§4.4). `sessionStorage` is readable
by script on this origin only, and the CSP (§4.5) allows no script but ours.
The token is not one of the secrets the non-negotiables cover (passwords,
keys, `.env` values): it dies with the process.

**One browser session.** The first exchange wins; there is no second. A closed
tab, or a second tab opened by hand, means restarting the command — cheap, and
it keeps "who can drive this server right now" to exactly one tab.

### 4.3 Every request

Checked in this order, before routing; any failure is a bare 4xx with a short
plain-text reason and no body echo:

1. **Host** must equal `127.0.0.1:<port>` exactly (DNS rebinding: a page on
   `attacker.example` that re-resolves to 127.0.0.1 sends `Host:
   attacker.example`). Anything else → 421.
2. **Static assets** (`GET /`, `/app.css`, `/client/<name>.js` from a fixed
   allowlist built at start from `dist/client`, names `^[a-z0-9-]+\.js$`, no
   path from the request ever reaches the filesystem): no token required —
   they are the package's public files and carry no data. Everything else is
   `/api/*`.
3. **`/api/*`: POST only** (others → 405; `OPTIONS` → 405 with no
   `Access-Control-*` header — no CORS, ever). `Content-Type` must be
   `application/json` (a cross-site form or `text/plain` beacon cannot send
   it without a preflight).
4. **Origin** must be present and equal `http://127.0.0.1:<port>`. Browsers
   send `Origin` on every POST, same-origin included; a missing one is
   refused. **`Sec-Fetch-Site`**, when present, must be `same-origin`.
5. **Authorization:** `Bearer` + the session token, constant-time compare
   (`/api/session` is the only route without it, and it takes the launch code
   instead). → 401.
6. **Body:** at most 1 MiB, read fully before parsing; JSON object; only the
   fields each route names are read (no spread of request objects into
   anything).

The event streams are POST routes too (`fetch` + `ReadableStream`, not
`EventSource`, which cannot send a header or a body): one rule for every API
call, no GET exception.

### 4.4 Response headers (every response)

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
  img-src 'self'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-store
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=()
```

No inline script, no inline style (`style-src 'self'` without
`'unsafe-inline'`: the client sets classes, never `style=`), no `eval`. No
`Access-Control-Allow-*` header on any response.

### 4.5 Lifetime

- **Idle shutdown:** the process exits after `--idle-minutes` (default 15, max
  240) with no authenticated request, no open event stream **and** no remote
  command in flight (a slow `plan`, a `run --detach` still detaching). A tab
  watching a run keeps it alive; a forgotten tab with nothing running does not.
- `Ctrl-C` in the terminal, or "Quit" in the page (`POST /api/quit`), stops it.
- On exit: open `ssh` children of **attended** commands get SIGTERM (an
  attended `env` stops at its next step boundary, phase-0 semantics); detached
  runs live on the server and are unaffected — the UI says so before quitting
  with one open.
- The process never writes a file except the targets file (§5), and only when
  the operator saves a target.

### 4.6 Opening the browser

Argv, no shell: macOS `open <url>`, Linux and BSD `xdg-open <url>`, Windows
`%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler <url>` (not
`cmd /c start`, which needs a shell and mangles `&`/`#`; an absolute path,
because Windows looks a bare name up in the working directory first, §6.1).
The opener starts in the operator's home directory. `--no-open` prints the URL to the terminal
instead. If the opener fails, the URL is printed. The URL (with the launch
code) is in the opener's argv for an instant, visible to other local users on
a shared machine: the code is one-time, expires in 120 s, and a claim by
anyone else makes the operator's tab fail loudly and the terminal print it
(§4.2). Q1 discusses a pairing code for shared machines.

## 5. Targets

### 5.1 Where they live

**The operator's config directory, not the app repository**:
`$XDG_CONFIG_HOME/basalt/deploy-targets.json` (default `~/.config/basalt/…`) on
Linux and macOS, `%APPDATA%\basalt\deploy-targets.json` on Windows, or
`--targets=<file>`.

Why not a `deploy.targets.json` committed to the app: a repository is shared,
and a target names **where the operator's SSH key and the `.env` secrets they
type will be sent**. A malicious or careless commit that repoints `production`
to another host would get the secrets typed into the next run. (The
`StrictHostKeyChecking=yes` of §6 would stop a host the operator never
connected to, but not one they have.) Keeping targets per-operator also keeps
`user@host` out of the repo. A repo-local file is Q2.

The file is created 0600 (on POSIX; on Windows in the user's profile) by the
UI's "add target" form, written to a temp file in the same directory and
renamed. It holds **no secret**: no password, no key, no passphrase, no `.env`
value. The UI refuses to read a file that is a symlink or not a regular file.
On POSIX it also refuses a file that is writable by group or others, or that
another user owns: the owner of a file can rewrite it, so a root-owned 0644
file in `/etc` is refused as well. It refuses any directory from the file's
up to `/` that another user owns (root excepted) or that others can write to
without the sticky bit. This is the check sshd's `StrictModes` makes:
whoever can rename an entry in such a directory can replace the file. It
applies to reads and to saves, and a save never replaces a file another user
owns. A `--targets=/tmp/t.json` that someone else created first is
therefore refused, not trusted.

The file is read again for every request, so it could change between the
moment the page shows a confirmation and the moment the server acts on it.
`run`, `env` and `rollback` therefore carry `confirmedTarget`, the target as
the page showed it when the operator confirmed. The server compares it field
by field with the target it has just read. If they differ, it answers 409
`{changed: true}` and sends nothing, and the page reloads the targets so the
operator can check them and confirm again.

### 5.2 Shape

```json
{
  "version": 1,
  "actor": "alice",
  "targets": [
    { "name": "staging", "ssh": "deploy@203.0.113.10", "port": 22, "dir": "/srv/myapp" },
    { "name": "production", "ssh": "myapp-prod", "dir": "/srv/myapp", "node": "/usr/local/bin/node", "protected": true }
  ]
}
```

| Field | Rule | Why |
|---|---|---|
| `version` | `1` | Future shape changes are explicit |
| `actor` | optional; `^[A-Za-z0-9._@+-]{1,64}$` (the server's own `ACTOR`, `audit.ts:19`); default: the local OS user name if it matches, else omitted (the server then records `$USER`) | Becomes `--actor`; self-declared attribution, as RFC 0008 §8.6 says |
| `name` | `^[a-z0-9][a-z0-9-]{0,39}$`, unique | Shown everywhere; used as the API's target key, never in argv |
| `ssh` | `[user@]host`: user `^[a-z_][a-z0-9_.-]{0,31}$`; host a DNS name / `~/.ssh/config` alias `^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$`, an IPv4 literal, or an IPv6 literal `^[0-9A-Fa-f:]{2,39}$` | No leading `-` (option injection), no whitespace, no control character, no `%`, no `ssh://`, nothing ssh would interpret as anything but a destination |
| `port` | optional integer 1–65535; omitted → whatever `~/.ssh/config` or 22 says | Passed as `-p <n>` only when set |
| `dir` | absolute POSIX path `^/[A-Za-z0-9._@+/-]{0,255}$`, no `..` segment, no `//` | The checkout; quoted anyway (§6.3), the grammar is a second wall |
| `node` | optional, same grammar as `dir`; default `node` | A non-interactive SSH shell often lacks nvm's `PATH`: an absolute path fixes it without a login shell |
| `config` | optional relative path `^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,127}$`, no `..` segment | Becomes `--config=<path>` |
| `protected` | optional boolean | `run` and `rollback` require typing the target's name to confirm |

Unknown fields are **refused**, not ignored: someone who writes
`"proxyCommand"` or `"identityFile"` must learn it does nothing, instead of
believing it does. Jump hosts, identity files and proxies belong in
`~/.ssh/config`, under a `Host` alias the target names — that file is the
operator's, read by `ssh` itself, and the UI never parses it.

## 6. The SSH layer

### 6.1 The binary and the spawn

`child_process.spawn(sshPath, argv, { shell: false, windowsHide: true, stdio:
[stdin, 'pipe', 'pipe'], cwd: <home> })`. `sshPath` is `--ssh=<absolute path>`,
or `ssh` resolved through `PATH` on POSIX. On Windows a bare program name is
looked up in the **working directory before `PATH`**: started from a cloned
repository that holds a planted `ssh.exe`, the UI would hand that program the
answers. So on Windows `sshPath` is always absolute:
`%SystemRoot%\System32\OpenSSH\ssh.exe` (the OpenSSH Client feature), else
the first `ssh.exe` found in an absolute `PATH` entry (`.`, relative and empty
entries are skipped; Git's `ssh.exe` qualifies). Every spawn starts in the
operator's home directory, never in the folder the UI was started from.
The environment is the UI process's own, unchanged (it carries
`SSH_AUTH_SOCK`, `HOME`/`USERPROFILE`); **nothing is added to it**, so no
secret can reach `ssh` or, through `SendEnv`, the server. Never `exec`, never a
string command, never a shell on the local side.

### 6.2 argv

```
-T
-o BatchMode=yes                 no password, passphrase or host-key prompt: fail instead
-o StrictHostKeyChecking=yes     an unknown or changed host key fails (overrides accept-new/no from ssh_config)
-o ConnectTimeout=10
-o ServerAliveInterval=15
-o ServerAliveCountMax=3
-o ForwardAgent=no               never -A
-o ForwardX11=no
-o ClearAllForwardings=yes       a LocalForward/RemoteForward in ~/.ssh/config opens no port
-o PermitLocalCommand=no         a LocalCommand in ~/.ssh/config runs nothing locally
-o RequestTTY=no
-o LogLevel=ERROR                no banners on stderr
-e none
[-p <port>]
--
<user@host | alias>
<remote command, one argument>
```

Command-line `-o` values win over `~/.ssh/config` (ssh keeps the first value it
obtains), so the safety options hold whatever the config says, and everything
else — `Host` aliases, `User`, `IdentityFile`, `ProxyJump`, `UserKnownHostsFile`,
`IdentitiesOnly`, a `ControlMaster` the operator set up — is honoured. The UI
never passes `-F`, `-i`, `-J`, `-o ProxyCommand` or `-o StrictHostKeyChecking=no`.

`--` ends ssh's options before the destination, so even a destination that
somehow began with `-` could not become one (and §5.2 refuses it first).

### 6.3 The remote command

ssh joins its arguments and hands them to the remote user's login shell, so the
remote command is **one string the UI builds from validated pieces, each
single-quoted for a POSIX shell** (`'` → `'\''`):

```
cd '<dir>' && exec '<node>' 'node_modules/@basaltkit/deploy/dist/bin.js' '<command>' '--json=1' <flags…>
```

- `node node_modules/@basaltkit/deploy/dist/bin.js`: the copy the app's
  lockfile pinned on that server, the invocation the CLI documents. Never
  `npx`, never `npx --yes`, never `pnpm exec` (lockfile rewrites).
- `<command>` ∈ `status | plan | env | run | rollback | attach | cancel`
  (a closed set in code; `check` is Q5).
- `<flags>` are built by code, never copied from a request: `--answers=stdin`,
  `--detach`, `--via=ui`, `--actor=<validated>`, `--config=<validated>`,
  `--unhold`, `--to=<sha ^[0-9a-f]{7,40}$>`, `--from-seq=<0…2^53−1>`,
  `--follow`, and `<runId>` matching `RUN_ID` from the protocol module.
- `exec` replaces the shell, so a signal or a closed connection reaches the
  deploy, not an intermediate shell.

The remote login shell must be POSIX-compatible (`sh`, `bash`, `dash`, `zsh`).
A `fish` or `csh` account produces no `hello`: the UI reports "no protocol
output — is the account's shell POSIX?" with the captured stderr.

### 6.4 stdin

- No answers: stdin is `'ignore'`.
- Answers (`env`, `run`): stdin is a pipe; the UI writes every answer line
  (`{"v":1,"type":"answer","id":"env.KEY","value":"…"}`, built with
  `JSON.stringify` into a `Buffer`, each checked with `parseAnswerLine` first),
  then **closes** it. All answers go up front: a detached run requires it
  (RFC 0008 §8.1), and for an attended `env` an early EOF makes a refused
  answer fail at once (`answer-invalid`) instead of waiting for a re-prompt the
  UI would then have to collect. The UI shows the refusal by key and asks again
  with a new invocation.
- The `Buffer` is zero-filled after the write completes.

Answers are never in argv, in the environment, in the targets file or in any
log — the only path a value takes is browser → loopback request body → `ssh`
stdin → SSH channel → the deploy's `AnswerChannel` (which redacts it from every
event the moment it is parsed).

### 6.5 Reading the output

`stream.ts` reads stdout as UTF-8 and splits on `\n`:

- **Line cap 1 MiB.** A longer line ends the stream as corrupt (the deploy caps
  `log` text at 8 KiB; only `result` payloads are large, and a `status` or
  `plan` payload is far below this).
- **Before `hello`:** a line that is not a valid `hello` is **foreign text**
  (a `.bashrc` that echoes, a server MOTD script): kept as a diagnostic (at
  most 64 KiB in all), sanitised, never parsed further. No `hello` before EOF
  → "no protocol output" with those diagnostics and stderr.
- **After `hello`:** every line goes through `parseEvent`. A line that fails,
  a `seq` that is not the previous + 1, or anything after `done` ends the
  stream: "the server's output is corrupt at line n" — never skipped, never
  guessed (RFC 0008 §10). A type with `known: false` is passed on as unknown
  and rendered as "an event this UI does not know".
- **`attach`:** the outer `seq` (attach's stream) and the inner `event.seq`
  (the run's) are both checked for continuity; the inner one is the resume key.
- **EOF without `done`:** an abnormal end, never success (RFC 0008 §4.4). A
  last line cut **mid-line** before `done` is a cut connection, not a corrupt
  server: a TCP or SSH drop can end the output at any byte. The stream is
  `abnormal` (transient), and `attach` resumes from the last complete run
  event. A partial line **after** `done` is still corrupt.
- **stderr:** kept up to 64 KiB (the rest counted), sanitised, shown only as
  diagnostics. Exit 255 with nothing on stdout is classified for a useful
  message: `Permission denied (publickey` → "the SSH key was refused — is it
  loaded in your agent (`ssh-add`)?"; `Host key verification failed` → "this
  host's key is not in your known_hosts: connect once from a terminal
  (`ssh deploy@203.0.113.10`) and check the fingerprint"; passphrase needed
  under `BatchMode` → "your key needs a passphrase: add it to your agent";
  timeouts and resolution errors as such. The UI never offers to fix any of
  these itself.

What reaches the browser is the **re-serialised, validated** object, never the
raw line.

### 6.6 Limits

At most 4 concurrent `ssh` processes per UI, and at most one **mutating**
command (`env`, `run`, `rollback`, `cancel`) per target at a time — the
server's lock is the authority; this only stops a double click from producing
two refusals. Read commands time out (`status` 60 s, `plan` 300 s: its preflight
may reach the git remote); a stream (`attach --follow`) has no overall timeout but relies on
`ServerAlive*`.

## 7. The local API

All `POST`, JSON in, JSON or NDJSON out, every rule of §4.3. `{target}` is a
target `name`; the server looks it up — no request ever carries a host, a path
or a flag.

| Route | Body | Remote command | Response |
|---|---|---|---|
| `/api/session` | `{code}` | — | `{token, serverKey}` once |
| `/api/hello` | `{nonce}` | — | `{proof}`: the server's proof (§4.2) |
| `/api/targets` | — | — | the targets (no secret exists to hide) and the file path |
| `/api/targets/save` | `{target}` | — | validated, written atomically; errors by field |
| `/api/targets/remove` | `{name}` | — | — |
| `/api/status` | `{target}` | `status --json=1` | `{hello, result \| error, diagnostics}` |
| `/api/plan` | `{target}` | `plan --json=1` | same, `PlanResult` |
| `/api/env` | `{target, confirmedTarget, answers}` | `env --json=1 --answers=stdin --via=ui --actor=…` | NDJSON stream |
| `/api/run` | `{target, confirmedTarget, answers, unhold?, attended?}` | `run --json=1 --detach --answers=stdin --via=ui --actor=…` | `DetachResult`, or the error (`locked` with holder, `answer-missing`, …) |
| `/api/rollback` | `{target, confirmedTarget, to?}` | `rollback --json=1 --detach --via=ui --actor=… [--to=]` | `DetachResult` or error |
| `/api/attach` | `{target, runId, fromSeq}` | `attach <runId> --json=1 --follow --from-seq=n` | NDJSON stream |
| `/api/cancel` | `{target, runId, second?}` | `cancel <runId> --json=1 --first-only`; with `second: true`, without `--first-only` | `CancelResult` (with `second`), 428 `{second: true}` when the server says the run was already cancelled, or error |
| `/api/quit` | — | — | — |

`answers` is `[{id, value}]`, each checked against `ANSWER_ID` and the
protocol's size limits; ids not in the last `plan`'s `questions` for that
target are refused locally (the server would refuse them too, RFC 0008 §7.1).

The NDJSON stream to the browser has its own small envelope, so local state is
never confused with a server event:
`{kind:'event', event}` · `{kind:'diagnostic', text}` ·
`{kind:'state', state:'connecting'|'reconnecting'|'ended', exitCode?, reason?}`.

**Reconnect.** When an `attach --follow` ssh ends without the run's `done`
(laptop sleep, network change), the server retries with `--from-seq=<last
inner seq + 1>` — 1 s, 2 s, 4 s … capped at 30 s, for up to 10 minutes — and
emits `reconnecting`; the browser never sees a duplicate or a gap. After that
the page offers "re-attach". `run-vanished` and `not-found` end it. An attach
from past the run's `done` (a re-attach after the run ended) prints only
`hello` and `done` with the run's exit code (RFC 0008 §8.4): it ends at once
with that exit code, and the page then offers only "Show from the start".

**Attended runs.** `/api/run` detaches by default: the deploy then survives the
UI, the laptop and the network. `attended: true` (an advanced toggle) runs
`run --json=1 --answers=stdin` in the request's stream instead; closing the
page or quitting the UI then ends the SSH session and the run stops at its
next step boundary (phase 0), which the toggle's label says.

## 8. Screens and flows (MVP)

Every screen shows, at the top, the target's **name, `ssh` destination,
`hello.host` and `app`** — the "am I about to deploy production?" check.

1. **Targets.** List; add/edit/remove (the form validates per field with the
   rules of §5.2 and shows the target file's path). "Check connection" runs
   `status`: green when `hello.protocol === 1`, else the classified error of
   §6.5 with its hint. First launch with no file opens the add form.
2. **Status.** From `StatusResult`: current release (newest `releases[]` with
   `status: ok`: sha, when, actor, via); the process (`pm2` status / `compose`
   lines as text); the lock (holder, stale/corrupt); `activeRun` with an
   "attach" button; `lastRun` (exit code, complete); `hold` with its note and
   the effect on `run` ("will refuse <sha> until the branch moves on —
   override with *Deploy anyway*" → `unhold`). Refresh is manual plus once
   after any action; no polling loop.
3. **Plan.** `plan --json`: findings grouped by level (error blocks *Deploy*),
   `fix` lines as copyable text, the plan's `lines` by step, and the questions
   a run would ask, each with its kind.
4. **Environment form.** One field per `PromptDescriptor`: `secret` →
   `<input type="password" autocomplete="off" spellcheck="false">`, no
   default; `text` → its `default` prefilled. Required marked; `message` as the
   label (text only). Submitting sends the answers with *Deploy* (or with
   *Write .env only* → `/api/env` for first setup), then clears every field
   and drops the in-memory copy; the values are never put in `sessionStorage`,
   the URL, a `console` call or an error message. A refusal comes back by key
   and reason; the operator retypes.
5. **Run.** Confirm dialog (native `<dialog>`, focus trapped, Escape cancels;
   a destructive one opens with focus on *Cancel*, or on the typed-name field
   for a `protected` target, never on the destructive button)
   naming target, host, branch head if known, and "this will migrate the
   database" when the plan says so; `protected` targets require typing the
   target name. Then the live view: steps as a list (`step-start`/`step-end`
   with status and duration), findings, and the log (`log` events, child lines
   tagged by `source`, `warn`/`error` marked by text and icon, not colour
   alone), a final banner from `result`/`error`/`done`. The page keeps the
   last 5,000 log lines in the DOM (older ones dropped with a notice; the full
   log stays on the server: "attach from 0" replays it).
6. **Re-attach.** From status (`activeRun`/`lastRun`) or the run view after a
   drop: `attach` from `seq` 0, or from the last seen `seq + 1` when this tab
   saw part of it (`runId → last seq` kept in `sessionStorage`; not a secret).
7. **Cancel.** First confirm: "stops at the next step boundary before the
   migration; from the migration on, the deploy finishes first". Whether a
   cancel is the first is the **server's** state (`<runId>.cancel`, RFC 0008
   §8.5), and a terminal or an earlier UI session may have sent one already.
   So the first is sent as `cancel --first-only`. When the server answers
   `already-cancelled`, nothing was signalled, and the page asks for the
   second confirmation before it sends the plain `cancel`. Second cancel
   (`second: true` expected) has its own, sterner confirm: "ends the deploy at
   once, mid-step; a migration may be left half-applied — the restore command
   is in the log". Only for a detached run (RFC 0008 §17: attended runs are not
   cancellable this way).
8. **Rollback.** Confirm, with an optional target release picked from
   `releases[]` (only `ok` ones offered; the server still decides), and the
   consequence the CLI states: the commit left is held. Then the same live view.
9. **History.** `releases[]` (last 10) as a table: sha, when, status, actor,
   via, client, migrations, backup, note. Run logs older than the active and
   the last run are reachable only by a `runId` this tab saw (Q3).

**Accessibility and layout.** Landmarks and headings; every input labelled;
errors linked with `aria-describedby`; step progress in one `aria-live=polite`
region (step changes, not every log line); keyboard-only operable; native
`<dialog>`; status never by colour alone; `prefers-color-scheme` and
`prefers-reduced-motion`; a single column below 640 px, the log wraps
(`overflow-wrap: anywhere`) instead of scrolling the page sideways.

## 9. Rendering untrusted text

Everything that came from the server — `log.text`, `finding.message`/`fix`,
`error.message`/`hint`, step titles, release notes, actor, `hello.host`,
compose lines, ssh's stderr — is **data**:

- inserted with `textContent` / `createTextNode` only. The client has no
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or
  `new Function` anywhere (a test greps `src/client`);
- re-sanitised in the browser even though the deploy already did it: ANSI/VT
  sequences, C0/C1 controls except tab and newline, and **bidi controls**
  (U+202A–U+202E, U+2066–U+2069, U+200E/F) removed — a "Trojan Source" line
  must not reorder what the operator reads;
- never turned into a link, never executed: a `fix` or `hint` is copyable
  text, the UI never runs it;
- dispatched on the envelope's `type` only, never on `text` (RFC 0008 §10:
  a build printing a fake `done` is a log line).

## 10. Threat model

| Threat | Position |
|---|---|
| **A remote attacker** | Nothing listens off-machine; the server never listens at all. The UI adds no network-reachable surface anywhere. |
| **A malicious web page** in the operator's browser (CSRF, cross-origin fetch, `<form>` posts) | POST-only JSON API: a cross-site `application/json` POST with an `Authorization` header needs a preflight that is never granted; `Origin` must be exactly ours; `Sec-Fetch-Site` same-origin; no token without the launch code. |
| **DNS rebinding** (`attacker.example` → 127.0.0.1) | Exact `Host` check: the rebound request carries the attacker's host name → 421. Even past it, no token. |
| **Framing / clickjacking** | `frame-ancestors 'none'`, `X-Frame-Options: DENY`. |
| **XSS via server output** (a build printing `<script>`, a hostile `deploy.config.ts`, a compromised server) | Text-only DOM (§9), CSP `script-src 'self'` with no inline/eval, so even an injection could not run; bidi and escape stripping. |
| **Another local user** | Can reach the port, but needs the session token (256 bits) or the launch code; the code is one-time, 120 s, and visible in the opener's argv for an instant — a stolen claim makes the operator's tab fail and the terminal say so (Q1 for shared machines). They cannot read the targets file (0600) and there is no secret in it. |
| **A listener on the UI's port after it stopped** (another local user binds the freed port; the operator's tab is still open) | The page makes the server prove the `serverKey` it never sends (§4.2) before any answer leaves it and after every load. A refused connection or a failed proof empties the page and forgets the session. |
| **A targets file someone else controls** (`--targets=/tmp/t.json` created first by another user, a file in a directory others can write) | Refused unless the operator owns the file and every directory up to `/` is theirs or root's and not writable by others without the sticky bit (§5.1). The confirmed target is bound to the request (`confirmedTarget`). |
| **A planted `ssh.exe` / `rundll32.exe`** in the folder the UI was started from (Windows looks there first) | Absolute paths on Windows; every spawn in the home directory (§6.1, §4.6). |
| **The operator's other local servers** (a dev server on 127.0.0.1:3000) | No cookie exists to leak across ports; the token is in this origin's `sessionStorage` only. |
| **A malicious repository** repointing a target | Targets are not read from the repo (§5.1); `StrictHostKeyChecking=yes` refuses hosts never verified. |
| **Option or command injection into `ssh`** | argv array, no shell; `--` before the destination; closed grammars for every field; each remote piece single-quoted; flags built by code from a closed set; no request field reaches argv unvalidated. |
| **`~/.ssh/config` side effects** (`LocalCommand`, port forwards, agent forwarding, `accept-new`) | Overridden on the command line (§6.2). `ProxyJump`/`ProxyCommand` from the operator's own config are honoured: that file is theirs. |
| **Secrets at rest or in transit** | Never on disk (targets, logs, `sessionStorage`, URL), never in argv or environment (so not in `ps`, not in `/proc/*/environ`, not sent by `SendEnv`), never in a response, never logged; one path only: request body on loopback → `ssh` stdin. The deploy redacts them from every event (RFC 0008 §6). Limit: JavaScript strings cannot be wiped; the UI keeps no reference after the write and zero-fills the `Buffer`s it owns (request body chunks, the stdin payload). A local attacker able to read the UI's memory is root or the operator — out of scope. |
| **Malicious server output** (oversized lines, endless streams, fake events, terminal escapes) | 1 MiB line cap, 64 KiB diagnostics cap, `parseEvent` + `seq` continuity, foreign text before `hello` quarantined as diagnostics, 5,000-line DOM cap; nothing interpreted. |
| **The UI gains power** | None: every action is one of seven CLI commands the SSH account can already type, with `--via=ui` so the audit says how. No root command is reachable (`install`/`bootstrap`/`init` are not in the command set, and refuse `--json` anyway). |
| **Wrong-server deploys** | Name + destination + `hello.host` + `app` on every screen; `protected` targets need the name typed. |
| **Supply chain of the UI itself** | One dependency (`@basaltkit/deploy`, itself dependency-free); docs recommend an exact version with `npx`; published with provenance like every package. |

## 11. Test plan

All in `packages/deploy-ui/tests`, vitest; node environment except the client
tests (`// @vitest-environment jsdom` per file, `@testing-library/dom`, as the
admin UIs test their DOM). Every existing test of `@basaltkit/deploy` keeps
passing; the `ui` hint gets one test there.

### 11.1 Unit

1. **Security middleware** (`security.ts`, pure request → verdict): wrong/missing
   `Host` (incl. `localhost:<port>`, the right host on another port, a rebinding
   name) → 421; non-POST and `OPTIONS` on `/api` → 405 with no `Access-Control-*`;
   missing/foreign `Origin`, `Sec-Fetch-Site: cross-site`, `text/plain` → 403/415;
   missing/wrong/short token → 401 (constant-time path exercised); every
   response carries the exact header set of §4.4; static allowlist refuses
   `/client/../bin.js`, encoded traversal and unknown names.
2. **Session:** first exchange wins; second (right or wrong code) → 409 and a
   terminal notice; expiry at 120 s; token and code are 32 bytes of
   `randomBytes` (injected source in tests).
3. **Idle timer:** fires after N minutes with no request; an open stream holds
   it; a request resets it.
4. **Targets:** every field's accept/refuse table (leading `-`, spaces, NUL, CR,
   `%`, `ssh://`, `..`, relative `dir`, bad port, unknown field, duplicate
   name); file refused when a symlink or group/other-writable; written 0600 by
   rename; the default path per platform.
5. **ssh argv snapshots, per OS** (`linux`, `darwin`, `win32` passed in, not
   detected): with and without `-p`, alias vs `user@host`, every command;
   `--` precedes the destination; no `-A`, `-F`, `-i`, `-J`, `ProxyCommand`;
   the remote string round-trips through a POSIX-shell word splitter to
   exactly the intended words for adversarial `dir`/`node` values (the grammar
   would refuse them; the quoting is tested on its own).
6. **Stream:** split across chunk boundaries and multi-byte UTF-8; foreign
   lines before `hello` → diagnostics (cap); invalid line, `seq` gap, repeat,
   line after `done`, 1 MiB + 1 line → corrupt; unknown type passed as unknown;
   attach outer/inner continuity; EOF without `done` → abnormal.
7. **ssh error classification:** recorded stderr of each failure in §6.5 → the
   right hint.
8. **Secret non-persistence:** a full `run` with secret answers through the
   fake ssh: the values appear on the fake's stdin and **nowhere else** — not
   in the fake's recorded argv or environment, not in any HTTP response body,
   not in the targets file, not in anything written to the UI's stdout/stderr,
   not in any file under a temp `HOME`; the stdin `Buffer` is zero-filled after
   the write.
9. **Dependency boundary:** every import of `@basaltkit/deploy` in `src/` is
   `@basaltkit/deploy/protocol`; every such import in `src/client/` is
   `import type`; `src/client` contains none of the forbidden DOM sinks of §9.
10. **Opener argv** per OS; `--no-open` prints the URL.

### 11.2 The fake `ssh`

`tests/fake-ssh.mjs`, started as `[process.execPath, fake-ssh.mjs]` through the
injectable spawner (so it runs the same on every OS, no `.cmd` shim): it
records its argv, environment keys and stdin to a temp file, checks the argv
against the §6.2 shape, splits the remote command with a POSIX word splitter,
and replays `tests/transcripts/<command>-<scenario>.ndjson` — transcripts
recorded from the real `basalt-deploy --json` against `FakeHost`, plus
hand-written hostile ones (fake `done` inside `log.text`, ANSI and bidi
characters, `<script>`, a `.bashrc` banner before `hello`, a 2 MiB line, a
`seq` gap, a stream cut mid-run, exit 255 with each ssh error). Scenarios can
pause and drop the connection to exercise reconnect.

### 11.3 End-to-end over HTTP

The real server on a random port with the fake ssh, driven by `fetch`:
launch → session → targets save → status → plan → run (detach) → attach with
a drop and resume (no duplicate, no gap in the events the client receives) →
cancel twice → rollback `--to`; plus each refusal of §4.3 against the live
server, and idle shutdown (an open attach and a remote command in flight
hold it; it stops once they end).

### 11.4 Client and coverage

Client logic (`render.ts`, `sanitize.ts`, the NDJSON reader, each view's state
transitions) tested in jsdom: rendering a hostile event yields text nodes only;
secret inputs are `type=password` and are empty after submit; confirm dialogs
gate cancel/rollback/protected runs; the second cancel shows its own warning;
narrow-width class toggles.

The package is **in the coverage gate** like `packages/deploy` (which is not
excluded): `vitest.coverage.config.ts` already collects
`packages/*/src/**/*.ts` and runs `packages/*` as projects, so the server and
the client are measured with no config change. It is not dev-only tooling of
the `cli`/`create-app` kind and has no live-service driver, so neither
exclusion class applies. `bin.ts` stays a few lines of wiring; if it cannot
be covered without spawning a browser, the RFC's implementation PR says so
rather than adding an exclusion line.

## 12. Increments

Each lands with its tests, green on the gate, independently reviewable:

1. **Package skeleton + targets + ssh argv + stream** (no HTTP, no UI): the
   fake ssh and the transcripts.
2. **Local server + security + API + e2e** (still no page beyond a placeholder).
3. **Client:** targets and status → plan and environment form → run, live view,
   re-attach, cancel → rollback, history.
4. **`basalt-deploy ui` hint**, READMEs, the docs site page (EN and PT),
   changesets (`@basaltkit/deploy-ui` initial minor, `@basaltkit/deploy`
   patch). No version is bumped by these PRs; publishing is the maintainer's
   call.

## 13. Decisions taken here

1. A separate operator-side package; never an app dependency; the server
   carries no UI.
2. `node:http` + `tsc`-compiled vanilla TS client; no bundler, no CDN, no
   framework.
3. Loopback-only random port; one-time launch code in the fragment →
   one session token as a bearer header (not a cookie: ports share cookies);
   exact `Host`/`Origin`; POST-only API; strict CSP; no CORS; idle shutdown;
   the server proves a key the page never sends before an answer leaves it.
4. Targets per operator, outside the repo, closed grammar, unknown fields
   refused; ssh specifics live in `~/.ssh/config`.
5. System `ssh` with `BatchMode=yes`, `StrictHostKeyChecking=yes`, forwarding
   and `LocalCommand` off, `--` before the destination; the app's pinned
   `node node_modules/@basaltkit/deploy/dist/bin.js`, quoted piece by piece.
6. Answers up front on stdin, stdin closed, never anywhere else.
7. Runs detach by default; reconnect resumes from the run's `seq`.
8. Every server string is text: no HTML sinks in the client, sanitised twice.

## 14. Open questions

- **Q1. Shared machines.** The launch code is in the opener's argv for an
  instant. A pairing code shown in the terminal and typed into the page would
  remove that window at the cost of one step on every launch. Proposed: a
  `--pair` flag now, the default only if operators use shared hosts.
- **Q2. A repo-local targets file.** Teams may want to share target names and
  directories (not hosts' credentials). Possible later: read a repo file only
  for `dir`/`config`/`protected` and never for `ssh`, or require a one-time
  "trust this file's targets" recorded per operator with a hash of its content.
  Not in the MVP.
- **Q3. Run history.** The protocol has `status.lastRun` but no listing of run
  logs. An additive `runs --json` (ids, command, exit code, actor, from the
  logs' first and last lines) in `@basaltkit/deploy` would let the history
  screen re-attach to any of the last 50 runs. A protocol-minor change in the
  deploy package, proposed separately.
- **Q4. Windows.** CI is Linux-only. argv is snapshot-tested per platform, but
  a real `ssh.exe` run (Node's MSVCRT quoting → OpenSSH-for-Windows parsing of
  the one remote-command argument) is not exercised. Proposed: a
  `windows-latest` job for `deploy-ui` only, running the e2e with the fake ssh
  invoked as `ssh.exe` through a tiny compiled shim — or a manual release
  checklist item until then.
- **Q5. `check`.** `check --json` type-checks the config on the server (it needs
  `tsc` there). Useful as a "why is my config refused" button; left out of the
  MVP command set until someone asks.
- **Q6. Live answers.** Closing stdin after the up-front answers trades the
  server's re-prompt (attempt 2 and 3) for simplicity. Keeping stdin open for an
  attended `env` would let a mistyped value be corrected in the same run.
  Proposed: keep it closed until a user hits it.
- **Q7. `ControlMaster`.** Each action is a fresh SSH connection (status,
  plan, run, attach: ~4 handshakes per deploy). Operators who mind can set
  `ControlMaster auto` in their own `~/.ssh/config` and the UI honours it; the
  UI does not enable it itself (a control socket is a local IPC endpoint, and
  Windows OpenSSH does not support it).

## 15. As built

Implemented in four increments as §12 planned. Where the code differs from
the text above:

1. **Server-side confirmation.** The page's dialogs are not the only gate: the
   API itself refuses `run`, `rollback` and `env` without `confirm: true`
   (428), a `protected` target without `confirmName` equal to its name, and a
   `confirmedTarget` that is no longer what the file says (409). `env` needs a
   confirmation too (it writes the server's `.env`). A `cancel` without
   `second: true` goes out as `cancel --first-only`. When the server answers
   `already-cancelled`, the API answers 428 with `{second: true}`, and the
   page then shows the sterner dialog. The server decides from its own
   marker, so a cancel sent from a terminal or by an earlier UI process
   counts. (The first version kept this in the UI process's memory, and after
   a restart its mild first dialog sent the immediate second signal.)
2. **Stream envelope.** Besides `event`, `diagnostic` and `state`, a stream
   carries `{kind: 'hello', hello}` once (the target bar shows `hello.host`);
   for `attach` the `event`s are the run's own, unwrapped by the server after
   both sequences were checked.
3. **Layout.** `commands.ts` is `remote.ts` (one invocation plus `follow`);
   the views are flat files `src/client/view-*.ts`, because the static
   allowlist is a flat `^[a-z0-9-]+\.js$`. The server reads `dist/client`
   once at start.
4. **Tests.** Client tests use plain jsdom without `@testing-library/dom` (one
   devDependency fewer). The transcripts are recorded from the real
   `@basaltkit/deploy` by `tests/transcripts.test.ts`, which drives the
   deploy's own test helpers (`FakeHost`) and, without
   `RECORD_TRANSCRIPTS=1`, fails when the committed transcripts drift from
   what the code writes. Paths, `ts` and `hello.version` are normalised.
   Narrow width is a CSS media query, not a class toggle.
5. **What the page sends.** Empty optional answers are left out (the deploy
   keeps its default or nothing); a `confirm` question is sent as `yes`/`no`.
   The confirm dialog names the target, destination, host and app, and says
   "this will migrate the database" when a plan line mentions a migration; it
   does not show the branch head (no payload carries it).
6. **Status refresh** happens once after a watched run ends, and on demand.
7. **TypeScript.** The package's test `tsconfig.json` has `rootDir: ".."`
   because the transcript recorder imports `../deploy`'s test helpers; the
   build config is unchanged (`rootDir: src`, `src/client` excluded and
   compiled by `tsconfig.client.json`).

8. **Review fixes.** After an independent review: the server proves itself
   (§4.2); the targets file is checked for ownership, up to `/` (§5.1);
   `confirmedTarget` binds a confirmation to what it showed; absolute
   `ssh.exe`/`rundll32.exe` and a home-directory `cwd` on Windows (§6.1); a
   line cut mid-way resumes instead of ending as corrupt (§6.5); an attach
   past `done` ends with the run's exit code instead of reconnecting for 10
   minutes (§7); a remote command in flight holds the idle stop (§4.5);
   destructive dialogs focus *Cancel* (§8); a resumed step without its
   `step-start` is named by its id.
9. **Residual risks**, stated rather than hidden:
   - The proof is checked immediately before an answer is sent, not bound to
     the request that carries it. A UI that stops in the milliseconds between
     the two, with a listener that binds its port in that window, would
     receive one request. The window is one loopback round trip, and the
     squatter must be waiting for exactly that port.
   - After a reload, the page that loads is whatever answers on the port. A
     squatter can serve its own lookalike page; it cannot read a session the
     stopped page already forgot, and it has no `serverKey` to drive anything
     the operator cares about. The operator's defence is the terminal: a
     stopped UI says so there, and a fresh start prints a new URL.
   - The UI does not push a "stopping" notice on open streams. The page
     learns of the stop on its next request, or when the stream breaks.
   - The cancel gate relies on `--first-only`, which the deploy ships in
     the same release as protocol 1. A protocol-1 deploy without it does not
     exist.

Open questions Q1–Q7 stay open; Q4 (a Windows job) in particular: the argv
is the same on every platform and is snapshot-tested with `linux`, `darwin`
and `win32`; the real `ssh.exe` quoting is not exercised in CI. The Windows
release checklist also covers the program resolution: start the UI from a
folder containing a dummy `ssh.exe` and check that the OpenSSH one runs.

