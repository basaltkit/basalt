# Feature Flags

`@basaltkit/flags` evaluates flags against a context — falling back to the current
request's tenant and user — with per-tenant/user targeting and deterministic
percentage rollouts. Zero dependencies, fully typed.

[[toc]]

## Define

```ts
// src/flags.ts
import { defineFlags } from '@basaltkit/flags'

export const flags = defineFlags({
  newDashboard: { default: false, tenants: { acme: true } },
  maxUploadMb:  { default: 10, tenants: { pro: 100 }, users: { vip: 500 } },
  betaSearch:   { default: false, rollout: 20 },              // 20% of subjects
  euOnly:       { default: false, rule: (ctx) => ctx.region === 'eu' || undefined },
})
```

`rule` receives the full `FlagContext` — `{ tenantId?, userId? }` plus any extra
keys you pass at evaluation time (`region` above). Returning `undefined` falls
through to the next resolution step.

## Wire into an app

Register the typed instance with `flagsPlugin` so any code can resolve it from
the container under the `FLAGS` token:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { FLAGS, flagsPlugin } from '@basaltkit/flags'
import { flags } from './flags.js'

const app = await createApp({
  plugins: [flagsPlugin(flags)],
}).boot()

const resolved = app.container.get(FLAGS)
resolved.enabled('betaSearch', { userId: 'vip' }) // explicit context
```

::: tip Keep autocompletion
The `FLAGS` token erases the catalog's key types. Import your typed `flags`
instance directly (as above) — or cast the resolved value — to keep key
autocompletion and value inference on `enabled`/`value`/`all`.
:::

## Evaluate

Inside a request, the tenant and user come from the context automatically — no
plumbing per call:

```ts
import { flags } from './flags.js' // the typed instance keeps key autocompletion

flags.enabled('newDashboard')          // uses the current request's tenant/user
flags.value('maxUploadMb')             // → 100 for tenant "pro", 500 for user "vip"
flags.enabled('betaSearch', { userId: 'u1' }) // explicit context override
flags.value('euOnly', { region: 'eu' })        // custom context key read by `rule`
flags.all()                            // resolve everything — e.g. to seed a client
```

## End to end: gate a route and seed the client

```ts
import { z } from 'zod'
import { route } from '@basaltkit/fastify'
import { HttpError } from '@basaltkit/fastify'
import { flags } from './flags.js'

// Gate a server route — context (tenant/user) is implicit inside the handler.
export const dashboard = route({
  method: 'GET',
  url: '/dashboard',
  handler() {
    if (!flags.enabled('newDashboard')) throw new HttpError(404, 'Not found')
    return { layout: 'v2', maxUploadMb: flags.value('maxUploadMb') }
  },
})

// Bootstrap the browser: resolve everything once and ship it to the client.
export const bootstrap = route({
  method: 'GET',
  url: '/bootstrap',
  handler: () => ({ flags: flags.all() }),
})
```

## Resolution order

Most specific wins:

1. **`rule`** — a custom predicate (return `undefined` to fall through)
2. **`users[userId]`** — explicit per-user override
3. **`tenants[tenantId]`** — explicit per-tenant override
4. **`rollout`** — deterministic bucket for boolean flags (a subject always gets
   the same answer, so a rollout is stable as it widens)
5. **`default`**

Because evaluation reads the request context automatically, the same
`flags.enabled('x')` call returns the right answer per tenant with no plumbing.
