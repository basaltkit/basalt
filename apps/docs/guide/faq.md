# FAQ

Short answers to the questions that trip people up most — especially *where*
the snippets in the rest of the docs actually go.

## Where do `app.container.get()`, `ctx().container.get()` and `runWithContext()` go?

The docs show these snippets but rarely say *where* they live, because it depends
on **where your code is running**. A Basalt app has four zones, and each snippet
belongs to one:

| Zone | Where in your code | What you use | Have `app`? | Have `ctx()`? |
| --- | --- | --- | --- | --- |
| **1. Startup** | your `server.ts` / a script | `app.container.get(X)` | ✅ | ❌ |
| **2. Inside a plugin** | `register({ container })` / `boot({ container })` | `container.get(X)` | ❌ | only in hooks |
| **3. A route handler** (during a request) | your `*.routes.ts` handlers | `ctx().container.get(X)` | ❌ | ✅ |
| **4. Outside a request** (script / job / test) | scripts, workers, tests | `runWithContext(…)` | maybe | you create it |

- **`app.container.get(X)`** only works where the `app` object exists — right
  after `createApp().boot()` (your server bootstrap, a one-off script, a test).
  It's **not** available inside a route handler.
- **`ctx().container.get(X)`** is how you reach the same services *during a
  request*. The framework attaches a request-scoped container to `ctx()`.
- **`runWithContext(…)`** is only for code that runs **outside** a request
  (a `node script.ts`, a queue worker, a test) where you must supply the
  `tenant` / `user` / `db` yourself.

::: tip The golden rule
**During an HTTP request**, the framework already prepared everything (`user`,
`tenant`, `container`, `db`) via enrichers — so in a handler you just call
`ctx()`, and you **never** need `runWithContext`.

**Outside a request** there is no `ctx()` yet — so you either use `app.container`
directly (for services that don't need a tenant) or wrap the call in
`runWithContext(…)` (for anything tenant-scoped).
:::

## How do I use a service (like the audit trail) inside a route handler?

Resolve it from the request container with `ctx()`. You're already inside a
request, so the tenant/user are set for you:

```ts
import { ctx, type Container } from '@basaltkit/core'
import { AUDIT } from '@basaltkit/audit'

route({
  method: 'GET',
  url: '/audit',
  meta: { auth: true },
  async handler() {
    const audit = (ctx().container as Container).get(AUDIT)
    return audit.trail() // already scoped to the current tenant
  },
})
```

## When do I actually need `runWithContext()`?

Only when there is **no request** to give you a context — and you're calling
something that reads `ctx()` (most tenant-scoped services do). Typical cases: a
CLI script, a scheduled job, a queue worker, a seed, a test.

```ts
import { runWithContext } from '@basaltkit/core'
import { buildApp } from '../src/app.js'
import { AUDIT } from '@basaltkit/audit'

const app = await buildApp().boot()          // zone 1 — you have `app`
const audit = app.container.get(AUDIT)

// audit.trail() reads ctx().tenant, so give it a context first:
await runWithContext({ tenant: { id: 'acme' }, container: app.container }, async () => {
  console.log(await audit.trail())           // now it knows the tenant
})

await app.shutdown()
```

Getting the service (`.get(AUDIT)`) and *calling* a method that reads `ctx()`
are two different things: inside a request the context already exists; in a
script you create it with `runWithContext`.

## My query throws “no tenant in context” outside a request — why?

Tenant-scoped code (the Prisma tenancy extension, `db()`, most stores) reads the
current tenant from `ctx().tenant`. During a request that's set automatically.
In a script or worker it isn't — so wrap the work in
`runWithContext({ tenant: { id }, db, container }, () => …)`, or, for genuinely
central code, use a client/service that isn't tenant-scoped.

## Where do I register my own service or token?

In a **plugin**. Create a typed token with `createToken`, then bind a factory in
the plugin's `register`:

```ts
import { createToken, definePlugin } from '@basaltkit/core'

export const REPORTS = createToken<ReportService>('reports')

export const reportsPlugin = definePlugin({
  name: 'app:reports',
  register({ container }) {
    container.singleton(REPORTS, () => new ReportService())
  },
})
```

After that, resolve it anywhere with `ctx().container.get(REPORTS)` (in a
handler) or `app.container.get(REPORTS)` (at startup).
