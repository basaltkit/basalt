<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/mcp

Turn a Basalt app into a [Model Context Protocol](https://modelcontextprotocol.io)
server — and let it act as an MCP client. Opt-in routes become tools that AI
agents can call, over **HTTP (any adapter)** or **stdio**. Tool calls run through
the *same* neutral request pipeline as HTTP, so validation, tenancy and auth all
apply unchanged.

This is a **runtime** package — distinct from the dev-only `@basaltkit/ai`
codegen layer. No external SDK; Basalt speaks MCP's JSON-RPC directly.

> **Status: 1.0 (stable).** Server and client, over both HTTP and stdio, are
> settled and covered by semver: breaking changes land only in a new major.

## Server — expose routes as tools

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
    meta: { mcp: true }, // ← exposed as the tool `post_projects`
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

- **Opt-in only**: routes without `meta.mcp` are never exposed.
- **Input schema**: built automatically from the route's `params` + `query` +
  `body` Zod schemas (merged into one flat object).
- **Same pipeline**: a `tools/call` runs enrichers, guards and validation, then
  the handler. The tool request inherits an allowlist of the caller's headers
  (`DEFAULT_FORWARDED_HEADERS`: `authorization`, `cookie`, `x-api-key`,
  `x-tenant-id`, `host`, `accept-language`, `user-agent`; extend with
  `mcpPlugin({ forwardHeaders })`), the client `ip`, `routePattern` (the route
  template) and the concrete `url` built from the arguments. Other headers
  (`x-request-id`, `if-none-match`, forwarding/hop-by-hop) are dropped.
- **Status honoured**: a handler replying `reply.code(>= 400)` yields `isError: true`.
- **Error details redacted for the model**: a thrown error becomes an
  `isError: true` result carrying the same `{ code, message, details? }` an HTTP
  client gets — but the client here is a language model, so `details` pass
  through `redactErrorDetails` first (default `redactSensitiveDetails` from
  `@basaltkit/http`: the value of any key naming a secret — `password`,
  `token`, `apiKey`, `secret`, `sessionId`, … — becomes `'[REDACTED]'`).
  Override it with `mcpPlugin({ redactErrorDetails })` or per route with
  `meta.mcp: { redactErrorDetails }`; `false` sends them as HTTP would. An
  error's log-only `internalDetails` never enter a tool result: they go to
  `mcpPlugin({ reportError })` (default: the console reporter, same policy as
  the HTTP adapters; `false` to silence). An error that escapes a tool's own
  handling (a bug) answers `INTERNAL_ERROR` with the text `Internal error`; the
  original goes to `mcpPlugin({ onError })` (default `reportMcpInternalError`,
  one line on stderr; `false` to silence). A body the handler sends itself
  (`reply.code(4xx).send(body)`) is its response contract and is not redacted.
- **Cancellation**: `notifications/cancelled` answers the call as cancelled at
  once; a handler can stop early by checking `toolSignal(request)?.aborted`.

### Browser safety and endpoint auth

`POST /mcp` answers **403** to a request whose `Origin` is neither same-origin nor
in `mcpRoutes({ allowedOrigins })` (`'*'` disables the check), and **415** unless
the body is `application/json` — a cross-site page can never drive a tool with a
visitor's cookies. Non-browser clients send no `Origin` and are unaffected.
`initialize`/`tools/list` are anonymous by default (tool *calls* still run each
route's guards); `mcpRoutes({ auth: true })` puts `meta.auth` on the endpoint
itself (`meta` adds any other guard key). JSON-RPC batches are accepted.

### Sessions and cancellation

`/mcp` speaks Streamable-HTTP sessions by default: a successful `initialize`
answers with an `Mcp-Session-Id` header, every later POST must carry it (**400**
without it; **404** for an unknown, expired or foreign session — the client
re-initializes), and `DELETE /mcp` with it ends the session. All POSTs of a
session share one cancellation scope, so a `notifications/cancelled` sent while a
call runs cancels it; another session never can. A session is bound to the
caller that opened it (`ctx().user` + tenant; anonymous: a keyed fingerprint
of `Authorization`), expires after 30 min idle, and at most 1000 live at
once (LRU eviction): `mcpRoutes({ sessions: { ttlMs, maxSessions } })`. Sessions
are in-process memory — behind replicas use sticky sessions, or
`mcpRoutes({ sessions: false })` to run stateless. `HttpClientTransport` carries
the header for you and ends the session on `close()`. Browser clients on another
origin need `Mcp-Session-Id` in CORS `exposeHeaders`.

### What `tools/list` shows

`mcpRoutes({ listVisibleOnly })` (default `true`) hides the tools the caller
statically cannot use, using **only side-effect-free checks** — no guard runs for a
listing (no rate-limit consumption, no audit or denial records):

- `meta.auth` tools are hidden from callers without `ctx().user` (when a guard —
  `authPlugin` — claims `auth`);
- any key whose plugin registers an `http:route-visibility` check —
  `teamsPlugin` hides `meta.teamRole` tools from callers without that role in the
  current tenant; `permissionsPlugin` hides `meta.can` tools whose permission(s)
  the caller does not hold (RBAC, in the current scope — the guard's own question);
  `apiKeysPlugin` hides `meta.scopes` tools the caller's API key does not cover (and
  `meta.apiKey: false` tools from key holders, and identity-gated tools without
  `meta.scopes` from narrow keys); `authPlugin` hides `meta.mfa: true`
  (or `requireMfa: true`) tools from a signed-in session without a second factor.

Not filtered (listed, refused on call): `subscribed`/`feature` (an entitlement read per
tool, possibly metered), a `requireMfa` function policy (never called on a listing),
audiences, rate limits, handler-level checks (e.g. a policy the handler runs on a
resource) and `meta.can` resource requirements decided by a policy (their loader
never runs on a listing). Visibility is never authorization —
`tools/call` still runs every guard. stdio listings are not filtered.

### stdio

For local agents (Claude Desktop, IDEs), serve the same server over stdio:

```ts
import { serveMcpStdio } from '@basaltkit/mcp'

const app = await buildApp().boot() // includes mcpPlugin
serveMcpStdio(app) // newline-delimited JSON-RPC on stdin/stdout
```

At most `maxConcurrentRequests` (default 16) requests run at once on the
connection; one more is answered with a `-32000` (`SERVER_BUSY`) error.
Notifications (cancels) are never refused.

## Client — consume external MCP servers

```ts
import { McpClient, HttpClientTransport, StdioClientTransport } from '@basaltkit/mcp'

// Over HTTP
const client = new McpClient(new HttpClientTransport('https://host/mcp'))
await client.connect()
const { tools } = await client.listTools()
const result = await client.callTool('get_project', { id: 'p1' })

// Or spawn a stdio server
const local = new McpClient(new StdioClientTransport({ command: 'some-mcp-server', args: [] }))
await local.connect()
```

A spawned stdio server inherits only a non-secret allowlist of host variables
(`DEFAULT_INHERITED_ENV`: `PATH`, `HOME`, locale, temp dirs) plus `env` — never
`APP_SECRET`, `DATABASE_URL` or provider keys. Use `inheritEnv: ['NAME']` to
forward named variables, or `inheritEnv: true` to opt in to the full environment.

If the command can't be spawned (`ENOENT`) or the server exits, the calls in flight
reject with an error instead of crashing your process, and the next call spawns it
afresh. A request the server never answers rejects after `timeoutMs` (default
60 000 ms).

Or register named servers with a plugin — `mcpClientPlugin` connects them at boot
and exposes them via the `MCP_CLIENTS` registry:

```ts
import { mcpClientPlugin, MCP_CLIENTS } from '@basaltkit/mcp'

createApp({ plugins: [mcpClientPlugin({ servers: {
  search: { type: 'http', url: 'https://search.example/mcp' },
  files:  { type: 'stdio', command: 'mcp-files', args: ['--root', '.'] },
} })] })

// await container.get(MCP_CLIENTS).callTool('search', 'query', { q: 'basalt' })
```

## Transports

| Transport | Server | Client | Adapter-agnostic |
| --- | --- | --- | --- |
| HTTP (`POST /mcp`) | `mcpRoutes()` | `HttpClientTransport` | ✅ fastify / express / hono |
| stdio | `serveMcpStdio()` | `StdioClientTransport` | n/a (local process) |

## Tests

`pnpm --filter @basaltkit/mcp test` — protocol conformance, an HTTP round-trip on
**all three adapters** (client → server → route handler, with tenancy), and stdio
server + client round-trips.

## Rate limiting `/mcp`

`mcpRoutes({ rateLimit: { limit, windowMs } })` stamps `meta.rateLimit` on the
endpoint so `securityPlugin` enforces a dedicated budget. A tool route's own
`meta.rateLimit` also applies when it is invoked as a tool through `/mcp`
(enforced as a route guard), keyed by the `/mcp` caller's ip, which the tool
request inherits. A call with no ip (stdio, `callTool()` without `ip`) is keyed by
the caller's identity when `ctx().user` is set; anonymous ip-less calls share one
fail-closed `unknown` bucket.
