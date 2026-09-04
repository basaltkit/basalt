---
'@basaltkit/admin': major
'@basaltkit/audit-viewer': major
'@basaltkit/auth': major
'@basaltkit/comments': major
'@basaltkit/env': major
'@basaltkit/fastify': major
'@basaltkit/files': major
'@basaltkit/http': major
'@basaltkit/mcp': major
'@basaltkit/sdk': major
'@basaltkit/subscriptions': major
'@basaltkit/teams': major
'@basaltkit/ai': minor
---

**Zod 3 is no longer supported.** These packages now require zod 4.

The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
change for any application still on zod 3: the install will refuse the peer
rather than fail somewhere subtle at runtime, which is the point of declaring it.

The move itself was overdue — the repository has been testing against zod 4 only
for some time, through a workspace override, so the second half of that range was
a claim nobody was checking. Supporting a major version you never run is worse
than not supporting it: it holds back the API surface (a schema written against
zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
compatibility that would break on first contact.

**Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
migration guide covers the API changes; the ones that touch Basalt users most are
`z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
moving from `message`/`invalid_type_error` to a single `error` parameter.

The peer asks for `^4.0.0` and not the version this repo happens to test —
requiring the newest 4.x would force every consumer to move in step with us for
no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
so its range narrowing is not breaking for anyone.

**The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
`switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
`z.toJSONSchema` does natively — reachable only when the native converter was
absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
`_def` for every introspection. Both are gone, along with the coverage test
that existed solely to drive the dead path by mocking zod's converter away.

`create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
generated after this change would have failed its own install against the new
peer; it now scaffolds `^4.0.0`.
