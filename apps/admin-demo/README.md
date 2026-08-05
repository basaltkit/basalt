# admin-demo

A runnable admin dashboard built from the real Machize UI packages —
`@machize/admin` (headless engine) + `@machize/admin-shadcn` (shadcn/ui
components) — with a Tailwind + shadcn theme.

## Run it

From the monorepo root:

```bash
pnpm --filter admin-demo dev
```

Then open **http://localhost:5174**. You get a sidebar dashboard with:

- **Overview** — billing metric cards (MRR/ARR/active/trialing) and per-plan badges.
- **Projects** — a `DataTable` and `ResourceForm` generated from one Zod schema.
  Add a project (validation runs via the resource's schema) and it appears in
  the table. Toggle light/dark.

## Note on `@machize/dashboard`

The headless `@machize/dashboard` package (`computeBillingMetrics`,
`defineDashboard`) is server-safe but depends on `@machize/subscriptions →
@machize/fastify` and `node:crypto`, so it isn't meant to be bundled into the
browser. In a real admin you compute those numbers on the server and fetch them
from your API. This demo mirrors the shapes inline to stay browser-only.
