<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/dashboard

"Headless" (no graphical interface) model of a complete admin panel: billing metrics (MRR, ARR, churn), job queue and audit summaries, and a section registry that organizes resources into navigation. You need it when you want to assemble the management panel for a SaaS product — the "Overview" page with numbers, the resource list in the sidebar, queue status.

## What this module solves

When you run a subscription product (a **SaaS** — software sold as a service, paid monthly or yearly), there are questions you ask every day: how much are we billing per month? How many customers are active, on trial, past due? How many canceled? Calculating these numbers by hand from the subscription list is tedious and easy to get wrong (for example: a 300 € annual plan is worth 25 €/month of recurring revenue, not 300 €).

This package brings those calculations ready-made and tested: `computeBillingMetrics` turns a list of subscriptions and the plan catalog into MRR (monthly recurring revenue), ARR (annual revenue) and counts by status and by plan; `churnRate` calculates the cancellation rate; `summarizeQueue` and `summarizeAudit` summarize job queue status and the audit log.

The second half of the package is structural: `defineDashboard` and the `*Section` functions let you declare your panel's sections ("Overview", "Projects", "Audit Log", "Queues") in a single navigable object — the visual "shell" (React or otherwise) reads `dashboard.nav()` to draw the sidebar and `dashboard.section(key)` to know what to show on each page. Like `@basaltkit/admin`, this package doesn't render anything: it only produces the models. And it's safe to use in the browser — it imports only **types** from `@basaltkit/subscriptions`, no server code.

## Installation

```bash
pnpm add @basaltkit/dashboard
```

> Brings `@basaltkit/admin` and `@basaltkit/subscriptions` as dependencies. In practice you'll also want `@basaltkit/subscriptions` directly (for `definePlans`) and `zod` if you define resources.

## Getting started in 5 minutes

Let's calculate the billing metrics for a fictional SaaS and assemble the panel structure.

**Step 1 — Define the plan catalog** (with `@basaltkit/subscriptions`):

```ts
import { definePlans } from '@basaltkit/subscriptions'

const plans = definePlans({
  free: { price: 0, features: {} },
  pro: { price: { monthly: 30, yearly: 300 }, features: {} }, // 30 €/month or 300 €/year
  scale: { price: 'custom', features: {} },                    // negotiated price
})
```

**Step 2 — Calculate the metrics** from the subscriptions (coming from your database or API):

```ts
import { computeBillingMetrics, churnRate } from '@basaltkit/dashboard'
import type { SubscriptionRecord } from '@basaltkit/subscriptions'

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
import { defineResource } from '@basaltkit/admin'
import {
  defineDashboard,
  metricsSection,
  resourceSection,
  auditSection,
  queueSection,
} from '@basaltkit/dashboard'

const projects = defineResource({
  name: 'projects',
  schema: z.object({ id: z.string(), name: z.string() }),
})

const dashboard = defineDashboard({
  title: 'Basalt Admin',
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
console.log(dashboard.title) // 'Basalt Admin'
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
import { computeBillingMetrics } from '@basaltkit/dashboard'

const m = computeBillingMetrics(subscriptions, plans)
// m: { mrr, arr, active, trialing, pastDue, canceled, byPlan }
```

On screen, this usually turns into a row of cards: "MRR 55 €", "ARR 660 €", "Active 3", "Trials 1".

### Churn rate — `churnRate`

Customers lost divided by customers at the start of the period. Returns a fraction between 0 and 1 (multiply by 100 for a percentage). Protected against division by zero:

```ts
import { churnRate } from '@basaltkit/dashboard'

churnRate(5, 100) // 0.05  (5%)
churnRate(3, 0)   // 0     (there were no customers at the start)
```

### MRR movement & growth — `mrrMovement`, `growth`

`computeBillingMetrics` is a **snapshot**; analytics is about *change over time*.
Given two subscription snapshots — say last month's and this month's — `mrrMovement`
decomposes the change in MRR into the standard SaaS bridge:

```ts
import { mrrMovement } from '@basaltkit/dashboard'

const m = mrrMovement(lastMonthSubs, thisMonthSubs, plans)
// {
//   previousMrr: 500, currentMrr: 610,
//   new: 90,          // billables paying now that never appeared before
//   reactivation: 20, // billables that existed but weren't paying, now are
//   expansion: 40,    // upgrades among already-paying billables
//   contraction: 20,  // downgrades that still pay something
//   churned: 20,      // billables that stopped paying entirely
//   net: 110,         // currentMrr − previousMrr
// }
```

The buckets always balance: `new + reactivation + expansion − contraction − churned === net`.
Yearly prices are normalized to monthly; trials and `custom` plans contribute 0 —
consistent with `computeBillingMetrics`. Snapshots are matched by `billableId`
(the tenant id), so you feed it two calls to `subscriptions.all()` taken at
different times (persist a monthly snapshot, or diff against a stored one).

For simple period-over-period deltas on the headline numbers, `growth` (and the
`change(a, b)` primitive) give you `{ previous, current, delta, pct }` — ready for
an up/down arrow and a percentage on each KPI card:

```ts
import { growth } from '@basaltkit/dashboard'

const g = growth(lastMonthMetrics, thisMonthMetrics)
g.mrr    // { previous: 500, current: 610, delta: 110, pct: 0.22 }  → "MRR +22%"
g.active // { previous: 40, current: 44, delta: 4, pct: 0.1 }
```

### Queue summary — `summarizeQueue`

A **job queue** is where the application stores tasks to run in the background (sending emails, generating reports…). Each task is in a state: waiting, active, completed, failed, delayed. This function fills in missing states with 0, sums the total, and marks the queue as healthy when there are no failures:

```ts
import { summarizeQueue } from '@basaltkit/dashboard'

summarizeQueue({ waiting: 2, active: 1, failed: 3 })
// { waiting: 2, active: 1, completed: 0, failed: 3, delayed: 0,
//   total: 6, healthy: false }   ← healthy = failed === 0
```

On screen: one card per queue, with the total and a green (`healthy: true`) or red indicator.

### Audit summary — `summarizeAudit`

An **audit log** stores "who did what": each entry has an event name (e.g. `auth:login`). This function groups and counts by event, from most frequent to least (ties broken alphabetically):

```ts
import { summarizeAudit } from '@basaltkit/dashboard'

summarizeAudit([
  { event: 'auth:login' },
  { event: 'billing:subscribed' },
  { event: 'auth:login' },
])
// [ { event: 'auth:login', count: 2 }, { event: 'billing:subscribed', count: 1 } ]
```

Accepts any array of objects with `event: string` — entries from `@basaltkit/audit` work directly.

### White-label branding — `Branding`, `resolveBranding`

Selling your admin panel to other companies? Each tenant can ship their own
product name, logo and colours over a default brand. `Branding` is plain data;
`resolveBranding` merges a tenant's overrides on top of your default:

```ts
import { MemoryBrandingStore, resolveBranding, brandingStyleSheet } from '@basaltkit/dashboard'

const brands = new MemoryBrandingStore() // or a durable store
await brands.set('acme', {
  productName: 'Acme Console',
  logoUrl: 'https://acme.example/logo.svg',
  colors: { primary: '#5b21b6', accent: '#f59e0b' },
  supportEmail: 'help@acme.example',
})

const brand = await resolveBranding(brands, currentTenantId) // merged over the default
```

Feed the brand into your `Dashboard` — the title defaults to the product name —
and inject its colours as CSS custom properties (`--brand-primary`, `--brand-accent`,
`--brand-bg`, `--brand-fg`, plus any `cssVars`) the shell reads:

```ts
import { defineDashboard, brandingStyleSheet } from '@basaltkit/dashboard'

const dashboard = defineDashboard({ branding: brand, sections })
dashboard.title // 'Acme Console'

// in the page <head>:
`<style>${brandingStyleSheet(brand)}</style>`
// :root { --brand-primary: #5b21b6; --brand-accent: #f59e0b; }
```

> **Security:** because branding is tenant-controlled and the output is injected into
> `<style>`, `brandingStyleSheet`/`brandingCssVars` strictly validate custom-property
> names and values and **silently drop** anything that could break out of the rule or the
> `<style>` element (a CSS-injection / stored-XSS vector). Still serve the shell under a
> CSP that restricts inline styles as defence in depth.

`resolveBranding` deep-merges colours and `cssVars`, so a tenant that overrides
only `--brand-primary` keeps every other token from your default theme. It pairs
naturally with per-tenant **custom domains** (`@basaltkit/tenancy`): resolve the
tenant from the domain, then its brand from the tenant.

### Panel structure — `defineDashboard` and sections

Four section builders, all returning a `Section` object:

| Builder | `kind` | default `key` | default `label` |
|---|---|---|---|
| `metricsSection(options?)` | `'metrics'` | `'overview'` | `'Overview'` |
| `resourceSection(resource, options?)` | `'resource'` | `resource.name` | `resource.label` |
| `auditSection(options?)` | `'audit'` | `'audit'` | `'Audit Log'` |
| `queueSection(options?)` | `'queue'` | `'queues'` | `'Queues'` |

All accept `{ key?, label?, icon? }` (`resourceSection` accepts `{ key?, icon? }` — the label always comes from the resource). `icon` is just a textual hint for the UI (e.g. the name of a lucide icon like `'gauge'`); this package doesn't render icons. You can also build a `Section` by hand with `kind: 'custom'` for your own pages.

The visual shell walks through the sections and chooses what to render by `kind`: `metrics` → cards with `computeBillingMetrics`; `resource` → `DataTable`/`ResourceForm` (from `@basaltkit/admin-react` or `@basaltkit/admin-shadcn`) over `section.resource`; `audit` → list with `summarizeAudit`; `queue` → cards with `summarizeQueue`.

### The ready-made dashboard — `standardDashboard` + `buildOverview`

Two shortcuts turn the pieces above into a complete panel with almost no wiring.

**`standardDashboard(options)`** assembles the conventional layout — Overview →
your resources → Queues → Audit — with sensible labels and icon hints:

```ts
import { standardDashboard } from '@basaltkit/dashboard'

const dashboard = standardDashboard({
  title: 'Basalt Admin',
  resources: [projects],   // admin resources
  queues: true,
  audit: true,
})
// dashboard.nav() → overview, projects, queues, audit
```

**`buildOverview(input)`** assembles the whole Overview page from one snapshot —
billing metrics, optional churn, and optional queue health — into KPI cards (each
with a semantic `tone`: `positive` / `warning` / `critical`) plus breakdowns:

```ts
import { buildOverview } from '@basaltkit/dashboard'

const overview = buildOverview({
  subscriptions, plans,
  activeAtStart: 120,                                   // → Churn KPI
  queue: { waiting: 8, failed: 3, completed: 340 },     // → Failed-jobs KPI (critical)
  audit: recentAuditEntries,                            // → topEvents list
})
// overview.kpis → [{ label:'MRR', value:'$1,240', tone:'default' }, …]
// overview.byPlan / byStatus / queue / topEvents
```

The shell renders `overview.kpis` directly — it decides nothing. See the
ready-made **`apps/admin-demo`** for a full React shell that renders every section
kind (metrics / resource / queue / audit) straight from this model.

## API reference

### `computeBillingMetrics(subscriptions, plans): BillingMetrics`

| Parameter | Type | Required? | Description |
|---|---|---|---|
| `subscriptions` | `SubscriptionRecord[]` (from `@basaltkit/subscriptions`) | Yes | Snapshot of subscriptions (`{ billableId, plan, period, status, … }`). |
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
| `resource` | `Resource` (from `@basaltkit/admin`) | No | Present on `resource` sections. |
| `icon` | `string` | No | Icon hint for the UI (e.g. lucide name). |

### `resourceSection(resource, options?)`, `metricsSection(options?)`, `auditSection(options?)`, `queueSection(options?)`

`Section` builders — defaults in the table in the guide above. `options` is always optional.

## Common errors and solutions (FAQ)

**"MRR came out 0 but I have subscriptions."** Check three things: (1) `status` must be exactly `'active'` — trials don't count; (2) the plan name on the subscription must exist in the catalog you passed (an unknown plan silently adds 0); (3) `price: 'custom'` plans add 0 by design.

**"A 300 € annual subscription only added 25 € to MRR."** Correct: MRR is **monthly** revenue — the annual price is divided by 12 (`300 / 12 = 25`).

**"`churnRate` returns 0.05 and I expected 5."** It returns a fraction, not a percentage. Multiply by 100 to show `5%`.

**"`healthy` is `false` but the failed jobs are old."** `healthy` is simply `failed === 0`. Clear/reprocess the queue's dead letters for the indicator to go green again.

**"`dashboard.section('...')` returns `undefined`."** The `key` doesn't match. Remember the defaults: `metricsSection` → `'overview'`, `auditSection` → `'audit'`, `queueSection` → `'queues'`, `resourceSection` → the resource's `name`. Pass `{ key: '...' }` to control it.

**"Can I use this package in the browser?"** Yes. From `@basaltkit/subscriptions` it only imports **types** (erased at compile time), so it doesn't pull in server code — the metrics functions are safe on the frontend.

**"Two sections with the same `key`."** `section(key)` returns the first one found. Give unique `key`s (e.g. `resourceSection(projects, { key: 'projects-archived' })`).

## How it connects to other modules

- **`@basaltkit/admin`** — provides the `Resource` type that `resourceSection`s carry; the UI renders each one with the admin's view models.
- **`@basaltkit/admin-react` / `@basaltkit/admin-shadcn`** — the visual layers: they read `dashboard.nav()` for the sidebar and, per section, use `DataTable`/`ResourceForm` (`resource` sections), cards (`Card`/`Badge` from admin-shadcn) for `metrics` and `queue`, and lists for `audit`.
- **`@basaltkit/subscriptions`** — source of the `SubscriptionRecord`, `PlanDefinition` and `BillingPeriod` types, and of `definePlans` which produces the catalog passed to `computeBillingMetrics`.
- **`@basaltkit/queue` and `@basaltkit/audit`** — the natural sources of the numbers: pass the queue counters to `summarizeQueue` and the audit entries to `summarizeAudit`.
- **`@basaltkit/sdk`** — on the frontend, the data (subscriptions, counters, audit) arrives via the SDK's typed client and is summarized here before going to the screen.
