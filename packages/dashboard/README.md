# @machize/dashboard

"Headless" (no graphical interface) model of a complete admin panel: billing metrics (MRR, ARR, churn), job queue and audit summaries, and a section registry that organizes resources into navigation. You need it when you want to assemble the management panel for a SaaS product — the "Overview" page with numbers, the resource list in the sidebar, queue status.

## What this module solves

When you run a subscription product (a **SaaS** — software sold as a service, paid monthly or yearly), there are questions you ask every day: how much are we billing per month? How many customers are active, on trial, past due? How many canceled? Calculating these numbers by hand from the subscription list is tedious and easy to get wrong (for example: a 300 € annual plan is worth 25 €/month of recurring revenue, not 300 €).

This package brings those calculations ready-made and tested: `computeBillingMetrics` turns a list of subscriptions and the plan catalog into MRR (monthly recurring revenue), ARR (annual revenue) and counts by status and by plan; `churnRate` calculates the cancellation rate; `summarizeQueue` and `summarizeAudit` summarize job queue status and the audit log.

The second half of the package is structural: `defineDashboard` and the `*Section` functions let you declare your panel's sections ("Overview", "Projects", "Audit Log", "Queues") in a single navigable object — the visual "shell" (React or otherwise) reads `dashboard.nav()` to draw the sidebar and `dashboard.section(key)` to know what to show on each page. Like `@machize/admin`, this package doesn't render anything: it only produces the models. And it's safe to use in the browser — it imports only **types** from `@machize/subscriptions`, no server code.

## Installation

```bash
pnpm add @machize/dashboard
```

> Brings `@machize/admin` and `@machize/subscriptions` as dependencies. In practice you'll also want `@machize/subscriptions` directly (for `definePlans`) and `zod` if you define resources.

## Getting started in 5 minutes

Let's calculate the billing metrics for a fictional SaaS and assemble the panel structure.

**Step 1 — Define the plan catalog** (with `@machize/subscriptions`):

```ts
import { definePlans } from '@machize/subscriptions'

const plans = definePlans({
  free: { price: 0, features: {} },
  pro: { price: { monthly: 30, yearly: 300 }, features: {} }, // 30 €/month or 300 €/year
  scale: { price: 'custom', features: {} },                    // negotiated price
})
```

**Step 2 — Calculate the metrics** from the subscriptions (coming from your database or API):

```ts
import { computeBillingMetrics, churnRate } from '@machize/dashboard'
import type { SubscriptionRecord } from '@machize/subscriptions'

const subscriptions: SubscriptionRecord[] = [
  { billableId: 'a', plan: 'pro', period: 'monthly', status: 'active' },   // +30 €/month
  { billableId: 'b', plan: 'pro', period: 'yearly', status: 'active' },    // 300/12 = +25 €/month
  { billableId: 'c', plan: 'pro', period: 'monthly', status: 'trialing' }, // trial → 0 €
  { billableId: 'd', plan: 'free', period: 'monthly', status: 'active' },  // +0 €
]

const metrics = computeBillingMetrics(subscriptions, plans)
console.log(metrics.mrr)    // 55       (monthly recurring revenue)
console.log(metrics.arr)    // 660      (mrr × 12)
console.log(metrics.active) // 3
console.log(metrics.byPlan) // { pro: 3, free: 1 }

console.log(churnRate(5, 100)) // 0.05 → we lost 5% of customers in the period
```

**Step 3 — Declare the panel structure:**

```ts
import { z } from 'zod'
import { defineResource } from '@machize/admin'
import {
  defineDashboard,
  metricsSection,
  resourceSection,
  auditSection,
  queueSection,
} from '@machize/dashboard'

const projects = defineResource({
  name: 'projects',
  schema: z.object({ id: z.string(), name: z.string() }),
})

const dashboard = defineDashboard({
  title: 'Machize Admin',
  sections: [
    metricsSection({ icon: 'gauge' }),        // "Overview" page with the numbers
    resourceSection(projects, { icon: 'folder' }), // project CRUD
    auditSection(),                            // audit log
    queueSection(),                            // queue status
  ],
})
```

**Step 4 — Use the model in your interface:**

```ts
console.log(dashboard.title) // 'Machize Admin'
console.log(dashboard.nav())
// [
//   { key: 'overview', label: 'Overview', icon: 'gauge' },
//   { key: 'projects', label: 'Projects', icon: 'folder' },
//   { key: 'audit', label: 'Audit Log' },
//   { key: 'queues', label: 'Queues' },
// ]
// → draw the sidebar with this; on each page:
const section = dashboard.section('projects')
// section.kind === 'resource' and section.resource is the Resource → draw a DataTable
```

## Usage guide

### Billing metrics — `computeBillingMetrics`

Takes a "snapshot" of the subscriptions and the plan catalog. Important rules, faithful to the code:

- **MRR** only counts `active` subscriptions with a numeric price. Annual prices are divided by 12.
- Trials (`trialing`), `custom` plans and unknown plans contribute **0** to MRR (they're not recurring revenue yet), but they do count in the counts.
- `byPlan` counts subscriptions by plan across **all** statuses.
- Values are rounded to 2 decimal places; `arr = mrr × 12`.

```ts
import { computeBillingMetrics } from '@machize/dashboard'

const m = computeBillingMetrics(subscriptions, plans)
// m: { mrr, arr, active, trialing, pastDue, canceled, byPlan }
```

On screen, this usually turns into a row of cards: "MRR 55 €", "ARR 660 €", "Active 3", "Trials 1".

### Churn rate — `churnRate`

Customers lost divided by customers at the start of the period. Returns a fraction between 0 and 1 (multiply by 100 for a percentage). Protected against division by zero:

```ts
import { churnRate } from '@machize/dashboard'

churnRate(5, 100) // 0.05  (5%)
churnRate(3, 0)   // 0     (there were no customers at the start)
```

### Queue summary — `summarizeQueue`

A **job queue** is where the application stores tasks to run in the background (sending emails, generating reports…). Each task is in a state: waiting, active, completed, failed, delayed. This function fills in missing states with 0, sums the total, and marks the queue as healthy when there are no failures:

```ts
import { summarizeQueue } from '@machize/dashboard'

summarizeQueue({ waiting: 2, active: 1, failed: 3 })
// { waiting: 2, active: 1, completed: 0, failed: 3, delayed: 0,
//   total: 6, healthy: false }   ← healthy = failed === 0
```

On screen: one card per queue, with the total and a green (`healthy: true`) or red indicator.

### Audit summary — `summarizeAudit`

An **audit log** stores "who did what": each entry has an event name (e.g. `auth:login`). This function groups and counts by event, from most frequent to least (ties broken alphabetically):

```ts
import { summarizeAudit } from '@machize/dashboard'

summarizeAudit([
  { event: 'auth:login' },
  { event: 'billing:subscribed' },
  { event: 'auth:login' },
])
// [ { event: 'auth:login', count: 2 }, { event: 'billing:subscribed', count: 1 } ]
```

Accepts any array of objects with `event: string` — entries from `@machize/audit` work directly.

### Panel structure — `defineDashboard` and sections

Four section builders, all returning a `Section` object:

| Builder | `kind` | default `key` | default `label` |
|---|---|---|---|
| `metricsSection(options?)` | `'metrics'` | `'overview'` | `'Overview'` |
| `resourceSection(resource, options?)` | `'resource'` | `resource.name` | `resource.label` |
| `auditSection(options?)` | `'audit'` | `'audit'` | `'Audit Log'` |
| `queueSection(options?)` | `'queue'` | `'queues'` | `'Queues'` |

All accept `{ key?, label?, icon? }` (`resourceSection` accepts `{ key?, icon? }` — the label always comes from the resource). `icon` is just a textual hint for the UI (e.g. the name of a lucide icon like `'gauge'`); this package doesn't render icons. You can also build a `Section` by hand with `kind: 'custom'` for your own pages.

The visual shell walks through the sections and chooses what to render by `kind`: `metrics` → cards with `computeBillingMetrics`; `resource` → `DataTable`/`ResourceForm` (from `@machize/admin-react` or `@machize/admin-shadcn`) over `section.resource`; `audit` → list with `summarizeAudit`; `queue` → cards with `summarizeQueue`.

## API reference

### `computeBillingMetrics(subscriptions, plans): BillingMetrics`

| Parameter | Type | Required? | Description |
|---|---|---|---|
| `subscriptions` | `SubscriptionRecord[]` (from `@machize/subscriptions`) | Yes | Snapshot of subscriptions (`{ billableId, plan, period, status, … }`). |
| `plans` | `Record<string, PlanDefinition>` | Yes | Plan catalog (e.g. the result of `definePlans`). |

`BillingMetrics`:

| Field | Type | Description |
|---|---|---|
| `mrr` | `number` | Monthly recurring revenue from active subscriptions (annual ÷ 12), 2 decimal places. |
| `arr` | `number` | `mrr × 12`. |
| `active` | `number` | Subscriptions with `active` status. |
| `trialing` | `number` | On trial. |
| `pastDue` | `number` | With overdue payment (`past_due`). |
| `canceled` | `number` | Canceled. |
| `byPlan` | `Record<string, number>` | Count by plan, all statuses. |

### `churnRate(canceledInPeriod, activeAtStart): number`

| Parameter | Type | Description |
|---|---|---|
| `canceledInPeriod` | `number` | Customers lost in the period. |
| `activeAtStart` | `number` | Customers active at the start. |

Returns a fraction in `[0, 1]`, 2 decimal places; `0` if `activeAtStart <= 0`.

### `summarizeQueue(counts): QueueSummary`

`QueueCounts` (input — everything optional, default 0): `waiting?`, `active?`, `completed?`, `failed?`, `delayed?` (all `number`).

`QueueSummary` (output): the five counters filled in, plus `total: number` (sum) and `healthy: boolean` (`failed === 0`).

### `summarizeAudit(entries): { event: string; count: number }[]`

| Parameter | Type | Description |
|---|---|---|
| `entries` | `{ event: string }[]` | Audit entries (any object with `event`). |

Returns counts per event, sorted by descending frequency and then alphabetically.

### `defineDashboard(config): Dashboard`

`DashboardConfig`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `title` | `string` | No | `'Admin'` | Panel title. |
| `sections` | `Section[]` | Yes | — | Sections, in navigation order. |

`Dashboard` class:

| Member | Signature | Description |
|---|---|---|
| `title` | `string` | Title. |
| `sections` | `Section[]` | All sections. |
| `section(key)` | `(key: string) => Section \| undefined` | Looks up a section by `key`. |
| `nav()` | `() => { key, label, icon? }[]` | Sidebar model. |

### `Section` (type)

| Field | Type | Required? | Description |
|---|---|---|---|
| `key` | `string` | Yes | Unique identifier (used in routes/navigation). |
| `label` | `string` | Yes | Displayed text. |
| `kind` | `SectionKind` = `'metrics' \| 'resource' \| 'audit' \| 'queue' \| 'custom'` | Yes | Tells the UI what to render. |
| `resource` | `Resource` (from `@machize/admin`) | No | Present on `resource` sections. |
| `icon` | `string` | No | Icon hint for the UI (e.g. lucide name). |

### `resourceSection(resource, options?)`, `metricsSection(options?)`, `auditSection(options?)`, `queueSection(options?)`

`Section` builders — defaults in the table in the guide above. `options` is always optional.

## Common errors and solutions (FAQ)

**"MRR came out 0 but I have subscriptions."** Check three things: (1) `status` must be exactly `'active'` — trials don't count; (2) the plan name on the subscription must exist in the catalog you passed (an unknown plan silently adds 0); (3) `price: 'custom'` plans add 0 by design.

**"A 300 € annual subscription only added 25 € to MRR."** Correct: MRR is **monthly** revenue — the annual price is divided by 12 (`300 / 12 = 25`).

**"`churnRate` returns 0.05 and I expected 5."** It returns a fraction, not a percentage. Multiply by 100 to show `5%`.

**"`healthy` is `false` but the failed jobs are old."** `healthy` is simply `failed === 0`. Clear/reprocess the queue's dead letters for the indicator to go green again.

**"`dashboard.section('...')` returns `undefined`."** The `key` doesn't match. Remember the defaults: `metricsSection` → `'overview'`, `auditSection` → `'audit'`, `queueSection` → `'queues'`, `resourceSection` → the resource's `name`. Pass `{ key: '...' }` to control it.

**"Can I use this package in the browser?"** Yes. From `@machize/subscriptions` it only imports **types** (erased at compile time), so it doesn't pull in server code — the metrics functions are safe on the frontend.

**"Two sections with the same `key`."** `section(key)` returns the first one found. Give unique `key`s (e.g. `resourceSection(projects, { key: 'projects-archived' })`).

## How it connects to other modules

- **`@machize/admin`** — provides the `Resource` type that `resourceSection`s carry; the UI renders each one with the admin's view models.
- **`@machize/admin-react` / `@machize/admin-shadcn`** — the visual layers: they read `dashboard.nav()` for the sidebar and, per section, use `DataTable`/`ResourceForm` (`resource` sections), cards (`Card`/`Badge` from admin-shadcn) for `metrics` and `queue`, and lists for `audit`.
- **`@machize/subscriptions`** — source of the `SubscriptionRecord`, `PlanDefinition` and `BillingPeriod` types, and of `definePlans` which produces the catalog passed to `computeBillingMetrics`.
- **`@machize/queue` and `@machize/audit`** — the natural sources of the numbers: pass the queue counters to `summarizeQueue` and the audit entries to `summarizeAudit`.
- **`@machize/sdk`** — on the frontend, the data (subscriptions, counters, audit) arrives via the SDK's typed client and is summarized here before going to the screen.
