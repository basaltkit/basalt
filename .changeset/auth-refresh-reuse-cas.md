---
'@basaltkit/auth': minor
'@basaltkit/auth-prisma': minor
'@basaltkit/auth-sqlite': minor
---

Refresh-token reuse detection is now atomic — a compare-and-swap, not a read-then-write.

**Advisory — this changes a store contract.** `Auth.refresh()` reads the record, checks `usedAt`, then calls `markUsed()`. The database stores implemented `markUsed` as an unconditional `UPDATE … WHERE token = ?`, so the check and the write were not one operation: two concurrent refreshes of the same token — the legitimate client and a thief racing it — could both read `usedAt = null` and both succeed. Rotation-reuse detection, the whole point of the family, never fired. Verified live: `Promise.allSettled([auth.refresh(t), auth.refresh(t)])` returned **two** valid token pairs.

`AuthTokenStore.markUsed` and `RefreshTokenStore.markUsed` now return `Promise<boolean | void>`: `true` when *this* call consumed the token, `false` when someone else already had. The shipped stores do a conditional update (`WHERE token = ? AND used_at IS NULL`, `where: { token, usedAt: null }`) and report the row count. `Auth.refresh()` treats `false` as reuse — it revokes the family and throws `AUTH_REFRESH_REUSED`; `consumeToken()` (email verification, password reset) treats it as a spent token and throws `AUTH_TOKEN_INVALID`. The same race now resolves to exactly one winner and one `RefreshReusedError`.

Returning `void` keeps the pre-CAS behaviour, so a **third-party store written against the old contract keeps compiling and working** — without the race protection. If you maintain one, make `markUsed` conditional and return whether it consumed the token.
