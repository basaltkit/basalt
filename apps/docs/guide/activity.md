# Activity log

[`@basaltkit/activity`](/reference/packages/activity) records a human-readable feed —
"Maria published project X 5 minutes ago" — automatically tied to the current user
and tenant. Perfect for a project timeline, a profile, or a team dashboard.

## Log an action

Register the plugin, then write with a fluent one-liner. Inside a request the
**causer** (user) and **tenant** come from context — you don't pass them:

```ts
import { ACTIVITY, activityPlugin } from '@basaltkit/activity'

const app = await createApp({ plugins: [activityPlugin()] }).boot()
const activity = app.container.get(ACTIVITY)

// inside a request / runWithContext({ user, tenant })
await activity
  .in('project')                              // the log name
  .performedOn('project', 'p1')               // the subject
  .withProperties({ from: 'draft', to: 'published' })
  .log('published')                           // description + save
// → { description: 'published', causerId: 'u1', tenantId: 'acme', ... }
```

Need to attribute an action to someone other than the context user? Chain
`.causedBy(userId)` before `.log(...)`.

## Read the feed

```ts
const projectFeed = await activity.for('project', 'p1') // newest first (default limit 20)
const byMaria      = await activity.byCauser('u1')      // everything a user did
const projectLog   = await activity.inLog('project')    // a whole named log
```

Each record carries `causerId`, the subject (`subjectType`/`subjectId`), the
`description`, `properties` and a timestamp — enough to render "who did what, on what,
when".

## Tenant scoping

In a multi-tenant app, a feed must never leak another organization's activity.
Writes fill `tenantId` from context automatically, and queries are scoped to the
tenant in context.

**With `@basaltkit/tenancy` registered, a query that resolves no tenant throws**
rather than answering with every tenant's records — `activityPlugin` selects
`tenantScoped: 'required'` for you unless you chose otherwise. A feed line is
not an aggregate number: it reads *"Dr. Kiala opened matter 2026/014 for Kwanza
Lda"*, which is another firm's client, by name, in prose.

A single-tenant app has no tenant dimension and is untouched. An operator
console that genuinely means to read across tenants says `tenantScoped: false`
and is obeyed; passing an explicit `tenantId` in the query also bypasses the
automatic scoping.

## Recording from domain events

Wiring a feed by hand is a `hooks.on(...)` per event, and it pulls you towards
calling `activity` from inside your services. `activityRule` keeps them apart —
**the domain emits, this package listens, and neither knows the other** — with
the same shape as `syncRule` in [search](/guide/search) and `bridgeRule` in
[realtime](/guide/realtime).

```ts
import { activityPlugin, activityRule } from '@basaltkit/activity'

activityPlugin({
  rules: [
    activityRule({
      hook: 'matter:opened',
      log: 'matters',
      subject: ({ matter }) => ({ type: 'matter', id: matter.id }),
      description: ({ matter }) => `opened matter ${matter.number}`,
      causer: ({ by }) => by,
    }),
  ],
})
```

`description` returning `null` records nothing, so one hook can produce a line
only for the events worth one.

::: tip A rule never brings down the emitter
`HookBus` propagates a handler's failure to whoever emitted the event. That is
right for an audit trail — a fact you failed to record must not be reported as
recorded — and wrong here: a history line that cannot be written must not fail
the case closure that produced it. Failures go to `onRuleError`, which warns on
the console by default.
:::

## Persisting

The default store is in-memory. In production provide a durable `ActivityStore`
(`activityPlugin({ store })`) — implement `save`/`query`, or use a Prisma/SQLite-backed
store from the ecosystem. See the [package reference](/reference/packages/activity).
