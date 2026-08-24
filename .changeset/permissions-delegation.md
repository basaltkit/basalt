---
'@basaltkit/permissions': minor
---

Add temporary permissions and delegation. `gate.grantTemporarily(userId,
permissions, { ttlMs | expiresAt })` gives time-boxed access (break-glass,
short tasks) via a `TemporaryGrantStore`. `gate.delegate({ from, to, permissions,
expiresAt? })` lets one user act with a subset of another's authority via a
`DelegationStore` — bounded at check time to the delegator's *direct* permissions
(never lends more than the delegator has) and non-chaining (a delegatee can't
re-delegate authority it only holds by delegation). In-memory stores included;
both are opt-in via `GateOptions`.
