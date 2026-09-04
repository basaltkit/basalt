---
'@basaltkit/activity': minor
---

`activityRule` — record the feed from domain events.

`@basaltkit/search` has `syncRule({ hook, index, document })` and
`@basaltkit/realtime` has `bridgeRule({ hook, channel, event, data })`. Same
shape, and a good one: **the domain emits, the package listens, and neither
knows the other.** `activity` — the same use case, and probably the most common
of the three — had only the fluent builder, which is for writing a line by hand
inside a service.

The cost of the asymmetry is not the thirteen `hooks.on(...)` calls an
application writes instead. It is that the natural answer to "record this"
becomes "call `activity` from `MatterService`", which couples the domain to the
package the other two teach you to keep at arm's length.

```ts
activityPlugin({
  rules: [
    activityRule({
      hook: 'matter:opened',
      log: 'matters',
      subject: ({ matter }) => ({ type: 'matter', id: matter.id }),
      description: ({ matter }) => `opened matter ${matter.number}`,
      causer: ({ by }) => by,
    }),
  ],
})
```

`description` returning `null` records nothing, so one hook can produce a line
only for the events that deserve one. The line is written inside the emitter's
context, so it belongs to the tenant whose action produced it.

**A rule never rethrows**, and that is the one place it deliberately differs
from `syncRule`. `HookBus` propagates a handler's failure to whoever emitted the
event, which is right for an audit trail — a fact you failed to record must not
be reported as recorded — and wrong for a readable feed: a history line that
cannot be written must not fail the case closure that produced it. Failures go
to `onRuleError`, which warns on the console by default.

The tenancy documentation is corrected too. Both guides still described the old
fail-open behaviour — *"from a central/admin context (no tenant) you see
everything"* — which stopped being true when `activityPlugin` began selecting
`'required'` under tenancy.
