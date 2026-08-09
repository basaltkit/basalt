# Harden accounts & billing

This recipe adds the pieces a real SaaS needs around a signed-up user:
**email verification**, **password reset**, **multi-factor authentication**,
**API keys**, **team invitations**, and **hosted billing** (Stripe Checkout,
Customer Portal, and prorated plan changes).

Everything here ships in `@basaltkit/auth`, `@basaltkit/teams`, and
`@basaltkit/subscriptions` (0.5.0+). The design rule throughout: **secrets travel
by email, never in an HTTP response**, and enumeration is impossible — the
"request" endpoints always answer `200`.

[[toc]]

## The shape of it

```
Sign up ─▶ verify email ─┐
                         ├─▶ log in ─(MFA code)─▶ session
Forgot? ─▶ reset link ───┘                         │
                                                   ├─▶ issue API keys (mk_live_…)
                                                   ├─▶ invite teammates (roles)
                                                   └─▶ Checkout / Portal / swap plan
```

Tokens for verification, reset, and invitations are one-time and expiring. The
service **emits a hook carrying the token**; your app emails it. Auth never
depends on your mailer.

## 1. Plugins

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { tenancyPlugin, headerResolver, MemoryTenantSource } from '@basaltkit/tenancy'
import { mailerPlugin } from '@basaltkit/mailer'
import {
  authPlugin, authRoutes, apiKeysPlugin, apiKeyRoutes, mfaRoutes,
  MemoryUserSource,
} from '@basaltkit/auth'
import { teamsPlugin, teamRoutes } from '@basaltkit/teams'
import { subscriptionsPlugin, billingRoutes, billingWebhookRoute, definePlans, StripeBillingGateway } from '@basaltkit/subscriptions'
```

We'll assemble the full `app.ts` at the end — first, each capability in turn.

## 2. Transactional email, wired once

Verification, reset, and invitations all do the same thing: turn a hook +
token into an email. Define the mails, then a tiny plugin that subscribes to
the hooks. `hooks.on(...)` is fully typed — the payload shape comes from the
package that declared the hook.

```ts
// mails.ts
import { defineMail } from '@basaltkit/mailer'
import { z } from 'zod'

const link = z.object({ url: z.string() })

export const VerifyEmail = defineMail({
  name: 'verify-email',
  schema: link,
  subject: () => 'Confirm your email',
  html: ({ url }) => `<p>Confirm your address: <a href="${url}">verify</a></p>`,
})

export const ResetEmail = defineMail({
  name: 'reset-password',
  schema: link,
  subject: () => 'Reset your password',
  html: ({ url }) => `<p>Reset your password: <a href="${url}">choose a new one</a></p>`,
})

export const InviteEmail = defineMail({
  name: 'team-invite',
  schema: link,
  subject: () => 'You have been invited to a team',
  html: ({ url }) => `<p>Join the team: <a href="${url}">accept invitation</a></p>`,
})
```

```ts
// emails-plugin.ts
import { definePlugin } from '@basaltkit/core'
import { MAILER } from '@basaltkit/mailer'
import { VerifyEmail, ResetEmail, InviteEmail } from './mails.js'

const APP_URL = process.env.APP_URL ?? 'https://app.example.com'

/** Turns auth/teams token hooks into outbound email. */
export const emailsPlugin = definePlugin({
  name: 'app:emails',
  dependsOn: ['basalt:mailer'],
  register({ container, hooks }) {
    const mailer = () => container.get(MAILER)

    hooks.on('auth:verify_requested', ({ user, token }) =>
      mailer().send(VerifyEmail, { url: `${APP_URL}/verify?token=${token}` }, { to: user.email }))

    hooks.on('auth:password_reset_requested', ({ user, token }) =>
      mailer().send(ResetEmail, { url: `${APP_URL}/reset?token=${token}` }, { to: user.email }))

    hooks.on('team:invited', ({ invitation, token }) =>
      mailer().send(InviteEmail, { url: `${APP_URL}/invite?token=${token}` }, { to: invitation.email }))
  },
})
```

::: tip Send email off the request
Wrap the mailer in a queue so a slow SMTP call never blocks the response:
`mailer.useQueue((m) => SendMail.dispatch(m))`. See the
[notes SaaS cookbook](/cookbook/notes-saas) for the queue wiring.
:::

## 3. Email verification

`authRoutes()` already includes the endpoints — you only supply the email
plumbing (done above). A new user starts unverified (`emailVerified: false`).

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /auth/verify/request` | `{ email }` | always `{ ok: true }` |
| `POST /auth/verify` | `{ token }` | `{ user }` (now `emailVerified: true`) |

```bash
curl -X POST /auth/verify/request -d '{"email":"ada@acme.test"}'   # email sent
curl -X POST /auth/verify        -d '{"token":"<from the link>"}'   # verified
```

To require a verified email for sensitive routes, read `ctx().user` in a guard:

```ts
route({
  method: 'POST', url: '/projects', meta: { auth: true, verified: true },
  handler: () => ({ /* ... */ }),
})

// register once (a RouteGuard), rejecting unverified users with 403:
const requireVerified: RouteGuard = ({ route, context }) => {
  if (route.meta?.verified === true && context.user?.emailVerified !== true) {
    throw new AuthRequiredError()
  }
}
```

## 4. Password reset

Same pattern — the token arrives by email, and both "request" routes answer
`200` whether or not the account exists, so nobody can probe your user list.

| Endpoint | Body | Notes |
| --- | --- | --- |
| `POST /auth/password/forgot` | `{ email }` | always `{ ok: true }` |
| `POST /auth/password/reset` | `{ token, password }` | **revokes every refresh token** |

A completed reset logs the user out everywhere — every refresh-token family is
revoked, so a stolen session can't outlive the password change.

## 5. Multi-factor authentication (TOTP)

Register `mfaRoutes()` alongside `authRoutes()`. Enrollment is a two-step
handshake so a mistyped code can never lock the user out.

```bash
# 1. begin — returns a secret and an otpauth:// URI to render as a QR code
curl -X POST /auth/mfa/enroll -H "authorization: Bearer $ACCESS"
# → { "secret": "JBSWY3…", "otpauthUri": "otpauth://totp/Basalt:ada@acme.test?…" }

# 2. confirm with a code from the authenticator — returns one-time recovery codes
curl -X POST /auth/mfa/activate -H "authorization: Bearer $ACCESS" -d '{"code":"123456"}'
# → { "recoveryCodes": ["1a2b3-c4d5e", … 10 total] }
```

Once enabled, login takes an optional `mfaCode`:

```bash
curl -X POST /auth/login -d '{"email":"ada@acme.test","password":"…"}'
# → 401 { "error": { "code": "AUTH_MFA_REQUIRED" } }   (password was correct)

curl -X POST /auth/login -d '{"email":"ada@acme.test","password":"…","mfaCode":"123456"}'
# → 200 { user, accessToken, refreshToken }
```

- A correct password with a **missing** code returns `AUTH_MFA_REQUIRED` and is
  **not** counted as a failed attempt; a **wrong** code is, so the login
  throttle still blocks brute force against the second factor.
- Recovery codes are single-use and stored only as SHA-256 hashes. A user with
  a lost device logs in with one in place of the TOTP code.
- The TOTP implementation is dependency-free and verified against the RFC 6238
  test vectors.

Turn it on for the whole app by pinning `mfaIssuer` (the label authenticator
apps show):

```ts
authPlugin({ users, secret, mfaIssuer: 'Acme' })
```

## 6. API keys

`apiKeysPlugin()` authenticates `mk_live_…` keys (via `Authorization: Bearer`
or `x-api-key`) and enforces **scopes** declared on routes. Keys are
tenant-scoped and created by a logged-in user.

```ts
apiKeysPlugin({ users })                 // `users` lets a key also populate ctx().user
// routes: [...authRoutes(), ...apiKeyRoutes(), yourScopedRoutes]
```

```ts
// a machine route requiring a scope
route({ method: 'GET', url: '/v1/export', meta: { scopes: ['read'] }, handler: () => … })
```

```bash
# create (as a logged-in user) — the key is shown exactly once
curl -X POST /apikeys -H "authorization: Bearer $ACCESS" -d '{"name":"CI","scopes":["read"]}'
# → 201 { "id": "…", "prefix": "mk_live_ab12cd", "scopes": ["read"], "key": "mk_live_ab12cd…" }

# use it
curl /v1/export -H "authorization: Bearer mk_live_ab12cd…"        # 200
curl /v1/export                                                  # 403 AUTH_SCOPE_REQUIRED
```

Only the SHA-256 hash and a short display prefix are stored; a leaked database
yields no usable keys. `GET /apikeys` lists them (no hash, no plaintext);
`DELETE /apikeys/:id` revokes. `*` in a key's scopes grants everything.

## 7. Team invitations

`@basaltkit/teams` turns a tenant into a multi-user team with a ranked role
hierarchy (`owner` > `admin` > `member`). Register the plugin and routes, and
seed the tenant's first owner when you create the tenant.

```ts
teamsPlugin({ access })   // optional `access` mirrors roles into @basaltkit/permissions
// routes: [...teamRoutes()]
```

```ts
// when an operator creates a tenant, make the creator its owner:
import { TEAMS } from '@basaltkit/teams'
await app.container.get(TEAMS).addMember(tenant.id, creator.id, 'owner')
```

The `teamRole` guard protects admin actions; accepting an invite only needs a
logged-in user.

| Endpoint | Requires | |
| --- | --- | --- |
| `POST /team/invites` `{ email, role? }` | `admin` | emails a token via `team:invited` |
| `POST /team/invites/accept` `{ token }` | login | enrolls the user at the invited role |
| `GET /team/invites` · `DELETE /team/invites/:id` | `admin` | list / revoke pending |
| `GET /team/members` | `member` | |
| `PATCH /team/members/:userId` `{ role }` · `DELETE …` | `admin` | change role / remove |

```bash
# admin invites (token emailed, never returned)
curl -X POST /team/invites -H "authorization: Bearer $ADMIN" -H "x-tenant-id: acme" \
     -d '{"email":"bob@acme.test","role":"member"}'

# bob accepts with the token from his email
curl -X POST /team/invites/accept -H "authorization: Bearer $BOB" -d '{"token":"…"}'
```

Invitations expire (default 7 days) and are single-use; a fresh invite for the
same address supersedes the pending one. The service refuses to demote or
remove the **last owner** (`TEAM_LAST_OWNER`).

## 8. Billing: Checkout, Portal, proration

Configure the Stripe gateway, then `billingRoutes()` gives the current tenant a
hosted subscribe flow and a self-service portal.

```ts
const plans = definePlans({
  free: { price: 0, features: { seats: 1 } },
  pro:  { price: 29, features: { seats: 10 }, trial: '14d' },
  team: { price: 99, features: { seats: 50 } },
})

const gateway = new StripeBillingGateway({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  priceId: (plan, period) => PRICE_IDS[`${plan}_${period}`], // your Stripe Price IDs
  customerId: (tenantId) => ensureStripeCustomer(tenantId),  // your tenant → customer map
})

subscriptionsPlugin({ plans, gateway, fallbackPlan: 'free' })
// routes: [
//   ...billingRoutes({ successUrl: `${APP_URL}/billing/ok`, cancelUrl: `${APP_URL}/billing` }),
//   billingWebhookRoute(gateway),
// ]
```

**Subscribe** — `POST /billing/checkout` returns a URL to redirect to. Basalt
records the subscription as `incomplete`; the Stripe webhook flips it to
`active` on payment (and teaches it the subscription id for later management).

```bash
curl -X POST /billing/checkout -H "authorization: Bearer $ACCESS" -H "x-tenant-id: acme" \
     -d '{"plan":"pro"}'
# → { "url": "https://checkout.stripe.com/c/pay/cs_…" }
```

**Manage** — `POST /billing/portal` returns the Customer Portal URL (update
card, cancel, view invoices):

```bash
curl -X POST /billing/portal -H "authorization: Bearer $ACCESS" -H "x-tenant-id: acme"
# → { "url": "https://billing.stripe.com/p/session/…" }
```

**Change plan with proration** — `swap()` pushes the change to Stripe and
credits/charges the mid-cycle difference:

```ts
import { SUBSCRIPTIONS } from '@basaltkit/subscriptions'
const subs = ctx().container.get(SUBSCRIPTIONS)

await subs.swap('acme', 'team')                  // create_prorations (default)
await subs.swap('acme', 'team', { prorate: false }) // switch at renewal, no settlement
```

::: warning Verify webhooks against the raw body
`billingWebhookRoute` checks the Stripe signature over the untouched bytes.
Configure a raw-body parser for `/billing/webhook` so re-serialization doesn't
break the HMAC — see the [Subscriptions guide](/guide/billing).
:::

## 9. The assembled app

```ts
const app = await createApp({
  plugins: [
    tenancyPlugin({ source: tenants, resolvers: [headerResolver()] }),
    mailerPlugin({ driver: 'smtp', smtp: { /* … */ }, from: 'no-reply@acme.test' }),
    authPlugin({ users, secret: process.env.JWT_SECRET!, mfaIssuer: 'Acme' }),
    apiKeysPlugin({ users }),
    teamsPlugin({ access }),
    subscriptionsPlugin({ plans, gateway, fallbackPlan: 'free' }),
    emailsPlugin,
    fastifyPlugin({
      routes: [
        ...authRoutes(),      // register/login/refresh/logout/me + verify + reset
        ...mfaRoutes(),       // enroll/activate/status/disable
        ...apiKeyRoutes(),    // create/list/revoke keys
        ...teamRoutes(),      // invites + members
        ...billingRoutes({ successUrl: `${APP_URL}/billing/ok`, cancelUrl: `${APP_URL}/billing` }),
        billingWebhookRoute(gateway),
      ],
    }),
  ],
}).boot()
```

## Security checklist

- **No enumeration** — verify/forgot/invite request routes always return `200`.
  Tokens are one-time, expiring, and delivered only by email.
- **Password reset is a global logout** — every refresh token is revoked.
- **MFA throttling** — a wrong second factor counts toward the login lockout; a
  merely-missing one does not.
- **Keys & recovery codes are hashed at rest** (SHA-256); plaintext is shown
  exactly once.
- **Least privilege** — API keys carry scopes; team actions carry a required
  role; the last owner can't be removed.
- **Webhook integrity** — signatures verified against the raw body, processing
  idempotent by event id.

## Where to go next

- [Authentication guide](/guide/auth) — sessions, refresh rotation, guards.
- [Teams guide](/guide/teams) — roles, the `teamRole` guard, permissions.
- [Subscriptions guide](/guide/billing) — plans, trials, quotas, webhooks.
- [Notes SaaS cookbook](/cookbook/notes-saas) — the same stack, end to end.
