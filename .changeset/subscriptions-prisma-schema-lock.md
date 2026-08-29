---
'@basaltkit/subscriptions-prisma': patch
---

Lock the reference `schema.prisma` (and the README copy users actually paste) to the columns the stores write.

`save()` writes every column of the subscription record on every call, including the `pendingPlan`/`pendingPeriod` fields the escalation guard clears by writing null. A reference schema missing any of them makes every save fail with an unknown-argument error on a database built by copying it. The schema is hand-maintained, so nothing but a test kept it in sync; there is now a test.
