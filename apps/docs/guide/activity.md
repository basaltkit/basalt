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

In a multi-tenant app, a feed must never leak another organization's activity. By
default queries are **scoped to the tenant in context** (`tenantScoped: true`):
inside the `acme` tenant you only see `acme` records; from a central/admin context
(no tenant) you see everything. Writes fill `tenantId` from context automatically.

## Persisting

The default store is in-memory. In production provide a durable `ActivityStore`
(`activityPlugin({ store })`) — implement `save`/`query`, or use a Prisma/SQLite-backed
store from the ecosystem. See the [package reference](/reference/packages/activity).
