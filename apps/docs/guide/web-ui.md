# Web UI & components

Basalt gives you two ways to put a screen in front of your API:

1. **[Self-contained HTML pages](/guide/admin-pages)** — drop-in, build-free pages (`teamsUiRoutes`, `billingUiRoutes`, `apiKeysUiRoutes`, the audit viewer). No frontend project, no npm install on the client. Great for internal/admin screens.
2. **A real React frontend** — a Vite + React app that talks to your API through a type-safe SDK, with the `@basaltkit/admin` components on hand to render tables and forms straight from your Zod schemas. This is what `create-basalt --ui` scaffolds, and what this guide covers.

[[toc]]

## The `--ui` scaffold

```bash
pnpm create basalt my-app --ui          # auth is on by default → the ready-made auth flows come too
```

Authentication is **on by default** in the scaffold, so `--ui` gives you the auth screens as well; pass `--no-auth` if you want the frontend without them. Requires **pnpm** — the `web/` frontend is a workspace member (the scaffolder switches to pnpm automatically if you invoked it with another manager).

Alongside the API, this generates a **`web/`** frontend wired end to end:

```
web/
├── vite.config.ts     # dev server proxies /api → your backend (no CORS)
├── tailwind.config.js # Tailwind + shadcn theme, incl. @basaltkit/admin-shadcn in `content`
├── index.html
└── src/
    ├── api.ts         # your endpoints described once with @basaltkit/sdk
    ├── App.tsx        # the app — with --auth: login, register, forgot/reset, a dashboard + MFA
    ├── main.tsx
    └── index.css      # shadcn theme variables (light/dark)
```

- **React + Vite** for the dev server and build.
- **[`@basaltkit/admin-shadcn`](#admin-panels-from-your-zod-schemas)** — authentic shadcn/ui components, already themed.
- **[`@basaltkit/sdk`](#the-type-safe-sdk)** — the type-safe client to your API.
- The Vite dev server **proxies `/api`** to the backend, so the browser talks same-origin — no CORS to configure.

`web` is registered as a pnpm workspace member (named `<your-app>-web`), so `pnpm install` at the root resolves it. Run the backend with `pnpm dev` (API on `:3000`), then the frontend with `pnpm --filter my-app-web dev` — Vite serves it on `http://localhost:5180` and proxies `/api` to the backend.

With auth enabled (the default), `App.tsx` ships the full standard flows out of the box: sign in (with a TOTP challenge), register, forgot-password, reset-password via the emailed `?token` link, and a dashboard that manages two-factor (enroll → secret/otpauth → activate → recovery codes → disable). Pass `--no-auth` to scaffold the frontend without them.

## The type-safe SDK

[`@basaltkit/sdk`](/reference/packages) is a drift-free HTTP client: describe each endpoint **once** with Zod, and every call gets the right input/output types, structured errors, and automatic token refresh. Its only dependency is Zod — it's browser-friendly and doesn't pull in `@basaltkit/core`.

```ts
// src/api.ts — the single source of truth, shareable between client and tests
import { z } from 'zod'
import { endpoint } from '@basaltkit/sdk'

const Project = z.object({ id: z.string(), name: z.string() })

export const api = {
  projects: {
    list:   endpoint({ method: 'GET',  path: '/projects', result: z.array(Project) }),
    get:    endpoint({ method: 'GET',  path: '/projects/:id', params: z.object({ id: z.string() }), result: Project }),
    create: endpoint({ method: 'POST', path: '/projects', body: z.object({ name: z.string() }), result: Project }),
  },
}
```

```ts
import { createClient } from '@basaltkit/sdk'
import { api } from './api.js'

const client = createClient(api, { baseUrl: '/api' })

const created = await client.projects.create({ body: { name: 'Basalt' } }) // typed { id, name }
const one     = await client.projects.get({ params: { id: created.id } })
const all     = await client.projects.list()
```

The client **mirrors the shape** of your `api` object, TypeScript checks the arguments, and the server's response is **validated against the schema** at runtime — a mismatch throws `CLIENT_RESPONSE_MISMATCH` instead of silently returning wrong data. Change a field on the backend and the frontend fails to compile, not in production.

::: tip Auth & token refresh
Pass a `getToken` callback (returns the current access token, sent as `Authorization: Bearer`) and a `refresh` callback to `createClient`. On a `401` the client calls `refresh` once and retries with the new token — transparent to the caller; `refresh` returns the new token, or `null` to give up. The `--ui` scaffold wires this to the auth routes for you.

```ts
const client = createClient(api, {
  baseUrl: '/api',
  getToken: () => localStorage.getItem('accessToken') ?? undefined,
  refresh: async () => {
    /* call POST /auth/refresh, store the new tokens, return the access token or null */
    return null
  },
})
```
:::

## Admin panels from your Zod schemas

Three packages layer up so you can swap the visual look without rewriting logic:

| Package | Role |
| --- | --- |
| [`@basaltkit/admin`](/reference/packages) | **Headless engine** — from a Zod schema, derives table columns, form fields, and validation. Renders nothing. |
| [`@basaltkit/admin-react`](/reference/packages) | **React layer** — `DataTable`, `ResourceForm`, `useList`, in plain unstyled HTML. |
| [`@basaltkit/admin-shadcn`](/reference/packages) | **The same components, styled with shadcn/ui** (Tailwind). Identical props. What `--ui` uses. |

### 1. Define the resource once

```ts
// resources.ts — pure logic, no React
import { z } from 'zod'
import { defineResource } from '@basaltkit/admin'

export const projects = defineResource({
  name: 'projects',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['draft', 'published']),
    archived: z.boolean().optional(),
  }),
  createSchema: z.object({
    name: z.string().min(3),
    status: z.enum(['draft', 'published']),
  }),
  columns: ['name', 'status'], // order shown in the table
})
```

From this, the engine derives the column labels, the form fields (with the right input per type — text, checkbox for booleans, `<select>` for enums, number for numbers), which fields are required, and the validation rules. Use `fieldsFromSchema` directly if you want the field models without a full resource.

### 2. Wire a data source

The engine reads and writes through an **`AdminDataSource`** — `{ list, get, create, update, remove }`. Use `memoryDataSource(seed)` for demos, or back it with your type-safe SDK client for a real API:

```ts
// source.ts
import type { AdminDataSource } from '@basaltkit/admin'
import { createClient } from '@basaltkit/sdk'
import { api } from './api'

const client = createClient(api, { baseUrl: '/api' })

export const projectsSource: AdminDataSource = {
  list:   ()          => client.projects.list(),
  get:    (id)        => client.projects.get({ params: { id } }),
  create: (input)     => client.projects.create({ body: input as { name: string } }),
  update: (id, input) => client.projects.update({ params: { id }, body: input }),
  remove: (id)        => client.projects.remove({ params: { id } }).then(() => true),
}
```

### 3. Render it

```tsx
// ProjectsPage.tsx
import { DataTable, ResourceForm } from '@basaltkit/admin-shadcn' // or @basaltkit/admin-react (unstyled)
import { useList } from '@basaltkit/admin-react'                  // the hook lives in admin-react
import { projects } from './resources'
import { projectsSource } from './source'

export function ProjectsPage() {
  const { data, loading, error, reload } = useList(projectsSource)
  if (loading) return <p>Loading…</p>
  if (error) return <p>Something went wrong.</p>

  return (
    <>
      <DataTable resource={projects} rows={data} />
      <ResourceForm
        resource={projects}
        onSubmit={async (values) => {
          await projectsSource.create(values)
          reload()
        }}
      />
    </>
  )
}
```

`useList(source)` loads the list on mount and hands back `{ data, loading, error, reload }`. `DataTable` formats cells (booleans as Yes/No, dates as `2026-08-07`); `ResourceForm` renders one input per field with per-field validation and error messages driven by your `createSchema` — it only calls `onSubmit` with valid data. Swap the `DataTable`/`ResourceForm` import between `@basaltkit/admin-react` (unstyled) and `@basaltkit/admin-shadcn` (styled) — **the props are identical**. The `useList` hook and `formatCell` helper are exported only from `@basaltkit/admin-react`, so import them from there regardless of which component skin you use.

### The shadcn primitives

`@basaltkit/admin-shadcn` also exports the shadcn primitives themselves — `Button`, `Input`, `Label`, `Card`, `CardHeader`, `CardContent`, `CardTitle`, `Badge`, `Table` — so you build the rest of your panel (headers, metric cards, actions) with the same look, without copying shadcn's files into your project.

::: warning Tailwind is required for styling
`@basaltkit/admin-shadcn`'s classes only produce colors/spacing if your app has **Tailwind CSS** configured with shadcn's theme variables (`--primary`, `--border`, …) and includes the package in Tailwind's `content`:

```js
// tailwind.config.js
content: ['./index.html', './src/**/*.{ts,tsx}', './node_modules/@basaltkit/admin-shadcn/dist/**/*.js']
```

The `--ui` scaffold does all of this for you. Integrating by hand? Follow [ui.shadcn.com/docs/installation](https://ui.shadcn.com/docs/installation) plus the `content` line above.
:::

## Dashboards

[`@basaltkit/dashboard`](/reference/packages) composes an overview from your data — `defineDashboard` with metric/audit/queue sections, billing metrics (`computeBillingMetrics`, `churnRate`), and queue summaries — rendered by the same shadcn components.

## Which UI approach?

- **Self-contained HTML pages** ([`admin-pages`](/guide/admin-pages)) — no frontend project; mount a route and open the URL. Best for internal admin screens (API keys, team, billing, audit).
- **The React frontend** (`--ui`) — a full SPA with the type-safe SDK and shadcn components, for the app your customers use.

They compose: a React app can still embed or link to the self-contained pages.
