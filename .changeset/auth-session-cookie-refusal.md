---
'@basaltkit/auth': major
---

A session cookie that breaks its name prefix's rule refuses the boot again.

A `sessionCookie.name` starting with `__Host-` or `__Secure-` (matched case-insensitively) together with an explicit `secure: false`, or a `__Host-` cookie with a `path` other than `/`, now throws `SessionCookieConfigError` (`AUTH_SESSION_COOKIE_INVALID`) from `authPlugin` registration and from `new Auth()`. Browsers drop such a cookie, so every login "succeeded" without a session; 4.2 emitted it as configured and printed a boot warning. The refusal is not deduplicated: every resolution of the options throws.

Unchanged: an unset `secure` on a prefixed name still implies `Secure` (and `Path=/` for `__Host-`), with its one-time warning outside production, and an unprefixed `sameSite: 'None'` cookie without `Secure` still only warns.

**Migrating.** Remove the contradicting `secure`/`path`, or switch the name with the environment so test clients over plain `http` keep working:

```ts
authPlugin({ sessionCookie: { name: isProd ? '__Host-sid' : 'sid' } })
```

A common trigger is `secure: process.env.NODE_ENV === 'production'` next to a `__Host-` name: in dev and test it is `false` and the app no longer boots.
