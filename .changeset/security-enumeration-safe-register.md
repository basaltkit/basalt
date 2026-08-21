---
"@basaltkit/auth": minor
---

Enumeration-safe registration (M-2). The public `POST /auth/register` endpoint now returns the same `202 { ok: true }` (with equalized timing) whether the email is new or already registered, so it can no longer be used to discover which emails have accounts. A collision is signalled out-of-band via the new `auth:register_existing_email` hook (email the address "you already have an account"). New `Auth.registerSafely()` powers the route; the lower-level `Auth.register()` still throws `EmailTakenError` for programmatic/admin callers. Opt out with `authPlugin({ enumerationSafeRegister: false })` for the classic 409.

BREAKING (endpoint): `POST /auth/register` now responds `202 { ok: true }` instead of `201 <user>`, and no longer `409`s on a duplicate. Clients that read the returned user should call `/auth/login` (or `/auth/me`) after registering — the common register-then-login flow is unaffected.
