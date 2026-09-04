---
'@basaltkit/permissions': minor
---

`meta.audience`: a permission is a capability, not a surface.

`matter:read` cannot tell "read my own case in the client portal" from "read the
case with the litigation strategy in it", so a role granted the first also
passed the guard on the second. That is how an authenticated portal client
received `200 OK` on an internal listing with their own case's strategy in the
body — found by hand, not by any test.

Nothing in the framework described *who a route is for*. `meta.auth`,
`meta.can`, `meta.teamRole`, `meta.subscribed`, `meta.feature` and `meta.tenant`
all answer other questions.

```ts
permissionsPlugin({
  store,
  audiences: { portal: { roles: ['client'], allow: ['portal', 'public'] } },
})

route({ url: '/portal/matters', meta: { can: 'matter:read', audience: 'portal' } })
```

**The default is the whole design: a route that declares no audience is
unreachable by a confined role.** Not "reachable unless marked internal" — the
other way round. Marking the internal routes is the obvious version, and it
fails the first time somebody adds a route without thinking about portals.
Marking the small, deliberate surface a restricted role may reach is a list
somebody maintains; marking every route they may not is a list somebody forgets,
once, silently.

**Confined only when every role the caller holds is named by a rule.** One
unnamed role and the audiences say nothing about them — because a lawyer who is
also a client of their own firm must keep working, and refusing them would lock
a member of staff out of their workplace the day the firm made them a client.
That rule is taken from the application that found the leak.

Two confined roles reach the union of their rules: each genuinely grants reach
to its own surface. What neither names stays closed.

**Audiences narrow; they never widen.** The permission check runs regardless, so
naming an audience is not a way in. Omit `audiences` and nothing changes.
