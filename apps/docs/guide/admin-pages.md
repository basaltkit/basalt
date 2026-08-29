# Self-contained UIs

Some jobs need a screen, not just an API — managing API keys, inviting
teammates, changing a plan, browsing the audit trail. Basalt ships those as
**dependency-free HTML pages** you drop into your app: no build step, no
frontend framework, no npm bloat. Each page is served over the JSON routes you
already mount and renders in the viewer's light or dark theme.

[[toc]]

## How they work

A UI package exposes a `*Routes()` helper that registers one route serving a
static HTML page (plus, where needed, a small JSON endpoint). The page fetches
**same-origin** with the browser's session, so it assumes the user is already
authenticated for the underlying routes — protect the page with your own admin
guard where appropriate. There's nothing to compile: mount the routes and open
the URL.

::: warning A UI page needs its data plugin
Each page is only a viewer over JSON routes — it renders nothing without the
plugin that serves those routes. Pair `apiKeysUiRoutes()` with
`apiKeysPlugin()`, `teamsUiRoutes()` with `teamsPlugin()`, `billingUiRoutes()`
with `subscriptionsPlugin()`, and `auditViewerRoutes()` with **both**
`auditPlugin()` and `auditViewerPlugin()`.
:::

Here is the complete wiring — every plugin registered, then every route mounted:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import {
  authPlugin, authRoutes, apiKeysPlugin, apiKeyRoutes, MemoryUserSource,
} from '@basaltkit/auth'
import { teamsPlugin, teamRoutes } from '@basaltkit/teams'
import {
  subscriptionsPlugin, billingRoutes, definePlans, StripeBillingGateway,
} from '@basaltkit/subscriptions'
import { auditPlugin } from '@basaltkit/audit'
import { apiKeysUiRoutes } from '@basaltkit/api-keys-ui'
import { teamsUiRoutes } from '@basaltkit/teams-ui'
import { billingUiRoutes } from '@basaltkit/billing-ui'
import { auditViewerPlugin, auditViewerRoutes } from '@basaltkit/audit-viewer'

const plans = definePlans({
  free: { price: 0, features: { projects: 3 } },
  pro: { price: 29, trial: '14d', features: { projects: 50, api: true } },
})

const app = await createApp({
  plugins: [
    // ...tenancyPlugin — the tenant behind each UI's data
    authPlugin({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }),
    apiKeysPlugin(),
    teamsPlugin(),
    subscriptionsPlugin({ plans, gateway: new StripeBillingGateway({ /* … */ }), fallbackPlan: 'free' }),
    auditPlugin(),
    auditViewerPlugin(),
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        ...apiKeyRoutes(), ...apiKeysUiRoutes(),   // → /apikeys/ui
        ...teamRoutes(), ...teamsUiRoutes(),        // → /team/ui
        ...billingRoutes({ successUrl: 'https://app/ok', cancelUrl: 'https://app/billing' }),
        ...billingUiRoutes({ plans }),              // → /billing/ui
        ...auditViewerRoutes(),                     // → /audit/view
      ],
    }),
  ],
}).boot()
```

Every helper takes the same shape of options: `path?` (where to mount),
`apiBase?` (if the JSON routes are under a prefix), `title?`, and — for
header-based tenancy — `headers?` (e.g. `{ 'x-tenant-id': '…' }`; subdomain apps
need nothing).

## API keys — `@basaltkit/api-keys-ui`

```ts
import { apiKeysUiRoutes } from '@basaltkit/api-keys-ui'
// pair with @basaltkit/auth's apiKeysPlugin() + apiKeyRoutes()
```

Serves **`/apikeys/ui`**: create a key (the plaintext is revealed **once**, with
a copy button), list keys with prefix/scopes/last-used, and revoke. Requires a
logged-in user.

## Team — `@basaltkit/teams-ui`

```ts
import { teamsUiRoutes } from '@basaltkit/teams-ui'
// pair with @basaltkit/teams' teamsPlugin() + teamRoutes()
```

Serves **`/team/ui`**: invite a member, list and revoke pending invitations, and
list members with a role dropdown and remove. Admin-level actions require the
`teamRole: 'admin'` guard on the team routes.

## Billing — `@basaltkit/billing-ui`

```ts
import { billingUiRoutes } from '@basaltkit/billing-ui'
// pass the same plans you gave subscriptionsPlugin; pair with billingRoutes()
billingUiRoutes({ plans })
```

Serves **`/billing/ui`** (and `/billing/info`): shows the current plan, status
and trial, lists the plans as cards, and wires Subscribe/Switch to hosted
Checkout and Manage-billing to the Customer Portal.

## Audit trail — `@basaltkit/audit-viewer`

```ts
import { auditViewerPlugin, auditViewerRoutes } from '@basaltkit/audit-viewer'
// pair with @basaltkit/audit's auditPlugin()
auditViewerPlugin()
```

Serves **`/audit/view`**: browse the tenant's audit trail with filters (event,
actor, source, time range), pagination and aggregate stats. The JSON behind it
(`/audit`, `/audit/stats`, `/audit/:id`) is queryable directly too. Read-only —
the trail stays append-only.

## Use the HTML directly

Each package also exports its page as a string (`apiKeysPageHtml`,
`teamsPageHtml`, `billingPageHtml`, `auditViewerHtml`) if you'd rather serve it
your own way, embed it, or host it on another framework.

## Security

These pages are convenience over your existing routes — they enforce nothing
new. Put them behind authentication (they're mounted with `meta.auth`) and add a
guard for admin-only screens. The underlying data routes already enforce their
own guards (e.g. `teamRoutes()`'s admin actions require `teamRole: 'admin'`), but
the page itself is worth gating too — mount your own copy with a permissions or
team-role guard so non-admins never see it:

```ts
import { route } from '@basaltkit/fastify'
import { teamsPageHtml } from '@basaltkit/teams-ui'

// Serve the page yourself behind an admin guard instead of teamsUiRoutes()
route({
  method: 'GET',
  url: '/team/ui',
  meta: { auth: true, teamRole: 'admin' }, // or meta.can: 'team:manage' with @basaltkit/permissions
  handler: () => teamsPageHtml({ title: 'Team' }),
})
```

Because these pages fetch same-origin with no embedded secrets, they're safe to
serve from your app's origin.

### Content-Security-Policy

Each page ships inline `<style>`/`<script>` blocks that the app-wide
`DEFAULT_CSP` from `securityPlugin` would block. You do NOT need to disable CSP
globally: every `*UiRoutes()`/`auditViewerRoutes()` sets a **route-scoped** CSP
on its own response by default — everything locked down, the page's inline
script allowed only by its sha256 hash (exported as `apiKeysPageCsp`,
`teamsPageCsp`, `billingPageCsp`, `auditViewerCsp`). Pass `csp: '…'` to override
or `csp: false` to opt out. If you serve the raw `…PageHtml()` string yourself,
set the matching `…PageCsp()` header on that route.

Server-side inputs (`title`, `roles`) are HTML-escaped, and embedded state
(`apiBase`, `headers`, `roles`) is serialized so it cannot terminate the script
block — but `headers` values still end up in the page source, so never put
secrets in them.
