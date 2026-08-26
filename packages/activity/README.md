<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/activity

Activity log for Basalt applications: a feed in the style of "Maria published project X 5 minutes ago", built with a fluent API and automatically associated with the current user and tenant.

You need this module when you want to show users a **readable history** of what happened — on a project page, a user profile, a team dashboard. (Inspired by `spatie/laravel-activitylog` from the Laravel world.)

---

## What this module solves

An **activity log** stores actions in a format meant for people: who did it (**causer**), on what (**subject** — e.g. the project "p1"), what was done (a description like `'published'`) and extra details (**properties**, e.g. `{ from: 'draft', to: 'published' }`). With these fields you can build feeds like "recent activity on this project" or "everything this user did".

Writing this by hand for every action is repetitive and easy to forget — especially the "who" and "which organization". This module reads the **active context** of the application (`@basaltkit/core`): if there is a `user`/`tenant` in the context, the record comes out with `causerId` and `tenantId` filled in without you passing anything. Writing becomes a fluent one-liner: `activity.in('project').performedOn('project', id).log('published')`.

In a multi-tenant application (several customers on the same database) there is also the danger of a feed showing activity from another organization. By default, **queries are scoped to the tenant in context** (`tenantScoped: true`): inside the "acme" tenant you only see "acme" records; outside any tenant (central/admin context) you see everything.

## Installation

```bash
pnpm add @basaltkit/activity
```

Depends only on `@basaltkit/core`. The default storage is in-memory (`MemoryActivityStore`) — in production, provide a persistent `ActivityStore` (see "Custom store").

## Get started in 5 minutes

**1. Register the plugin:**

```ts
import { createApp } from '@basaltkit/core'
import { ACTIVITY, activityPlugin } from '@basaltkit/activity'

const app = await createApp({
  plugins: [activityPlugin()],
}).boot()

const activity = app.container.get(ACTIVITY)
```

**2. Log an action** (inside a request, the user and tenant come from context):

```ts
import { runWithContext } from '@basaltkit/core'

await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, async () => {
  const record = await activity
    .in('project')                                  // log named 'project'
    .performedOn('project', 'p1')                   // subject: project p1
    .withProperties({ from: 'draft', to: 'published' })
    .log('published')                               // description + saves

  // record.causerId === 'u1', record.tenantId === 'acme'
})
```

**3. Read the project feed (most recent first):**

```ts
const feed = await activity.for('project', 'p1')
for (const record of feed) {
  console.log(`${record.causerId} ${record.description}`, record.properties)
}
```

## Usage guide

### The fluent builder

`activity.in(logName)` starts an `ActivityBuilder`; every step is optional except the final `log(description)`, which saves and returns the record:

```ts
const record = await activity
  .in('billing')                       // group under a named log ('default' if omitted)
  .performedOn('invoice', 'i1')        // subject (type + id)
  .causedBy('system')                  // force the causer (otherwise comes from ctx().user.id)
  .withProperties({ amount: 4900 })    // extra details
  .log('generated')
```

Shortcut for the default log:

```ts
await activity.performedOn('invoice', 'i1').log('generated') // log: 'default'
```

Returned records are frozen (`Object.freeze`) — immutable once created.

### Querying feeds

All of these return records **most recent first**, with a default limit of 20:

```ts
await activity.for('project', 'p1')        // feed for a subject
await activity.for('project', 'p1', 50)    // with an explicit limit
await activity.inLog('billing')            // feed for a named log
await activity.byCauser('u1')              // everything u1 did
await activity.query({                     // free-form query
  log: 'project',
  subjectType: 'project',
  causerId: 'u1',
  limit: 10,
})
```

### Tenant isolation

With `tenantScoped: true` (the default), any query made **inside** a context with a tenant is automatically filtered to that tenant:

```ts
import { runWithContext } from '@basaltkit/core'
import { Activity } from '@basaltkit/activity'

const activity = new Activity()

await runWithContext({ tenant: { id: 'acme' } }, () =>
  activity.performedOn('project', 'p1').log('acme thing'),
)
await runWithContext({ tenant: { id: 'globex' } }, () =>
  activity.performedOn('project', 'p1').log('globex thing'),
)

// inside the acme tenant: only sees the acme record
const acmeFeed = await runWithContext({ tenant: { id: 'acme' } }, () =>
  activity.for('project', 'p1'),
) // → ['acme thing']

// outside any tenant (admin/central): sees everything
await activity.for('project', 'p1') // → 2 records
```

To turn it off: `new Activity({ tenantScoped: false })` or `activityPlugin({ tenantScoped: false })`. Passing an explicit `tenantId` in the `query` also bypasses automatic scoping.

### Usage without the plugin (scripts, tests)

```ts
import { Activity } from '@basaltkit/activity'

const activity = new Activity()           // MemoryActivityStore by default
await activity.in('test').log('works')
```

### Custom store (production)

The in-memory store loses everything on restart. Implement `ActivityStore` over your database:

```ts
import type { ActivityQuery, ActivityRecord, ActivityStore } from '@basaltkit/activity'
import { activityPlugin } from '@basaltkit/activity'

class SqlActivityStore implements ActivityStore {
  async append(record: ActivityRecord): Promise<void> {
    // INSERT into the activity_log table…
  }
  async query(query: ActivityQuery): Promise<ActivityRecord[]> {
    // SELECT with filters, ORDER BY at DESC, LIMIT…
    return []
  }
}

activityPlugin({ store: new SqlActivityStore() })
```

## API reference

### `activityPlugin(options?: ActivityOptions)`

Registers `new Activity(options)` as a singleton under the token `ACTIVITY`.

### `class Activity`

`new Activity(options?: ActivityOptions)`

`ActivityOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `store` | `ActivityStore` | No | `new MemoryActivityStore()` | Where records are stored. |
| `tenantScoped` | `boolean` | No | `true` | Automatically filters queries by `ctx().tenant`. |

Methods:

| Method | Signature | Description |
|---|---|---|
| `in` | `(logName: string) => ActivityBuilder` | Starts a builder on a named log. |
| `performedOn` | `(type: string, id: string) => ActivityBuilder` | Shortcut: builder on the `'default'` log with the subject already set. |
| `for` | `(type: string, id: string, limit = 20) => Promise<ActivityRecord[]>` | Feed for a subject, most recent first. |
| `inLog` | `(logName: string, limit = 20) => Promise<ActivityRecord[]>` | Feed for a named log. |
| `byCauser` | `(userId: string, limit = 20) => Promise<ActivityRecord[]>` | Feed for a causer. |
| `query` | `(query: ActivityQuery) => Promise<ActivityRecord[]>` | Free-form query (with automatic tenant scoping, if enabled). |

### `class ActivityBuilder` (created by `in`/`performedOn`)

| Method | Signature | Description |
|---|---|---|
| `performedOn` | `(type: string, id: string) => this` | Sets the subject. |
| `causedBy` | `(userId: string) => this` | Forces the causer (default: `ctx().user.id` at the time of `log`). |
| `withProperties` | `(properties: Record<string, unknown>) => this` | Extra details for the record. |
| `log` | `(description: string) => Promise<ActivityRecord>` | Saves and returns the record (frozen). |

### `interface ActivityRecord` (all fields `readonly`)

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID generated at record time. |
| `log` | `string` | Log name (`'default'` if not set). |
| `description` | `string` | The action, as text (e.g. `'published'`). |
| `subjectType` | `string \| undefined` | Subject type (e.g. `'project'`). |
| `subjectId` | `string \| undefined` | Subject id. |
| `causerId` | `string \| undefined` | Who did it — `causedBy(...)` or `ctx().user.id`. |
| `tenantId` | `string \| undefined` | `ctx().tenant.id` at record time. |
| `properties` | `Record<string, unknown> \| undefined` | Extra details. |
| `at` | `number` | Timestamp (`Date.now()`, milliseconds). |

### `interface ActivityQuery`

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `log` | `string` | No | all | Filters by named log. |
| `subjectType` | `string` | No | all | Filters by subject type. |
| `subjectId` | `string` | No | all | Filters by subject id. |
| `causerId` | `string` | No | all | Filters by causer. |
| `tenantId` | `string` | No | context tenant (if `tenantScoped`) | Filters by tenant; passing an explicit value bypasses automatic scoping. |
| `limit` | `number` | No | no limit (feed methods use 20) | Maximum number of results. |

### `interface ActivityStore`

Storage contract:

- `append(record: ActivityRecord): Promise<void>`
- `query(query: ActivityQuery): Promise<ActivityRecord[]>` — must return most recent first and apply filters/limit.

### `class MemoryActivityStore`

In-memory implementation (freezes each record; filters and reverses on query). For dev and tests; does not persist.

### Token

- `ACTIVITY: Token<Activity>` — `app.container.get(ACTIVITY)`.

## Common errors and solutions (FAQ)

**`causerId`/`tenantId` come back empty on records.**
There was no active context (with `user`/`tenant`) at the time of `log(...)`. Inside HTTP requests, middleware establishes the context; in scripts use `runWithContext({ user: {...}, tenant: {...} }, …)` or force it with `.causedBy('system')`.

**The feed comes back empty, but I know there are records.**
This is likely tenant scoping: you're querying inside a different tenant than the one the records were created in. Check the tenant in context, pass an explicit `tenantId` in the `query`, or create `Activity` with `tenantScoped: false`.

**I only get 20 results.**
The feed methods (`for`, `inLog`, `byCauser`) default to `limit = 20`. Pass the limit as the last argument, or use `query({ ... , limit: 100 })`.

**Can I change a record after it's created?**
No — records are frozen at `append`. If something changed, log a new activity (e.g. `'renamed'`).

**I lost the history when the process restarted.**
`MemoryActivityStore` is volatile. In production, implement `ActivityStore` over a database.

**Should I use activity or audit?**
Activity: a readable feed for the **end user** ("Maria published…"), written by you at the points that matter to the product. Audit (`@basaltkit/audit`): automatic, immutable logging for **security/compliance**, captured from hooks and events. Many applications use both.

## How it connects to other modules

- **`@basaltkit/core`** — source of the context (`tryCtx`) that fills in `causerId`/`tenantId` and feeds tenant scoping; the plugin uses `definePlugin`/`createToken`.
- **`@basaltkit/audit`** — sibling module: audit is the automatic, append-only security record; activity is the product feed written explicitly. See the FAQ above.
- **`@basaltkit/queue`** — context travels to workers, so activity logged inside a job keeps the causer/tenant of the request that dispatched it.
- **`@basaltkit/events`** — you can log activity inside domain event listeners (e.g. on hearing `order.created`, log "order created" in the customer's feed).
- **`@basaltkit/logger`** — technical logs are for operators; activity is for users. They complement each other.
