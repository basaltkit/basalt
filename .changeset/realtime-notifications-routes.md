---
'@basaltkit/realtime': patch
'@basaltkit/notifications': patch
---

`authorize` receives the container, and in-app notifications have routes.

**realtime.** `authorize(connection, channel)` runs outside any request — there
is no `ctx()` when a client opens a stream — and `Connection` carries `id`,
`tenantId` and `userId`. Not roles, not permissions, which is exactly what
deciding "may this connection hear this channel" needs.

Applications stashed the container in a module-level variable and filled it from
a companion plugin's `boot`. That works and is quietly wrong when plugin order
changes. A third argument carries it:

```ts
realtimePlugin({
  authorize: (connection, channel, { container }) =>
    channel !== 'firm' || container.get(ACCESS).roles(connection.userId).includes('partner'),
})
```

A container and not resolved roles: a gate might want a subscription, a feature
flag, a per-tenant setting. Deciding that here would decide it for everyone.
Existing two-parameter gates are unaffected.

**notifications.** `inAppRoutes()` serves the four endpoints every application
wrote by hand: list, unread count, mark one, mark all.

The routing shape was opinionated enough to leave out; the security decision was
not, and is the same everywhere — **the recipient is the session, never a
parameter**. No handler reads an id from the query or the body, and a
`?recipientId=` is ignored rather than honoured: it is the shortest path to one
employee reading another's deadline alerts, and those name the case number.
Marking someone else's returns 404, not 403 — confirming it exists would already
say something about it.

Adds `@basaltkit/http` as a dependency, and moves the container tokens to their
own module so the routes can reach `IN_APP` without importing the barrel that
re-exports them.
