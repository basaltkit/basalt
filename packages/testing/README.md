# @basaltkit/testing

Testing kit for Basalt applications: boots the application in memory with `createTestApp`, makes HTTP requests impersonating users and tenants, replaces mail and queue with fake versions that support assertions, and travels through time. You need it whenever you want to write automated tests for your application without real servers, databases, or external services.

## What this module solves

Testing a "real" web application is a lot of work: you'd have to start the server on a port, authenticate a real user, wait for real emails, and wait days to see a subscription expire. None of this is practical in an automated test, which should run in milliseconds and always produce the same result.

This package solves the problem with four tools. `createTestApp` boots your application and injects HTTP requests directly into the Fastify server, without the network — and lets you "pretend" the request comes from a specific user or tenant (`actingAs` / `asTenant`), without going through login. A mail **fake** (a fake object that replaces a real service during tests), `fakeMailer`, records emails instead of sending them; a queue fake, `fakeQueue`, captures jobs instead of running them — both with Laravel-style assertions (`assertSent`, `assertDispatched`). Finally, `time` shifts the clock (`time.travel('15d')`) so you can test expirations and deadlines without waiting.

Everything works with any test runner (Vitest, Jest, node:test…), because nothing here depends on the runner.

## Installation

```bash
pnpm add -D @basaltkit/testing
```

> Note: it depends on `@basaltkit/core`, `@basaltkit/fastify`, `@basaltkit/mailer`, `@basaltkit/queue`, and `fastify`. Projects created with `create-basalt` already include `@basaltkit/testing` in `devDependencies`.

## Get started in 5 minutes

1. Create a simple route and a test. In `tests/health.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { createTestApp } from '@basaltkit/testing'

const health = route({
  method: 'GET',
  url: '/health',
  async handler() {
    return { ok: true }
  },
})

describe('health', () => {
  it('responds 200 with ok: true', async () => {
    const app = await createTestApp({
      plugins: [fastifyPlugin({ routes: [health] })],
    })

    const response = await app.get('/health')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })

    await app.shutdown() // always shut down the app at the end
  })
})
```

2. Run the test:

```bash
pnpm vitest run
```

There's no port, no network, no separate server starting up — the request is injected directly into Fastify (Fastify's own `inject` mechanism).

## Usage guide

### Fluent HTTP requests

`TestApp` has one method per HTTP verb. For verbs with a body (`post`, `put`, `patch`), the second argument is the payload:

```typescript
const created = await app.post('/projects', { name: 'First' })
expect(created.statusCode).toBe(201)
const id = created.json().id

await app.patch(`/projects/${id}`, { name: 'Renamed' })
await app.delete(`/projects/${id}`)
```

The response is a Fastify `LightMyRequestResponse`: use `.statusCode`, `.json()`, `.body`, `.headers`.

### Faking users and tenants (impersonation)

`createTestApp` automatically adds a test plugin that reads the special `x-test-user` / `x-test-tenant` headers and populates `ctx().user` / `ctx().tenant` — the same context your application uses in production. **Never register this mechanism in a real application.**

```typescript
import { ctx } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { createTestApp } from '@basaltkit/testing'

const whoami = route({
  method: 'GET',
  url: '/whoami',
  async handler() {
    const { user, tenant } = ctx()
    return { user: user ?? null, tenant: tenant ?? null }
  },
})

const app = await createTestApp({ plugins: [fastifyPlugin({ routes: [whoami] })] })

// defaults for every subsequent request (chainable)
app.actingAs({ id: 'u1', email: 'ada@example.com' }).asTenant('acme')
const me = await app.get('/whoami')
// → { user: { id: 'u1', email: 'ada@example.com' }, tenant: { id: 'acme' } }

// override for a single request only
const other = await app.get('/whoami', { tenant: 'globex' })
// → tenant: { id: 'globex' }

await app.shutdown()
```

### Fake mail with assertions — `fakeMailer`

Records "sent" emails in memory instead of sending them:

```typescript
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineMail, MAILER } from '@basaltkit/mailer'
import { createTestApp, fakeMailer } from '@basaltkit/testing'

const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Welcome, ${name}!`,
  text: ({ name }) => `Hello ${name}`,
})

it('sends the welcome email', async () => {
  const mail = fakeMailer()
  const app = await createTestApp({ plugins: [mail.plugin] })

  mail.assertNothingSent()
  const mailer = app.container.get(MAILER)
  await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })

  const sent = mail.assertSent(WelcomeEmail, (m) => m.to.includes('ada@example.com'))
  expect(sent.subject).toBe('Welcome, Ada!')

  await app.shutdown()
})
```

`assertSent` returns the first matching message (so you can check the subject, recipients, etc.) and throws `MailAssertionError` if nothing matches; `assertNothingSent` throws if anything was sent. The `mail.sent` array has everything, in order.

### Fake queue — `fakeQueue`

Captures job dispatches **without running them**; `drain()` runs the accumulated jobs through the real handlers:

```typescript
import { expect, it } from 'vitest'
import { z } from 'zod'
import { defineJob } from '@basaltkit/queue'
import { createTestApp, fakeQueue } from '@basaltkit/testing'

const SendWelcome = defineJob({
  name: 'email.welcome',
  schema: z.object({ userId: z.string() }),
  handle: ({ userId }) => console.log('processing', userId),
})

it('dispatches the welcome job', async () => {
  const queue = fakeQueue({ jobs: [SendWelcome] })
  const app = await createTestApp({ plugins: [queue.plugin] })

  await SendWelcome.dispatch({ userId: 'u-1' })

  const captured = queue.assertDispatched(SendWelcome)
  expect(captured.queue).toBe('default')
  expect(captured.payload).toEqual({ userId: 'u-1' })

  // nothing has run yet; now run the real handlers:
  expect(await queue.drain()).toBe(1)

  await app.shutdown()
})
```

### Time travel — `time`

Shifts "now" (`Date.now()` and `new Date()` with no arguments) without depending on the test runner. Explicit dates (`new Date('2026-01-01')`) aren't affected.

```typescript
import { afterEach, expect, it } from 'vitest'
import { time } from '@basaltkit/testing'

afterEach(() => time.restore()) // ALWAYS call this in afterEach

it('the trial expires after 15 days', () => {
  time.travel('15d')                        // advances 15 days (accumulates)
  time.travelTo(new Date('2030-06-01'))     // or pin an exact date
  expect(new Date().toISOString().slice(0, 10)).toBe('2030-06-01')
})
```

The duration format (`'15d'`, `'2h'`, …) is `@basaltkit/core`'s `DurationInput` (`parseDuration`).

## API reference

Exported from `@basaltkit/testing`:

### `createTestApp(options?): Promise<TestApp>`

Creates the application with `createApp` (the same `CreateAppOptions` as `@basaltkit/core`), prepends the impersonation plugin, calls `boot()`, and returns a `TestApp`.

| Parameter | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `options` | `CreateAppOptions` | No | `{}` | Options for `createApp`; your `plugins` are added after the impersonation plugin |

### `TestApp` class

| Member | Signature | Description |
| --- | --- | --- |
| `app` | `BasaltApp` | The underlying application |
| `container` | `Container` (getter) | Dependency container — `app.container.get(TOKEN)` |
| `server` | `FastifyInstance` (getter) | The Fastify server (token `FASTIFY`) |
| `actingAs(user)` | `(user: TestActor) => this` | Sets the default user for subsequent requests |
| `asTenant(tenant)` | `(tenant: string \| { id: string }) => this` | Sets the default tenant for subsequent requests |
| `request(method, url, options?)` | `Promise<LightMyRequestResponse>` | Generic request |
| `get(url, options?)` | same | GET |
| `post(url, payload?, options?)` | same | POST with body |
| `put(url, payload?, options?)` | same | PUT with body |
| `patch(url, payload?, options?)` | same | PATCH with body |
| `delete(url, options?)` | same | DELETE |
| `shutdown()` | `Promise<void>` | Shuts down the application (call at the end of every test) |

`TestActor`: `{ id: string; email?: string; [key: string]: unknown }`.

`TestRequestOptions`:

| Field | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `payload` | `unknown` | No | — | Request body |
| `headers` | `Record<string, string>` | No | — | Extra headers |
| `user` | `TestActor` | No | `actingAs` default | User for this request only |
| `tenant` | `string \| { id: string; … }` | No | `asTenant` default | Tenant for this request only |

### `fakeMailer(options?): FakeMailer`

| Parameter | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `options` | `MailerOptions` | No | `{ from: 'test@basalt.dev' }` | Options for the real `Mailer` (sender, etc.) |

`FakeMailer`:

| Member | Type | Description |
| --- | --- | --- |
| `plugin` | Basalt plugin | Registers the fake mailer — pass it in `createTestApp({ plugins: [mail.plugin, …] })` |
| `sent` | `ResolvedMail[]` | Everything "sent", in order |
| `assertSent(mail, predicate?)` | `(MailDefinition \| string, (m: ResolvedMail) => boolean) => ResolvedMail` | Returns the first match; throws `MailAssertionError` if none |
| `assertNothingSent()` | `() => void` | Throws `MailAssertionError` if anything was sent |

`FAKE_MAILER` — token `createToken<FakeMailer>('testing:mailer')`. *(Advanced.)*

### `fakeQueue(options?): FakeQueue`

| Parameter | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `options.jobs` | `JobDefinition[]` | No | — | Jobs to register in `queuePlugin` (required for `drain()` to run the handlers) |

`FakeQueue`:

| Member | Type | Description |
| --- | --- | --- |
| `plugin` | `queuePlugin(...)` | Registers the fake queue in the test application |
| `dispatched` | `CapturedJob[]` | All dispatches, in order |
| `assertDispatched(job, predicate?)` | `(JobDefinition \| string, (c: CapturedJob) => boolean) => CapturedJob` | Returns the first match; throws `QueueAssertionError` if none |
| `assertNothingDispatched()` | `() => void` | Throws `QueueAssertionError` if anything was dispatched |
| `drain()` | `() => Promise<number>` | Runs the accumulated jobs through the real handlers; returns how many ran |

`CapturedJob`: `{ queue: string; job: string; payload: unknown; context: unknown; options: AddJobOptions }`.

### `time`

| Method | Signature | Description |
| --- | --- | --- |
| `time.travel(duration)` | `(duration: DurationInput) => void` | Advances the clock (accumulates with previous calls) |
| `time.travelTo(date)` | `(date: Date) => void` | Pins "now" to an exact date |
| `time.restore()` | `() => void` | Undoes the patch and resets the offset to zero — always call in `afterEach` |

### Errors

- `MailAssertionError` — code `TEST_MAIL_ASSERTION` (extends `BasaltError`).
- `QueueAssertionError` — code `TEST_QUEUE_ASSERTION` (extends `BasaltError`).

## Common errors and solutions (FAQ)

**The test hangs and Vitest doesn't finish.**
You're missing `await app.shutdown()` at the end of the test. The application keeps resources open until it's shut down.

**`ctx().user` always comes back `undefined` in handlers.**
Make sure you created the app with `createTestApp` (it's the one that installs impersonation) and that you called `actingAs(...)` before the request — or passed `{ user: ... }` in that request's options. Impersonation works through `@basaltkit/fastify` request enrichers; it needs `fastifyPlugin` registered.

**`Expected mail "welcome" to have been sent. Sent: (nothing)`**
The code never actually sent the email, or the `Mailer` used isn't the fake one. Make sure `mail.plugin` is in `createTestApp`'s `plugins` list **before** you resolve `MAILER` from the container.

**`drain()` returns 0 or the handlers don't run.**
Pass the jobs when creating the fake queue: `fakeQueue({ jobs: [MyJob] })`. Without the registration, the runner doesn't know which handler to call.

**A time travel "contaminated" subsequent tests.**
The `Date` patch is global. Call `time.restore()` in `afterEach` — even if only one test travels in time.

**Can I use `actingAs` in production?**
No. The impersonation plugin reads headers (`x-test-user`) without any validation — it's exclusively for tests and only exists inside `createTestApp`.

## How it connects to other modules

- **`@basaltkit/core`** — `createTestApp` wraps `createApp`; `time` uses `parseDuration`; the errors extend `BasaltError`.
- **`@basaltkit/fastify`** — requests are injected into the `FastifyInstance` (token `FASTIFY`); impersonation is a `RequestEnricher` registered in the `http:enrichers` bucket.
- **`@basaltkit/mailer`** — `fakeMailer` registers a real `Mailer` with `MemoryMailDriver`, under the same `MAILER` token the application uses.
- **`@basaltkit/queue`** — `fakeQueue` uses the real `queuePlugin` with a driver that captures instead of running.
- **`@basaltkit/generator`** — tests generated by `basalt make:resource` use `createTestApp` from this package.
- **`create-basalt`** — new projects include `@basaltkit/testing` in `devDependencies` and a ready-to-run startup test.
