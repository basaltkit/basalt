# Testing

[`@basaltkit/testing`](/reference/packages/testing) boots your app **in memory** and
lets you drive it like a real client — no port, no network, no database, no external
services. Requests run in milliseconds and are deterministic. It works with any test
runner (Vitest, Jest, `node:test`).

## Boot the app and make requests

`createTestApp` starts your app and injects HTTP requests straight into the server
(Fastify's `inject`), returning the familiar `get`/`post`/… helpers.

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
    await app.shutdown() // always shut down at the end
  })
})
```

## Run the same suite on Express or Hono

`createTestApp` defaults to Fastify's in-process `inject`. Pass `adapter` to
drive the identical requests through another adapter — useful for conformance
tests of code that targets the neutral `@basaltkit/http` contract:

```ts
import { expressPlugin } from '@basaltkit/express'
import { createTestApp } from '@basaltkit/testing'

const app = await createTestApp({
  adapter: 'express', // or 'hono'; default 'fastify'
  plugins: [expressPlugin({ routes: [health] })],
})
const res = await app.get('/health') // same helpers, same response shape
```

Pass the matching adapter plugin in `plugins`, exactly as with `fastifyPlugin`.
Every driver returns the same `TestResponse` shape (`statusCode`, `headers`,
`body`, `json()`). `'express'` listens on an ephemeral local port (closed on
`shutdown()`); `'hono'` and `'fastify'` never open a socket.
`@basaltkit/express`/`@basaltkit/hono` are optional peers — install the one you
use as a devDependency.

## Act as a user or tenant

Skip login entirely — impersonate the user/tenant a request should come from.
`createTestApp` adds a test-only enricher that populates `ctx().user` / `ctx().tenant`
exactly as production would:

```ts
const res = await app
  .actingAs({ id: 'u1', email: 'ana@acme.io' }) // pretend this user is authenticated
  .asTenant('acme')                              // and this tenant is in context
  .post('/projects', { name: 'Launch' })
```

## Fakes with assertions

Swap mail and queue for **fakes** that record instead of doing. Each exposes a
`.plugin` you register, plus Laravel-style assertions:

```ts
import { createTestApp, fakeMailer, fakeQueue } from '@basaltkit/testing'

const mail = fakeMailer()
const queue = fakeQueue()
const app = await createTestApp({ plugins: [fastifyPlugin({ routes }), mail.plugin, queue.plugin] })

await app.actingAs(user).post('/invite', { email: 'bob@acme.io' })

mail.assertSent(InviteEmail, (m) => m.to.includes('bob@acme.io')) // returns the message
queue.assertDispatched(SendWelcome)
await queue.drain() // run captured jobs through their real handlers
```

`mail.sent` / the queue's captured jobs hold everything in order; `assertNothingSent`
throws if anything was sent.

## Travel through time

Test expirations and deadlines without waiting:

```ts
import { time } from '@basaltkit/testing'

await app.actingAs(user).post('/subscribe', { plan: 'pro', trialDays: 14 })
time.travel('15d')                       // jump 15 days forward
time.travelTo(new Date('2027-01-01'))    // …or to an exact date
// …assert the trial has now expired
time.restore()                           // undo the patch, restore the real clock
```

Everything is deterministic and runner-agnostic. Projects scaffolded with
`create-basalt` already include `@basaltkit/testing` in `devDependencies`.
