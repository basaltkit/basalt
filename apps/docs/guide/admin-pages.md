# Self-contained UIs

Some jobs need a screen, not just an API — managing API keys, inviting
teammates, changing a plan, browsing the audit trail. Machize ships those as
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

```ts
fastifyPlugin({
  routes: [
    ...authRoutes(), ...apiKeyRoutes(), ...apiKeysUiRoutes(),   // → /apikeys/ui
    ...teamRoutes(), ...teamsUiRoutes(),                        // → /team/ui
    ...billingRoutes({ successUrl, cancelUrl }), ...billingUiRoutes({ plans }), // → /billing/ui
    ...auditViewerRoutes(),                                     // → /audit/view
  ],
})
```

Every helper takes the same shape of options: `path?` (where to mount),
`apiBase?` (if the JSON routes are under a prefix), `title?`, and — for
header-based tenancy — `headers?` (e.g. `{ 'x-tenant-id': '…' }`; subdomain apps
need nothing).

## API keys — `@machize/api-keys-ui`

```ts
import { apiKeysUiRoutes } from '@machize/api-keys-ui'
// pair with @machize/auth's apiKeysPlugin() + apiKeyRoutes()
```

Serves **`/apikeys/ui`**: create a key (the plaintext is revealed **once**, with
a copy button), list keys with prefix/scopes/last-used, and revoke. Requires a
logged-in user.

## Team — `@machize/teams-ui`

```ts
import { teamsUiRoutes } from '@machize/teams-ui'
// pair with @machize/teams' teamsPlugin() + teamRoutes()
```

Serves **`/team/ui`**: invite a member, list and revoke pending invitations, and
list members with a role dropdown and remove. Admin-level actions require the
`teamRole: 'admin'` guard on the team routes.

## Billing — `@machize/billing-ui`

```ts
import { billingUiRoutes } from '@machize/billing-ui'
// pass the same plans you gave subscriptionsPlugin; pair with billingRoutes()
billingUiRoutes({ plans })
```

Serves **`/billing/ui`** (and `/billing/info`): shows the current plan, status
and trial, lists the plans as cards, and wires Subscribe/Switch to hosted
Checkout and Manage-billing to the Customer Portal.

## Audit trail — `@machize/audit-viewer`

```ts
import { auditViewerPlugin, auditViewerRoutes } from '@machize/audit-viewer'
// pair with @machize/audit's auditPlugin()
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
permissions guard for admin-only screens. Because they fetch same-origin with no
embedded secrets, they're safe to serve from your app's origin.
