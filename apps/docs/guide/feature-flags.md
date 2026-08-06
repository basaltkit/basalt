# Feature Flags

`@machize/flags` evaluates flags against a context — falling back to the current
request's tenant and user — with per-tenant/user targeting and deterministic
percentage rollouts. Zero dependencies, fully typed.

## Define

```ts
import { defineFlags, flagsPlugin } from '@machize/flags'

export const flags = defineFlags({
  newDashboard: { default: false, tenants: { acme: true } },
  maxUploadMb:  { default: 10, tenants: { pro: 100 }, users: { vip: 500 } },
  betaSearch:   { default: false, rollout: 20 },              // 20% of subjects
  euOnly:       { default: false, rule: (ctx) => ctx.region === 'eu' || undefined },
})

// register it so app code can resolve it from the container
flagsPlugin(flags)
```

## Evaluate

```ts
import { FLAGS } from '@machize/flags'

const flags = container.get(FLAGS)

flags.enabled('newDashboard')          // uses the current request's tenant/user
flags.value('maxUploadMb')             // → 100 for tenant "pro", 500 for user "vip"
flags.enabled('betaSearch', { userId }) // explicit context
flags.all()                            // resolve everything — e.g. to seed a client
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
