---
'@basaltkit/auth': minor
---

Registration policy per plane (BK-044).

- `authRoutes({ register: 'open' | 'closed' | RegisterPolicy })` controls `POST /auth/register`. `'closed'` answers a static `404 AUTH_REGISTRATION_CLOSED` to every request. A `RegisterPolicy` predicate (`({ email, tenantId? }) => boolean | Promise<boolean>`, `tenantId` read from `ctx().tenant`) that refuses answers the same `202` as a success, creates nothing and emits the new `auth:register_refused` hook, so the route cannot be used to learn who was invited.
- `authPlugin({ registerPolicy })` sets the default for the route and also gates the create branch of `socialLogin` (refused with the new `RegistrationClosedError`, `404 AUTH_REGISTRATION_CLOSED`). Logins into existing accounts and the trusted `auth.register()` are never gated.
- Default is unchanged (open). `@basaltkit/teams`' `teamsInviteGate(teams)` provides "invite-only on tenant hosts".
