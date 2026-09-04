---
'@basaltkit/testing': major
---

Every HTTP adapter is now an optional peer, `@basaltkit/fastify` included.

`@basaltkit/express` and `@basaltkit/hono` were already optional peers — the
application's copy is used, and there can only be one. `@basaltkit/fastify` was
a plain dependency, because fastify is the default adapter.

That asymmetry has a cost that surfaces only on a version skew. When this
package moved its fastify range to `^2` while an application was still on `1.x`,
pnpm installed **both**, and `createTestApp` resolved a `FASTIFY` token from a
different copy than the one the app's `fastifyPlugin` had registered — two
`createToken('fastify')` calls, two object identities, one container that cannot
match them. What the developer saw was:

```
UnknownTokenError: No provider registered for token "fastify".
Register it with container.singleton()/scoped()/transient() in some plugin.
```

Five untouched tests failed and the message named a missing plugin. Neither this
package nor the version skew appears anywhere in it. It took half an hour to
find.

A peer cannot duplicate. There is one copy, the application's, and a version
skew now surfaces at install time as a peer warning instead of at runtime as a
token that does not exist.

**BREAKING: `app.server` is now `await app.server()`.** The adapter is imported
on demand — the same way `express` and `hono` already were — so that an
application booted with no HTTP plugin at all still works and so that nothing
here reaches for a package the app may not have installed. Resolving a token
through a dynamic import cannot be synchronous.

```diff
- const fastify = app.server
+ const fastify = await app.server()
```

A major for a change of this shape, which is the other half of the lesson: the
release that moved a peer range to a new major should itself have been a major.
An application declaring `^1.1.3` does not expect a tree with two adapters in
it.

A test now asserts the package.json shape directly — every adapter a peer, none
a dependency, and no HTTP framework pulled in either — so the next person to add
one has to mean it.
