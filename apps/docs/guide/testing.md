# Testing

[`@basaltkit/testing`](/reference/packages/testing) boots your whole app **inside
the test process** and lets you drive it like a real client — no port, no
network, no database, no external services. It is decoupled from the test runner
(Vitest, Jest and `node:test` all work, nothing here imports one) and from the
HTTP adapter: the same suite runs unchanged on Fastify, Express or Hono. Reach
for it whenever a test would otherwise need a live server, a logged-in user, a
mailbox or a clock.

[[toc]]

## Mental model

The package is four independent tools that compose. Nothing is global except
the clock — and that one you must reset yourself.

| Piece | Replaces | Scope / lifetime |
| --- | --- | --- |
| `createTestApp()` → `TestApp` | Starting a server and calling it over HTTP | Until `await app.shutdown()` |
| `.actingAs()` / `.asTenant()` | Registering, logging in, sending a tenant header | Sticky on the `TestApp`; overridable per request |
| `fakeMailer()` / `fakeQueue()` | The real mail driver / the real queue backend | The app instance they are registered in |
| `time` | Waiting for a trial, token or lock to expire | **Process-global** until `time.restore()` |

Impersonation is not a Fastify trick. `createTestApp` prepends a hidden plugin
(`basalt:testing:impersonation`) that registers a request **enricher** in the
framework-neutral `http:enrichers` metadata bucket. The enricher reads the
`x-test-user` / `x-test-tenant` headers the request helpers set and writes
`ctx().user` / `ctx().tenant` — which is exactly what auth and tenancy do in
production, and why guards, tenant scoping and audit trails behave identically
on every adapter. Never register that plugin in a real app; only
`createTestApp` adds it.

## Quickstart

One file, copy-pasteable, boots and passes:

```ts
import { describe, expect, it } from 'vitest'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { createTestApp } from '@basaltkit/testing'

const health = route({ method: 'GET', url: '/health', async handler() { return { ok: true } } })

describe('health', () => {
  it('responds 200', async () => {
    const app = await createTestApp({ plugins: [fastifyPlugin({ routes: [health] })] })
    const res = await app.get('/health')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    await app.shutdown() // always — it runs every plugin's shutdown hook
  })
})
```

`createTestApp` takes everything `createApp` takes (`plugins`, `config`) plus
`adapter`, boots the app for you, and returns a `TestApp`. There is no
`listen()` and no `fetch` on the default path: requests go straight into the
router.

## Making requests

`request(method, url, options)` is the primitive; the rest are sugar over it.

```ts
await app.get('/projects')
await app.post('/projects', { name: 'Launch' })              // body as 2nd arg
await app.put('/projects/1', { name: 'Renamed' })
await app.patch('/projects/1', { name: 'Renamed' })
await app.delete('/projects/1')
await app.request('HEAD', '/projects')                        // any other verb

await app.get('/projects', { headers: { 'accept-language': 'pt-PT' } })
```

Bodies are serialized the way Fastify's `inject` does it: a plain object becomes
JSON with `content-type: application/json`, a string is sent verbatim, and a
payload on `GET`/`HEAD` is dropped. Every adapter returns the same
`TestResponse`:

```ts
const res = await app.post('/projects', { name: 'Launch' })
res.statusCode          // 201
res.headers['location'] // header names are lower-cased
res.body                // the raw string body
res.json<Project>()     // parsed — synchronous, no await
```

`res.json()` is synchronous on purpose, so an assertion never needs an extra
`await`. On Express and Hono the response is rebuilt from a real `fetch`
`Response`; multiple `Set-Cookie` headers are collected into
`headers['set-cookie']` as an array.

## Act as a user or tenant

Skip the login round-trip and state who the request is from. The defaults are
sticky (the methods return `this`, so they chain), and any single request can
override them:

```ts
const app = await createTestApp({ plugins: [/* … */] })

app.actingAs({ id: 'u1', email: 'ana@acme.io' }) // becomes ctx().user
   .asTenant('acme')                              // becomes ctx().tenant — { id: 'acme' }

await app.post('/projects', { name: 'Launch' })   // as Ana, in acme

// One-off override, without disturbing the defaults:
await app.get('/projects', { user: { id: 'u2' }, tenant: { id: 'globex', plan: 'pro' } })
```

`actingAs` takes any object with an `id` (extra fields are preserved, so
`{ id, email, platformAdmin: true }` reaches `ctx().user` intact). `asTenant`
takes a string — expanded to `{ id }` — or a full tenant-shaped object.

::: tip Impersonation bypasses authentication, not authorization
The enricher sets the context; it does not mint a token. Guards still run: a
`meta: { can: 'projects:delete' }` route still consults
`@basaltkit/permissions`, and `meta: { teamRole: 'admin' }` still consults the
membership store. So `actingAs` is the right way to test that a *member* gets
`403 TEAM_ROLE_REQUIRED` — seed the membership, don't fake the verdict. See
[Authorization](/guide/authorization) and [Teams](/guide/teams).
:::

## Run the same suite on Express or Hono

`adapter` decides only how requests are dispatched — you still register the
matching adapter plugin yourself:

```ts
import { expressPlugin } from '@basaltkit/express'
import { createTestApp } from '@basaltkit/testing'

const app = await createTestApp({
  adapter: 'express', // or 'hono'; default 'fastify'
  plugins: [expressPlugin({ routes: [health] })],
})
const res = await app.get('/health') // same helpers, same TestResponse
await app.shutdown()                 // closes the listening socket too
```

| `adapter` | How a request travels | Socket | Extra install |
| --- | --- | --- | --- |
| `'fastify'` (default) | `server.inject()` — in-process, connected lazily on the first request | none | none |
| `'express'` | `listen(0, '127.0.0.1')` at boot, then `fetch` | ephemeral local port, closed by `shutdown()` | `@basaltkit/express` + `express` |
| `'hono'` | `hono.fetch(new Request('http://basalt.test' + url))` — in-process | none | `@basaltkit/hono` + `hono` |

`@basaltkit/express` and `@basaltkit/hono` are **optional peers** of
`@basaltkit/testing`: the Fastify path never loads them, and a missing install
fails with an actionable message rather than `ERR_MODULE_NOT_FOUND`. Because
only the dispatch differs, a parameterized `describe.each(['fastify',
'express', 'hono'])` is the cheapest conformance test for anything written
against the neutral `@basaltkit/http` contract — see
[HTTP Adapters](/guide/adapters).

::: warning `app.server()` is Fastify-only, and asynchronous
`await app.server()` resolves the `FASTIFY` token. On `'express'` / `'hono'` it
throws `DI_UNKNOWN_TOKEN` — resolve `EXPRESS` / `HONO` from `app.container`
instead.

It became a method in 2.0: `@basaltkit/fastify` is now an optional peer, loaded
on demand, so this package can never put a second copy of the adapter in your
tree.
:::

## The mail fake

`fakeMailer()` swaps the mail driver for one that records. It returns a
`.plugin` you register (it claims the same `basalt:mailer` name as the real
`mailerPlugin`, so register **one or the other**) plus Laravel-style
assertions:

```ts
import { createTestApp, fakeMailer } from '@basaltkit/testing'
import { InviteEmail } from '../src/mail/invite.js'

const mail = fakeMailer({ from: 'no-reply@acme.io' })
const app = await createTestApp({ plugins: [fastifyPlugin({ routes }), mail.plugin] })

await app.actingAs({ id: 'u1' }).post('/team/invites', { email: 'bob@acme.io' })

const message = mail.assertSent(InviteEmail)                       // by definition
mail.assertSent('invite', (m) => m.to.includes('bob@acme.io'))     // …or by name + predicate
expect(message.subject).toContain('acme')

mail.sent            // ResolvedMail[] — everything, in order
mail.assertNothingSent() // throws if anything was sent
```

Every recorded message is a fully **rendered** `ResolvedMail`:
`{ mail, to, from, cc, bcc, replyTo?, subject, text?, html? }`. That means the
subject/body templates, the shared `layout` and the HTML escaping all really
ran — assert on the rendered strings, not on the input data.
`assertSent` returns the first match so you can drill into it; a miss throws
`MailAssertionError` listing what *was* sent.

::: warning The options object replaces the default sender
`fakeMailer()` with no arguments defaults to `{ from: 'test@basalt.dev' }`.
Pass any options and that default is gone — `fakeMailer({ layout })` has no
`from`, so any mail whose envelope omits `to`/`from` fails with
`MailIncompleteError` (`MAIL_INCOMPLETE`). Always include `from` when you pass
options.
:::

## The queue fake

`fakeQueue()` captures dispatches instead of running them, so a request under
test returns immediately and you assert on the *intent*:

```ts
import { createTestApp, fakeQueue } from '@basaltkit/testing'
import { SendWelcome } from '../src/jobs/send-welcome.js'

const queue = fakeQueue({ jobs: [SendWelcome] }) // register the jobs you dispatch
const app = await createTestApp({ plugins: [fastifyPlugin({ routes }), queue.plugin] })

await app.actingAs({ id: 'u1' }).asTenant('acme').post('/auth/register', { /* … */ })

const job = queue.assertDispatched(SendWelcome, (j) => j.payload.userId === 'u1')
expect(job.queue).toBe('default')
expect(job.options.attempts).toBe(3)          // the resolved AddJobOptions
expect(job.context.tenantId).toBe('acme')     // the serialized context snapshot

expect(await queue.drain()).toBe(1)           // now run the backlog for real
```

`queue.dispatched` holds every capture in order as a `CapturedJob`:
`{ queue, job, payload, context, options }`. `payload` and `context` come from
the envelope the `QueueManager` actually built — `context` is the snapshot of
`requestId`, `correlationId`, `traceId`, `userId` and `tenantId`, so you can
assert that a job dispatched inside a tenant carries that tenant to the worker.
`options` is the resolved `AddJobOptions` (`attempts`, `backoff`, `delayMs`,
`priority`, `removeOnComplete`, `removeOnFail`), which is how you test a
`defineJob({ attempts, backoff })` declaration without a Redis.

`drain()` executes the backlog through the **real** handlers, restoring each
job's context first, and returns how many ran. It empties the pending backlog
but leaves `dispatched` intact, so assertions still work afterwards. Call it to
test the handler and the route in one pass; leave it out to prove the route
only *enqueued*. More on jobs in [Queues & jobs](/guide/queues).

## Travel through time

`time` shifts the clock without a test-runner dependency:

```ts
import { time } from '@basaltkit/testing'
import { afterEach } from 'vitest'

afterEach(() => time.restore()) // do this once, at the top of the file

await app.actingAs(user).post('/subscribe', { plan: 'pro' })

time.travel('15d')                    // relative, cumulative — accepts any DurationInput
time.travel('2h')                     // …now 15 days and 2 hours ahead
time.travelTo(new Date('2027-01-01')) // absolute — replaces the offset

const res = await app.get('/subscription')
expect(res.json().status).toBe('expired')
```

It patches `globalThis.Date` so `Date.now()` and `new Date()` return the
shifted "now"; `new Date(2026, 0, 1)` and `new Date(ms)` are untouched, because
only *current* time moves. Timers are **not** patched — `setTimeout` still
takes real milliseconds; use your runner's fake timers if you need that too.

::: danger The clock is process-global
The offset and the patch live in module state, not per `TestApp`. A test that
travels and never calls `time.restore()` corrupts every later test in the same
worker — typically as a token that is mysteriously expired. Always
`afterEach(() => time.restore())`, and never run time-travelling files with
in-file concurrency.
:::

## Options reference

`createTestApp(options)` — everything from `CreateAppOptions`, plus `adapter`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `plugins` | `BasaltPlugin[]` | `[]` | Your app's plugins. The impersonation plugin is prepended automatically |
| `config` | `Record<string, unknown>` | `{}` | Raw config keyed by plugin name, validated by each plugin's `configSchema` |
| `adapter` | `'fastify' \| 'express' \| 'hono'` | `'fastify'` | How requests are dispatched. `'express'`/`'hono'` need their optional peer installed |

`TestApp`:

| Member | Type | Purpose |
| --- | --- | --- |
| `app` | `BasaltApp` | The booted app — reach `app.hooks` from here to assert on emitted events |
| `container` | `Container` | Resolve services (`container.get(TEAMS)`) to seed state directly instead of over HTTP |
| `server` | `FastifyInstance` | The raw Fastify instance. **Fastify adapter only** |
| `actingAs(user)` | `(TestActor) => this` | Sets the default `ctx().user`. `TestActor` is `{ id, email?, …any }` |
| `asTenant(tenant)` | `(string \| { id }) => this` | Sets the default `ctx().tenant`. A string is expanded to `{ id }` |
| `request(method, url, options?)` | `Promise<TestResponse>` | Dispatch any verb |
| `get/delete(url, options?)` | `Promise<TestResponse>` | Sugar, no body |
| `post/put/patch(url, payload?, options?)` | `Promise<TestResponse>` | Sugar, body as the second argument |
| `shutdown()` | `Promise<void>` | Closes the driver's socket (Express) **and** runs every plugin's shutdown |

`TestRequestOptions` (the last argument of every helper):

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `payload` | `unknown` | — | Request body. Objects are JSON-encoded; ignored on `GET`/`HEAD` |
| `headers` | `Record<string, string>` | `{}` | Extra headers — content negotiation, idempotency keys, a real `authorization` |
| `user` | `TestActor` | from `actingAs` | Impersonate a different user for this one request |
| `tenant` | `string \| { id, … }` | from `asTenant` | Impersonate a different tenant for this one request |

`fakeMailer(options?)` — `options` is a `MailerOptions` (`from`, `replyTo`,
`layout`), default `{ from: 'test@basalt.dev' }`:

| Member | Type | Purpose |
| --- | --- | --- |
| `plugin` | plugin | Register it in `plugins` — claims the `basalt:mailer` name |
| `sent` | `ResolvedMail[]` | Every rendered message, in send order |
| `assertSent(mail, predicate?)` | `(MailDefinition \| string, fn?) => ResolvedMail` | Returns the first match; throws `MailAssertionError` on none |
| `assertNothingSent()` | `() => void` | Throws (naming what was sent) if anything went out |

`fakeQueue(options?)`:

| Option / member | Type | Purpose |
| --- | --- | --- |
| `jobs` | `JobDefinition[]` | Jobs to register so `job.dispatch()` is bound — same as `queuePlugin({ jobs })` |
| `plugin` | plugin | Register it in `plugins` — claims the `basalt:queue` name |
| `dispatched` | `CapturedJob[]` | `{ queue, job, payload, context, options }` per dispatch, in order |
| `assertDispatched(job, predicate?)` | `(JobDefinition \| string, fn?) => CapturedJob` | Returns the first match; throws `QueueAssertionError` on none |
| `assertNothingDispatched()` | `() => void` | Throws (naming what was dispatched) if anything was enqueued |
| `drain()` | `() => Promise<number>` | Runs the pending backlog through the real handlers, with context restored |

`time`:

| Member | Type | Purpose |
| --- | --- | --- |
| `travel(duration)` | `(DurationInput) => void` | Adds to the offset — `'15d'`, `'2h'`, `90_000` |
| `travelTo(date)` | `(Date) => void` | Sets the offset so "now" is that instant |
| `restore()` | `() => void` | Unpatches `Date` and zeroes the offset. Mandatory in `afterEach` |

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `Error: createTestApp({ adapter: 'express' }) requires @basaltkit/express …` | — | boot | `adapter: 'express'`/`'hono'` without the optional peer (and its framework) installed |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | — | `await app.server()` on a non-Fastify adapter, or a request with no adapter plugin in `plugins` |
| `PluginDependencyError` | `PLUGIN_DEPENDENCY` | boot | `Duplicate plugin` — `fakeMailer().plugin` next to `mailerPlugin`, or `fakeQueue().plugin` next to `queuePlugin` |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | A route under test declares `meta.auth` / `meta.can` / `meta.teamRole` but the test app didn't register the enforcing plugin |
| `TenantRequiredError` | `TENANT_REQUIRED` | 400 | Tenant-scoped code ran with no tenant — call `.asTenant('acme')` |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 | A `meta.teamRole` route ran with no user **or** no tenant in context, or the membership was never seeded |
| `InvalidCanMetaError` | `PERMISSION_META_INVALID` | 500 | A route declares `meta.can` with a shape the guard can't enforce — every request to it fails closed |
| `JobNotRegisteredError` | `QUEUE_JOB_NOT_REGISTERED` | — | `job.dispatch()` for a job never passed to `fakeQueue({ jobs })` |
| `MailAssertionError` | `TEST_MAIL_ASSERTION` | — | `assertSent` / `assertNothingSent` failed |
| `QueueAssertionError` | `TEST_QUEUE_ASSERTION` | — | `assertDispatched` / `assertNothingDispatched` failed |

- **A test passes alone and fails in the suite** — almost always the clock.
  `time` is process-global; add `afterEach(() => time.restore())` to the file
  that travels.
- **`assertDispatched` finds nothing although the work happened** — you
  registered the real `queuePlugin`. With no Redis connection it falls back to
  the **sync** driver, which runs jobs inline: the side effect happens, but
  nothing is captured. Register `fakeQueue().plugin` instead.
- **`403`/`401` on a route you just impersonated into** — impersonation fills
  the context, it does not satisfy guards. Register the enforcing plugin
  (`authPlugin` / `permissionsPlugin` / `teamsPlugin`) *and* seed the grant or
  membership through `app.container`.
- **The suite hangs, or Express tests leak ports** — a missing
  `await app.shutdown()`. It is what closes the ephemeral socket and runs
  driver/connection shutdown; put it in `afterEach`.
- **`TENANT_REQUIRED` from code that "obviously" has a tenant** — the tenant
  only exists inside a request. Service calls made directly on `app.container`
  run outside the enricher, so pass the tenant explicitly or wrap them in a
  request. See [Tenancy](/guide/tenancy).

## Where to next

- [HTTP Adapters](/guide/adapters) — the neutral contract that makes
  `adapter: 'express' | 'hono'` a one-line change.
- [Queues & jobs](/guide/queues) — `defineJob`, retries and the drivers behind
  `fakeQueue`.
- [Notifications & mail](/guide/notifications) — the mails that `fakeMailer`
  renders.
- [Teams](/guide/teams) and [Authorization](/guide/authorization) — the guards
  you exercise with `actingAs` / `asTenant`.
- [Build a notes SaaS](/cookbook/notes-saas) — the harness used end to end.
