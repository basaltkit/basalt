# @basaltkit/teams-ui

Self-contained HTML page for **managing a team** in [`@basaltkit/teams`](https://www.npmjs.com/package/@basaltkit/teams): invite/revoke invitations and list/change-role/remove members — **zero dependencies, no build step**. You need this module when you want to give admins a team management screen without building the UI from scratch.

## What this module solves

`@basaltkit/teams` already exposes the invitation and member routes. This module is the **UI** on top of it: a page with an invitation form, the list of pending invitations (with revoke), and the member list (with a role dropdown and remove) — all isolated by tenant.

## Installation

```bash
pnpm add @basaltkit/teams-ui
```

Depends on `@basaltkit/core` and `@basaltkit/fastify`. Requires `teamsPlugin` + `teamRoutes` from `@basaltkit/teams` to be mounted.

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { teamsPlugin, teamRoutes } from '@basaltkit/teams'
import { teamsUiRoutes } from '@basaltkit/teams-ui'
import { fastifyPlugin } from '@basaltkit/fastify'

const app = await createApp({
  plugins: [
    // ... tenancyPlugin, authPlugin
    teamsPlugin(),
    fastifyPlugin({
      routes: [
        ...teamRoutes(),     // /team/invites*, /team/members*
        ...teamsUiRoutes(),  // GET /team/ui  ← the page
      ],
    }),
  ],
}).boot()
```

Open **`/team/ui`** (authenticated as a team admin) to manage invitations and members.

## Tenancy and authentication

The page performs same-origin `fetch` calls, so it assumes the browser session is authenticated. For **subdomain-based tenancy**, the tenant is resolved automatically. For **header-based tenancy**, inject the header:

```ts
teamsUiRoutes({ headers: { 'x-tenant-id': 'acme' } })
```

Management actions (invite, change role, remove) require `teamRole: 'admin'` on the `@basaltkit/teams` routes — protect the page itself with an admin guard if you want.

## API reference

### `teamsUiRoutes({ path?, apiBase?, title?, roles?, headers? })`

Returns the route that serves the page. `path` (default `/team/ui`), `apiBase` (default same-origin), `title`, `roles` (default `owner`/`admin`/`member`), `headers` (extra per request).

### `teamsPageHtml(options)`

Returns the page's HTML as a string, for serving it your own way.

## How it connects to other modules

- **`@basaltkit/teams`** — provides the invitation/member routes this page consumes.
- **`@basaltkit/tenancy` / `@basaltkit/auth`** — resolve the tenant and user from context.
- **`@basaltkit/permissions`** — add a *guard* to the page's route to restrict it to admins.
