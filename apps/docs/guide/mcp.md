# MCP (Model Context Protocol)

`@basaltkit/mcp` turns a Basalt app into an [MCP](https://modelcontextprotocol.io)
server — and lets it act as a client. Opt-in routes become tools an AI agent can
call, over **HTTP (any adapter)** or **stdio**. Crucially, a tool call runs
through the *same* neutral request pipeline as HTTP, so **validation, tenancy and
auth apply unchanged** — MCP is just another way in, not a bypass.

::: tip Runtime, not codegen
This is a **runtime** package: it exposes *your app's routes* to agents in
production. It's separate from the dev-only [`@basaltkit/ai`](./ai) /
[`@basaltkit/ai-mcp`](./ai-mcp) layer (which exposes *dev workflows* to your
editor), and it's built on the zero-dependency [`@basaltkit/mcp-core`](./mcp-core).
Basalt speaks MCP's JSON-RPC directly — no external SDK.
:::

[[toc]]

## Where MCP fits

Four packages speak MCP, each with one job — this page is the last row:

| Layer | Package | Role | Runtime? |
| --- | --- | --- | --- |
| Intelligence | [`@basaltkit/ai`](./ai) | The `basalt ai` CLI: analyze, doctor, plan, make, review | dev-only |
| Dev bridge | [`@basaltkit/ai-mcp`](./ai-mcp) | Exposes those dev workflows to your editor over MCP | dev-only |
| Wire | [`@basaltkit/mcp-core`](./mcp-core) | Zero-dependency protocol + generic server + transports | shared |
| Runtime surface | **`@basaltkit/mcp`** | **This page** — opt-in routes become tools for agents | runtime |

## Expose routes as tools

Opt a route in with `meta.mcp`, register `mcpPlugin`, and add `mcpRoutes()` to
your adapter:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify' // or express / hono
import { mcpPlugin, mcpRoutes } from '@basaltkit/mcp'
import { route } from '@basaltkit/http'
import { z } from 'zod'

const routes = [
  route({
    method: 'POST', url: '/projects',
    meta: { mcp: true },                       // → tool `post_projects`
    body: z.object({ name: z.string().min(3) }),
    async handler({ body }) { return db.projects.create(body) },
  }),
  route({
    method: 'GET', url: '/projects/:id',
    meta: { mcp: { name: 'get_project', description: 'Fetch a project by id' } },
    params: z.object({ id: z.string() }),
    async handler({ params }) { return db.projects.find(params.id) },
  }),
]

await createApp({
  plugins: [
    mcpPlugin({ routes, serverInfo: { name: 'my-app', version: '1.0.0' } }),
    fastifyPlugin({ routes: [...routes, ...mcpRoutes()] }), // POST /mcp
  ],
}).boot()
```

- **Opt-in only** — routes without `meta.mcp` are never exposed. `meta.mcp` is
  either `true` or `{ name?, description? }`.
- **Input schema** is generated from the route's `params` + `query` + `body` Zod
  schemas, merged into one flat object.
- **Same pipeline** — a `tools/call` runs enrichers, guards and validation before
  the handler. The tool request inherits an **allowlist** of the caller's
  headers (`authorization`, `cookie`, `x-api-key`, `x-tenant-id`, `host`,
  `accept-language`, `user-agent` — extend it with `mcpPlugin({ forwardHeaders })`),
  the client **ip** (`request.ip`), `request.routePattern` (the tool route's
  template) and the concrete `request.url` (`/projects/p%201?q=x`, not
  `/projects/:id`). Everything else — `x-request-id`, `if-none-match`,
  forwarding and hop-by-hop headers — is dropped.
- **Status is honoured** — a handler that replies `reply.code(403)` (any status
  ≥ 400) produces a tool result with `isError: true`.
- **Cancellation** — `notifications/cancelled` answers the call as cancelled at
  once; a long handler can stop early by checking `toolSignal(request)?.aborted`.
  Over HTTP the cancel may arrive in a later `POST` of the same
  [session](#sessions-and-cancellation).
- **Filtered listing** — `tools/list` over `/mcp` hides the tools the caller
  statically cannot use; see [What `tools/list` shows](#what-tools-list-shows).

::: warning Guards apply — and must be enforceable
A route with `meta.auth` (or `meta.can` / `meta.teamRole`) keeps that guard when
invoked as a tool: an unauthenticated `tools/call` gets the same `UNAUTHORIZED`
error body as an unauthenticated HTTP request, carried in the tool result with
`isError: true`. The flip side: if any route declares `meta.auth` and no
`authPlugin` is registered, the app **refuses to boot** with
`UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) — see
[Security](/guide/security). Over HTTP, pass `Authorization` / tenant headers on
the `POST /mcp` request; over stdio, pass static `headers` to `serveMcpStdio`.
:::

### What the model sees when a tool fails {#what-the-model-sees-when-a-tool-fails}

The MCP client is a language model — and anyone who can read or steer its
context (a prompt injection, a transcript, a log of the conversation). Treat a
tool result as a response sent to an untrusted client. When a tool's handler,
guard or validation throws, the result carries `isError: true` and the same
`{ code, message, details? }` an HTTP client would get, with these boundaries:

| Channel | Reaches the model? | Notes |
| --- | --- | --- |
| `code`, `message` | yes | A toolkit 500 or an `expose: false` error sends a neutral message, exactly as over HTTP |
| `details` | yes — **redacted** | Sanitised for shape, then passed through `redactErrorDetails` (default `redactSensitiveDetails`: the value of any key naming a secret — `password`, `resetToken`, `apiKey`, `secret`, `sessionId`, … — becomes `'[REDACTED]'`; booleans/`null` kept) |
| `internalDetails` | **never** | Log-only: handed to `reportError` (default: the console reporter) with the untouched error |
| stack, cause, unexpected exception text | never | Unexpected errors become `INTERNAL_ERROR` |
| a body your handler sends itself (`reply.code(4xx).send(body)`) | yes — **verbatim** | That is the route's response contract; nothing is redacted there |

```ts
mcpPlugin({
  routes,
  redactErrorDetails: (details) => ({ failed: details.failed }), // your own allowlist
  reportError: (report) => logger.warn(report, 'tool call failed'),
})

// Per route: override (or disable with `false`) for that tool only.
route({ method: 'POST', url: '/kyc', meta: { mcp: { redactErrorDetails: false } }, handler })
```

Redaction is defence in depth, not a licence: keep `details` public by
construction and put operator-only data in `internalDetails`. The HTTP adapters
do not redact by default (their output is unchanged); use
`toErrorResponse(error, { redactDetails })` in your own adapter or error
handler for the same filter.

## Tool schemas & arguments

**Tool names** come from the route's method and path: `GET /skills` →
`get_skills`, `GET /skills/:id` → `get_skills_by_id`, `POST /skills` →
`post_skills`. Override with `meta: { mcp: { name: 'my_tool' } }`.

**Input schema** is generated from the route's `params`, `query` and `body` Zod
schemas, merged into one flat object with the right `required` fields — so the
client knows exactly what to send.

**Argument shape.** `arguments` must be a JSON object (or omitted). An array,
string, number or `null` is refused with JSON-RPC `-32602` before the route runs,
so a malformed call never reaches your handler and never echoes an internal
exception (such as a `TypeError`) back to the client.

**Argument coercion.** MCP clients and LLMs frequently send numbers and booleans
as *strings* (`"7"`, `"true"`). Before validation the bridge coerces each
argument to the scalar type its Zod field declares, so a `z.number()` field
accepts `"7"` and receives `7`. Non-coercible strings are left as-is so genuine
validation errors still surface.

**Structured output.** A tool result always carries the handler's return value as
text (`content`), and — **only when that value is a JSON object** — also as
`structuredContent`. Handlers returning a top-level array or primitive (e.g. a
list endpoint) put the data in `content` only, because MCP requires
`structuredContent` to be an object.

Schema conversion uses Zod's own `z.toJSONSchema`, so a tool's input schema is
described to the client exactly as Zod describes it. **Zod 4 is required** —
see the note on the peer dependency in the package's README.

## stdio & Claude Desktop

For local agents (Claude Desktop, IDEs), serve the same server over stdio. Use a
**dedicated entry** — not your HTTP `server.ts` — that boots the app and serves
stdio, with **no HTTP `listen` and nothing printed to stdout**:

```ts
// src/mcp-stdio.ts
import { serveMcpStdio } from '@basaltkit/mcp'
import { buildApp } from './app.js'

const app = await buildApp({ logLevel: 'silent' }).boot() // includes mcpPlugin
serveMcpStdio(app) // newline-delimited JSON-RPC on stdin/stdout
```

Wire Claude Desktop to it (`claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "my-app": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dist/mcp-stdio.js"]
    }
  }
}
```

Getting this right in practice:

- **Build first.** Claude Desktop runs the compiled `dist/mcp-stdio.js`, so run
  your build after every change. For a dev loop, run the TS entry with
  `node --import tsx src/mcp-stdio.ts` instead.
- **Use an absolute `node` path.** GUI apps on macOS don't inherit your shell
  PATH, so `node`/`npx`/`pnpm` may not be found — point `command` at the absolute
  binary (from `which node`).
- **Keep stdout clean.** stdout is the JSON-RPC channel: set `logLevel: 'silent'`
  and remove any `console.log` in your handlers — one stray line corrupts the
  protocol.
- **Load your env.** The spawned process has no shell, so load your `.env` (Node's
  `process.loadEnvFile()`, or pass vars via the config's `env` field), and make
  sure the DB/services the app boots against are reachable.
- **A silent stdio server is normal.** Run alone it just waits for input — it is
  meant to be spawned by a client, not run by hand. Pipe a message to check it:
  `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp-stdio.js`.

## Consume external MCP servers (client)

The runtime side of *server + client* — point a client at any MCP server:

```ts
import { McpClient, HttpClientTransport, StdioClientTransport } from '@basaltkit/mcp'

const client = new McpClient(new HttpClientTransport('https://host/mcp'))
await client.connect()
const { tools } = await client.listTools()
const result = await client.callTool('get_project', { id: 'p1' })

// …or spawn a stdio server
const local = new McpClient(new StdioClientTransport({ command: 'some-mcp-server' }))
await local.connect()
```

A spawned stdio server does **not** inherit your app's environment: only a
non-secret allowlist (`PATH`, `HOME`, locale, temp dirs — `DEFAULT_INHERITED_ENV`)
plus the explicit `env` reaches it, so `APP_SECRET`, `DATABASE_URL` and provider
keys stay in your process. Pass `inheritEnv: ['GITHUB_TOKEN']` to forward named
variables, or `inheritEnv: true` to deliberately forward everything.

If the command can't be spawned (`ENOENT`) or the server exits, calls in flight
reject instead of crashing your process, and the next call spawns it afresh. A
request the server never answers rejects after `timeoutMs` (default 60 000 ms).

### Register servers with a plugin

`mcpClientPlugin` wires named external servers into the container — it connects
them at boot and closes them on shutdown, so any part of the app can use their
tools through the `MCP_CLIENTS` registry:

```ts
import { mcpClientPlugin, MCP_CLIENTS } from '@basaltkit/mcp'

createApp({
  plugins: [
    mcpClientPlugin({
      servers: {
        search: { type: 'http', url: 'https://search.example/mcp' },
        files: { type: 'stdio', command: 'mcp-files', args: ['--root', '.'] },
      },
    }),
  ],
})

// anywhere with the container:
const clients = container.get(MCP_CLIENTS)
const { tools } = await clients.listTools('search')
const result = await clients.callTool('search', 'query', { q: 'basalt' })
```

Connections are lazy-safe: `callTool` / `listTools` connect on demand, so
`eager: false` defers connecting until first use.

## Transports

| Transport | Server | Client | Adapters |
| --- | --- | --- | --- |
| HTTP (`POST /mcp`) | `mcpRoutes()` | `HttpClientTransport` | fastify · express · hono |
| stdio | `serveMcpStdio()` | `StdioClientTransport` | local process |

The HTTP transport is a neutral `route()`, verified on all three adapters — the
same tool surface regardless of the server underneath.

It is hardened for browsers: a request whose `Origin` is neither same-origin
nor listed in `mcpRoutes({ allowedOrigins })` gets **403**, and the body must be
sent as `application/json` (**415** otherwise), so a cross-site page can never
drive a tool with a visitor's cookies. Non-browser clients send no `Origin` and
are unaffected. By default `initialize` and `tools/list` are anonymous (tool
*calls* still run each route's guards); `mcpRoutes({ auth: true })` requires an
authenticated caller for the endpoint itself. JSON-RPC batches are accepted.

### Sessions and cancellation {#sessions-and-cancellation}

`/mcp` speaks Streamable-HTTP sessions by default. A successful `initialize`
answers with an `Mcp-Session-Id` header; every later `POST` must carry it:

| Request | Answer |
| --- | --- |
| `initialize` | `200` + a new `Mcp-Session-Id` (a failed `initialize` opens none) |
| any other message without the header | **400** — send `initialize` first |
| an unknown, expired or foreign session id | **404** — the client re-initializes (spec behaviour) |
| `DELETE /mcp` with the header | `204`, the session ends (404 if it was not live) |

All requests of a session share one cancellation scope, so a
`notifications/cancelled` `POST`ed while the call runs cancels it — and a
different session, even one that guesses the request id, never can. A session
is **bound to the caller that opened it**: the authenticated `ctx().user` (in
its tenant) or, for an anonymous caller, a keyed fingerprint of its
`Authorization` header (an API key the auth plugins accepted already resolved a
user). The same id presented by anyone else is a 404. Sessions
expire after 30 minutes idle, and at most 1000 live at once (the least recently
used is evicted — its client just re-initializes):
`mcpRoutes({ sessions: { ttlMs, maxSessions } })`.

`HttpClientTransport` (and so `McpClient`/`mcpClientPlugin`) handles the header
for you and ends the session on `close()`.

::: warning Sessions live in process memory
Behind several replicas, route a session to one replica (sticky sessions on
`Mcp-Session-Id`), or run stateless with `mcpRoutes({ sessions: false })` —
each `POST` is then its own session and a cancel only reaches calls of the same
request. A browser client on another origin must be allowed to read the header:
add `Mcp-Session-Id` to your CORS `exposeHeaders`.
:::

### What `tools/list` shows {#what-tools-list-shows}

With `mcpRoutes({ listVisibleOnly })` (default `true`), `tools/list` leaves out
the tools the caller **statically** cannot use. Only side-effect-free checks
decide — the route guards never run for a listing, so listing consumes no rate
limit and writes no audit or denial record:

| Hidden when | Decided by |
| --- | --- |
| the route has `meta.auth` and the caller has no `ctx().user` | built in, when a guard claims `auth` (e.g. `authPlugin`); under an edge-auth waiver nothing is hidden |
| the route has `meta.teamRole` and the caller does not hold that role (or a higher one) in the current tenant | `teamsPlugin`'s visibility check (one membership read) |
| the route has `meta.can` and the caller lacks one of its permissions (RBAC, current scope; `superAdmin` short-circuits) | `permissionsPlugin`'s visibility check (grant reads — no `permission:denied` record) |
| the route has `meta.scopes` and the caller's API key does not hold every scope (or there is no key); or the route has `meta.apiKey: false` and the caller holds a key; or the route is identity-gated (`meta.auth`/`can`/`teamRole`/`audience`) with no `meta.scopes` and the caller's key is narrow (no `*`) | `apiKeysPlugin`'s visibility check (reads `ctx().apiKey` only — no `auth:apikey_rejected` hook) |
| the route has `meta.mfa: true` (or `authPlugin({ requireMfa: true })` applies) and the signed-in caller's session has no second factor (`ctx().amr` lacks `'mfa'`) | `authPlugin`'s visibility check (reads `ctx()` only — no MFA-store lookup) |
| any key whose plugin registers a check in `http:route-visibility` | that plugin's `RouteVisibilityCheck` |

**Not filtered** — listed, and refused on call: `subscribed`/`feature` (deciding
them needs an entitlement read per tool, and an entitlement check may meter
usage — not something a listing may do), an MFA requirement from a
`requireMfa` *function* policy (app code with no purity contract, so it is never
called on a listing), audiences, rate limits and anything a handler checks
itself (e.g. a policy it runs on a loaded resource with `authorize(user,
permission, resource)` — there is no resource at listing time), and a
[`meta.can` resource requirement](/guide/authorization#policies-in-the-guard-resource-requirements)
decided by a policy (its loader never runs on a listing; plain permissions beside
it still filter). Visibility is never authorization: `tools/call` still runs every
guard, for listed and unlisted tools alike. `listVisibleOnly: false` lists every
opted-in tool. stdio listings are never filtered (there is no per-request
caller).

On an exposed deployment, give `/mcp` its own rate-limit budget:
`mcpRoutes({ rateLimit: { limit: 30, windowMs: 60_000 } })` stamps
`meta.rateLimit` on the route, and `securityPlugin` enforces it in a dedicated
bucket. A tool route's own `meta.rateLimit` is enforced by a route guard, so it
applies to tool calls through `/mcp` too, keyed by the `/mcp` caller's ip,
which the tool request inherits. (Auth and guards run identically on both paths.)
A tool call with no caller ip — over stdio, or `MCP.callTool()` without `ip` —
is keyed by the caller's identity (`ctx().user` / `ctx().tenant`) when there is
one; every anonymous ip-less call shares a single fail-closed `unknown` bucket.
Pass `ip` (or resolve it in the adapter) to get per-client buckets.


## Options reference

The tables below are the complete public options of the four entry points.

### `mcpPlugin(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `routes` | `BasaltRoute[]` | — (required) | The routes scanned for `meta.mcp` — typically the same array you pass the adapter |
| `serverInfo` | `{ name: string; version: string }` | `{ name: 'basalt', version: '0.1.0' }` | What `initialize` reports to clients |
| `filter` | `(route: BasaltRoute) => boolean` | expose every opted-in route | A deployment-level gate on top of `meta.mcp` (e.g. hide admin routes in one environment) |
| `forwardHeaders` | `string[]` | none | Extra request headers a tool call inherits, on top of `DEFAULT_FORWARDED_HEADERS` (e.g. a custom tenant header); every other header is dropped |
| `redactErrorDetails` | `ErrorDetailsRedactor \| false` | `redactSensitiveDetails` | Filters a thrown error's public `details` before they enter a tool result (see [What the model sees](#what-the-model-sees-when-a-tool-fails)); `false` sends them as HTTP would. A route overrides it with `meta.mcp.redactErrorDetails` |
| `reportError` | `HttpErrorReporter \| false` | console reporter | Receives every error a tool call throws, `internalDetails` included; `false` reports nothing |

### `mcpRoutes(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `path` | `string` | `'/mcp'` | Where the JSON-RPC POST endpoint mounts |
| `rateLimit` | `{ limit: number; windowMs: number }` | none | Stamps `meta.rateLimit` on `/mcp` (enforced by `securityPlugin` in a dedicated bucket) — the budget for all tool traffic; a tool route's own `meta.rateLimit` applies on top |
| `allowedOrigins` | `string[] \| '*'` | same-origin only | Browser origins allowed to call `/mcp`; a foreign `Origin` gets 403. Requests without `Origin` are unaffected. `'*'` disables the check |
| `auth` | `boolean` | `false` | Sets `meta.auth` on `/mcp` (enforced by `authPlugin`) so even `initialize`/`tools/list` need an authenticated caller |
| `meta` | `Record<string, unknown>` | none | Extra `meta` for the `/mcp` route (e.g. `{ can: 'mcp:use' }`) |
| `listVisibleOnly` | `boolean` | `true` | Hide from `tools/list` the tools the caller statically cannot use — pure checks only (see [What `tools/list` shows](#what-tools-list-shows)) |
| `sessions` | `false \| { ttlMs?: number; maxSessions?: number }` | on — 30 min idle, 1000 live | `Mcp-Session-Id` sessions: required after `initialize`, bound to the caller, scope cross-`POST` cancellation; also mounts `DELETE <path>`. `false` = stateless |

### `serveMcpStdio(app, options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `headers` | `Record<string, string>` | `{}` | Static headers applied to **every** tool call — stdio has no per-request headers, so this is how a local agent carries a service token/tenant |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Inject a stream in tests |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | Inject a sink in tests |
| `maxConcurrentRequests` | `number` | `16` | Requests in flight at once on the connection; one more gets a `-32000` (`SERVER_BUSY`) error. Notifications are never refused |
| `maxLineLength` | `number` | 4 MiB | Longest accepted message line |

Returns a handle whose `close()` detaches the stdin listener.

### `mcpClientPlugin(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `servers` | `Record<string, { type: 'http'; url; headers? } \| { type: 'stdio'; command; args?; env?; cwd?; inheritEnv? }>` | — (required) | Named external servers registered under `MCP_CLIENTS`. A stdio server inherits only `DEFAULT_INHERITED_ENV` plus `env`; `inheritEnv: string[] \| true` widens that |
| `eager` | `boolean` | `true` | Connect all servers at boot (fail fast) vs. lazily on first `callTool`/`listTools` |

## Failure modes & troubleshooting

Tool-level failures are **not** protocol errors: a handler/guard/validation
error comes back as a normal result with `isError: true`, whose text is the same
error body HTTP would have returned (e.g. `{ "code": "UNAUTHORIZED", … }`).
Protocol errors use JSON-RPC codes:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Boot throws `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) | A route declares `meta.auth`/`meta.can`/`meta.teamRole` and no plugin enforces it | Register `authPlugin` / `permissionsPlugin` / `teamsPlugin` — see [Security](/guide/security) |
| `isError: true` with an `UNAUTHORIZED`/`FORBIDDEN` body | The tool's route is guarded and the call carried no (or bad) credentials | Send `Authorization`/tenant headers with `POST /mcp`, or `serveMcpStdio(app, { headers })` |
| JSON-RPC `-32602` `Unknown tool: …` | Tool name not registered — route missing `meta.mcp`, excluded by `filter`, or renamed | Check `tools/list`; remember overrides via `meta.mcp.name` |
| JSON-RPC `-32602` ``tools/call `arguments` must be an object`` | The client sent `arguments` as an array, string, number or `null` | Send an object of named arguments matching the tool's input schema |
| JSON-RPC `-32603` `Internal error` | Something threw outside a tool result (tool failures themselves come back as `isError`) | The text is deliberately generic; check the server logs for the cause |
| JSON-RPC `-32601` `Method not found` | The client called an MCP method the server doesn't implement | Only `initialize`, `ping`, `tools/list`, `tools/call` (plus resources/prompts when registered) exist |
| A tool call returns `RATE_LIMITED` sooner than expected | The tool route's own `meta.rateLimit` applies through `/mcp` too (per caller ip; anonymous calls with no ip share one `unknown` bucket) | Raise the route's budget, key it by identity (`meta.rateLimit.key: 'user'` or `'apiKey'`), or make sure the caller ip / identity is resolved |
| `403` `MCP_ORIGIN_FORBIDDEN` from `POST /mcp` | A browser sent a cross-origin request | Add the page's origin to `mcpRoutes({ allowedOrigins })` |
| `415` from `POST /mcp` | The body was not sent as `Content-Type: application/json` | Send `application/json` (MCP clients do) |
| `400` `Mcp-Session-Id header required` | A message other than `initialize` arrived without a session | Send `initialize` first and echo its `Mcp-Session-Id` (spec clients do), or `mcpRoutes({ sessions: false })` |
| `404` `Session not found` | The session expired, was evicted or ended, the process restarted, another replica answered — or a different caller presented it | Re-initialize; behind replicas use sticky sessions |
| A tool is missing from `tools/list` but callable | The caller statically fails its `meta.auth`/`meta.teamRole`/`meta.can`/`meta.scopes`/`meta.mfa` (listing hides it) | Expected; `mcpRoutes({ listVisibleOnly: false })` lists everything |
| Over stdio, `-32000` `Too many requests in flight` | More than `maxConcurrentRequests` calls at once on the connection | Wait for answers, or raise `serveMcpStdio(app, { maxConcurrentRequests })` |
| A tool reads a header that arrives `undefined` | The header is not in the forwarded-header allowlist | `mcpPlugin({ forwardHeaders: ['x-my-header'] })` |
| Claude Desktop shows a broken/dead server | Something printed to stdout — it is the JSON-RPC channel | `logLevel: 'silent'`, remove `console.log`; see the stdio checklist above |
| `'[REDACTED]'` in a tool error's `details` | The key names a secret and the default `redactErrorDetails` masked it | Rename the key if it is not a secret, move secrets to `internalDetails`, or pass your own `redactErrorDetails` |
| `202` response from `POST /mcp` with empty body | The message was a JSON-RPC *notification* — by spec it gets no reply | Expected behaviour, not an error |

## Testing with the MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) connects
to your server and lets you list and call tools interactively — a visual studio
for MCP:

```bash
# Web UI (opens a browser):
npx @modelcontextprotocol/inspector /absolute/node dist/mcp-stdio.js

# Headless CLI:
npx @modelcontextprotocol/inspector --cli /absolute/node dist/mcp-stdio.js --method tools/list
npx @modelcontextprotocol/inspector --cli /absolute/node dist/mcp-stdio.js \
  --method tools/call --tool-name get_skills
```

Over HTTP, point it at your `POST /mcp` endpoint instead.

## Try it in the playground

The repo's [`apps/playground`](https://github.com/basaltkit/basalt/tree/main/apps/playground)
opts three routes into MCP — `create_project`, `list_projects`, `get_project` —
and ships a stdio entry. Point Claude Desktop at it:

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "basalt-playground": {
      "command": "pnpm",
      "args": ["--filter", "playground", "mcp:stdio"]
    }
  }
}
```

Logging is silenced in that entry because stdout is the JSON-RPC channel. Over
HTTP, the same tools are at `POST /mcp` once the server is running.
