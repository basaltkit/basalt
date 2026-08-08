# @machize/flags

Feature flags for Machize: switches that let you turn parts of the application on or off (for everyone, for a specific customer, for a user, or for a gradual percentage of people) without deploying new code. You need this module when you want to roll out features safely and in a controlled way.

## What this module solves

A **feature flag** is a switch in the code: instead of "this feature exists for everyone as soon as I deploy", you get "this feature exists, but it's only turned on for whoever I decide". This lets you roll out a new dashboard to a pilot customer first, give different limits to different plans, or enable something new for 10% of users and ramp up with confidence.

This module gives you a **typed** way (TypeScript knows the name and type of each flag) to declare flags with: a default value, exceptions by **tenant** (customer/organization in a SaaS application), exceptions by user, **percentage rollout** (0–100% of subjects, deterministically — the same user always sees the same result, with no "flickering"), and custom rules in code.

And because it's integrated into Machize, flag evaluation automatically uses the **current request context**: if the request belongs to the "acme" tenant and the "vip" user, you just ask `flags.enabled('newDashboard')` — you don't need to pass who the user is, the framework already knows. Flags aren't just booleans: they can hold any type of value (numbers, strings, objects), which is useful for limits and per-plan configuration.

## Installation

```bash
pnpm add @machize/flags
```

Depends only on `@machize/core`. No database or external services needed — flags are defined in code.

## Get started in 5 minutes

1. **Define the flags** with `defineFlags` — each flag has, at minimum, a `default` value.
2. **Register the plugin** on the application.
3. **Evaluate the flags** wherever you need them.

```ts
import { createApp } from '@machize/core'
import { defineFlags, FLAGS, flagsPlugin } from '@machize/flags'

// 1. Define the flags (e.g. in a file like src/flags.ts)
const flags = defineFlags({
  newDashboard: { default: false, tenants: { acme: true } },
  maxUploadMb: { default: 10, tenants: { pro: 100 } },
  betaSearch: { default: false, rollout: 25 }, // enabled for 25% of users
})

// 2. Register the plugin
const app = await createApp({
  plugins: [flagsPlugin(flags)],
}).boot()

// 3. Evaluate — here with explicit context
console.log(flags.enabled('newDashboard', { tenantId: 'acme' }))  // true
console.log(flags.enabled('newDashboard', { tenantId: 'other' })) // false
console.log(flags.value('maxUploadMb', { tenantId: 'pro' }))       // 100

await app.shutdown()
```

Inside an HTTP request you don't need to pass the context — the flag reads the tenant/user from the current request:

```ts
// In a route/handler, with the tenant and user already in the request context:
if (flags.enabled('newDashboard')) {
  // show the new dashboard
}
```

## Usage guide

### Default values and tenant/user exceptions

Each flag resolves to the **most specific** value available. The priority order is:

1. `rule` (custom rule) — if it returns a value
2. `users` — exception for the current user
3. `tenants` — exception for the current tenant
4. `rollout` — percentage (booleans only)
5. `default` — the base value

```ts
import { defineFlags } from '@machize/flags'

const flags = defineFlags({
  maxUploadMb: {
    default: 10,
    tenants: { pro: 100 },  // customers on the "pro" plan get 100 MB
    users: { vip: 500 },    // the "vip" user gets 500 MB, no matter what
  },
})

flags.value('maxUploadMb', {})                                  // 10
flags.value('maxUploadMb', { tenantId: 'pro' })                 // 100
flags.value('maxUploadMb', { tenantId: 'pro', userId: 'vip' })  // 500 (user beats tenant)
```

Note that flags can be **any type** — this one is numeric. `flags.value(...)` returns the right type (here, `number`), inferred by TypeScript.

### Percentage rollout (gradual launch)

For **boolean** flags, `rollout: 25` enables the flag for 25% of subjects. The subject is `userId` (or `tenantId`, if there's no user). The choice is **deterministic**: it's based on a hash of the pair (flag name, subject), so the same user always sees the same result — and different flags get different distributions.

```ts
import { defineFlags } from '@machize/flags'

const flags = defineFlags({
  betaSearch: { default: false, rollout: 50 },
})

// Stable: the same user always gets the same answer
flags.enabled('betaSearch', { userId: 'user-1' }) // always the same for 'user-1'

// Without a subject (neither userId nor tenantId), rollout doesn't apply → falls back to default
flags.enabled('betaSearch', {}) // false
```

To ramp up the rollout (25 → 50 → 100), just change the number and deploy: whoever was already included stays included.

### Custom rules

A `rule` is a function that receives the context and returns a value (which wins over everything) or `undefined` (which lets evaluation continue to the next layers). The context accepts extra fields beyond `tenantId`/`userId`:

```ts
import { defineFlags } from '@machize/flags'

const flags = defineFlags({
  europeLaunch: {
    default: false,
    rule: (ctx) => (ctx['region'] === 'eu' ? true : undefined),
  },
})

flags.value('europeLaunch', { region: 'eu' }) // true (the rule decided)
flags.value('europeLaunch', { region: 'us' }) // false (the rule returned undefined → default)
```

### Evaluating with the request context (automatic)

When you don't pass a context, the flag reads `tenant.id` and `user.id` from the current request's context (placed there by the tenancy/auth plugins):

```ts
import { runWithContext } from '@machize/core'
import { defineFlags } from '@machize/flags'

const flags = defineFlags({
  newDashboard: { default: false, tenants: { acme: true } },
})

// In tests/scripts you simulate the context like this; in HTTP requests it's automatic
const value = await runWithContext({ tenant: { id: 'acme' } }, () =>
  flags.value('newDashboard'),
)
console.log(value) // true
```

### Resolving all flags at once

Useful for sending flags to the frontend at the start of a session:

```ts
const allFlags = flags.all({ tenantId: 'acme', userId: 'u1' })
// { newDashboard: true, maxUploadMb: 10, betaSearch: false, … }
```

### Getting the flags from the container

The plugin registers the instance under the token `FLAGS`:

```ts
import { createApp } from '@machize/core'
import { FLAGS, flagsPlugin, defineFlags } from '@machize/flags'

const flags = defineFlags({ newDashboard: { default: false } })
const app = await createApp({ plugins: [flagsPlugin(flags)] }).boot()

const instance = app.container.get(FLAGS)
instance.enabled('newDashboard')
```

Note: through the token, the generic type of the flags is erased (`FeatureFlags<FlagsShape>`) — to keep the exact names/types of your flags, import the instance created with `defineFlags` directly from your module.

## API reference

### `defineFlags(defs)`

`defineFlags<TShape extends FlagsShape>(defs: TShape): FeatureFlags<TShape>` — creates the typed instance from an object `{ flagName: FlagDefinition }`.

### `interface FlagDefinition<T>`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `default` | `T` | Yes | — | Value when nothing else applies. |
| `tenants` | `Record<string, T>` | No | — | Exceptions by tenant id. |
| `users` | `Record<string, T>` | No | — | Exceptions by user id (beat tenant exceptions). |
| `rollout` | `number` (0–100) | No | — | Percentage of subjects with the flag enabled. Only applies when `default` is boolean and there's a `userId` or `tenantId`. Deterministic per (flag, subject). |
| `rule` | `(context: FlagContext) => T \| undefined` | No | — | Custom rule; a returned value wins over everything, `undefined` passes to the next layer. |

### `class FeatureFlags<TShape>`

| Method | Signature | Description |
|---|---|---|
| `value` | `value<K extends keyof TShape>(key: K, context?: FlagContext): FlagValue<TShape[K]>` | Resolves the flag for the given context (or the current request's). |
| `enabled` | `enabled<K extends keyof TShape>(key: K, context?: FlagContext): boolean` | `true` when the flag resolves to exactly `true`. |
| `all` | `all(context?: FlagContext): { [K in keyof TShape]: FlagValue<TShape[K]> }` | Resolves all flags at once. |

### `type FlagContext`

`{ tenantId?: string; userId?: string } & Record<string, unknown>` — you can add your own fields (e.g. `region`) to use in `rule`. When omitted, it's filled from the request context (`ctx().tenant.id` and `ctx().user.id`).

### `flagsPlugin(flags)`

`flagsPlugin<TShape>(flags: FeatureFlags<TShape> | TShape)` — accepts an instance created with `defineFlags` **or** the definitions object directly; registers it in the container under the token `FLAGS`.

### `FLAGS`

Dependency injection token: `app.container.get(FLAGS)` returns `FeatureFlags<FlagsShape>`.

### Helper types (Advanced)

| Export | Description |
|---|---|
| `type FlagsShape` | `Record<string, FlagDefinition<unknown>>` — the shape of the definitions object. |
| `type FlagValue<D>` | Extracts the value type from a `FlagDefinition` (`FlagValue<FlagDefinition<T>>` = `T`). |

## Common errors and solutions (FAQ)

**`rollout` doesn't do anything.**
Two common causes: (1) the flag isn't boolean — rollout only applies when `default` is `true`/`false`; (2) there's no subject — without `userId` or `tenantId` in the context, the flag falls back to `default`. Check that the request has an identified user or tenant (or pass them explicitly).

**I set `tenants: { acme: true }` but inside the request the flag comes back `false`.**
The request context doesn't have the tenant. Check that the tenancy plugin is configured and identifies the tenant before you evaluate the flag, or pass `{ tenantId: 'acme' }` explicitly.

**My `rule` returns `false` and I expected it to fall through to the tenant override.**
`false` is a valid value — only `undefined` lets evaluation continue. If you want "not deciding", return `undefined`.

**Can I change a flag without deploying?**
In this module, definitions live in code, so changing values requires a deploy. What you avoid is deploying *functionality*: the new code is already there, and the flag controls who sees it. For dynamic runtime values, use a `rule` that queries your own source (database, remote config).

**`app.container.get(FLAGS)` lost the types of my flags.**
Expected behavior: the token is generic. Import the instance from `defineFlags` in your own module to get autocomplete and exact types.

**I renamed a flag and the rollout "shuffled" who was included.**
The deterministic bucket depends on the flag name — renaming redistributes subjects. Avoid renaming flags mid-rollout.

## How it connects to other modules

- **`@machize/core`** — provides `createApp`, the container, the tokens, and the request context where automatic `tenantId`/`userId` come from.
- **`@machize/tenancy`** and **`@machize/auth`** — these plugins place `tenant` and `user` in each request's context; with them active, `flags.enabled('x')` works without an explicit context.
- **`@machize/subscriptions`** — common pattern: using a `rule` to tie features to the tenant's subscription plan.
- **`@machize/http` / web adapters** — typically expose a route that returns `flags.all()` to the frontend at session start.
