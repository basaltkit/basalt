---
"@basaltkit/activity": patch
"@basaltkit/api-keys-ui": patch
"@basaltkit/backup": patch
"@basaltkit/cli": patch
"@basaltkit/comments": patch
"@basaltkit/dashboard": patch
"@basaltkit/drives": patch
"@basaltkit/files": patch
"@basaltkit/inbound-mail": patch
"@basaltkit/teams": patch
"@basaltkit/teams-ui": patch
---

Dependency moves only. The `@basaltkit/http` dependency moves to `^3.0.0` (`api-keys-ui`, `cli`, `comments`, `drives`, `files`, `inbound-mail`, `teams`, `teams-ui`); `activity` moves `@basaltkit/tenancy` to `^4.0.0`, `backup` moves `@basaltkit/prisma` to `^4.0.0` and `dashboard` moves `@basaltkit/subscriptions` to `^6.0.0` (types only). Each is an ordinary dependency used as a private copy: these packages build routes, escape HTML or read the request context through it, and share no container token, error class or `RouteMeta` augmentation with the app, so their routes run on either line at runtime. No API change.

On an app still on `@basaltkit/fastify` 2.6 / `http` 2.8, a caret update of one of these installs a second, private copy of the new line next to the app's. Mixed lines are tested at runtime only: upgrade with the whole set (`pnpm basalt update`), see https://basaltkit-docs.pages.dev/guide/whats-new#upgrading-since-1-13.
