---
'@basaltkit/testing': patch
---

Test what happens when an optional peer is genuinely absent.

Making the adapters optional peers stopped the duplication that produced a
`FASTIFY` token nobody registered, and a test asserts that shape so a
dependency cannot creep back. It could not assert the other half: that a
*missing* adapter yields an actionable message rather than a bare
`ERR_MODULE_NOT_FOUND`.

Inside the workspace that is untestable. Every package is installed, so
`import('@basaltkit/fastify')` always resolves — including from this package's
own `node_modules`, where fastify sits as a devDependency for its own tests.
Mocking the import would prove the `catch` block runs and say nothing about
resolution, which is the part that actually breaks.

So the fixture builds a tree outside the workspace: a copy of the built `dist`,
a `package.json`, and symlinks for the three real dependencies, with no adapter
anywhere. The copy is what makes it work — importing `dist` by its real path
leaves Node resolving from `packages/testing/node_modules` and the fixture
proves nothing, which is exactly what the first version of this test did.

A second case links the adapter in and asserts the *other* failure — the
unregistered token — so the fixture is known to tell the two apart rather than
passing for a reason nobody checked.
