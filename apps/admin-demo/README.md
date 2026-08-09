# admin-demo

A runnable admin dashboard built from the real Basalt UI packages —
`@basaltkit/admin` (headless engine) + `@basaltkit/admin-shadcn` (shadcn/ui
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

## Browser-safe by design

This demo uses `@basaltkit/dashboard` (`computeBillingMetrics`, `defineDashboard`)
directly in the browser — the MRR/ARR you see are computed live by the real
package, not hardcoded. `@basaltkit/dashboard` imports `@basaltkit/subscriptions`
type-only (erased at build), so the subscriptions/Fastify/Node runtime never
enters the bundle. `@basaltkit/admin` and `@basaltkit/admin-shadcn` are likewise
free of `@basaltkit/core` (no `node:async_hooks`), so the whole UI stack bundles
cleanly for the browser.
