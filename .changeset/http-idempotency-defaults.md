---
"@basaltkit/http": major
---

`idempotencyPlugin` is strict by default.

- `fingerprint` defaults to the new `'request'` mode: each key is bound to the route params, the query and the body (the exact bytes for a `rawBody()` route; params and query only for an `upload()` route). A reused key with a different request — `/accounts/2/charge` after `/accounts/1/charge`, another query string or another body — is refused with `422 IDEMPOTENCY_KEY_REUSED` instead of replaying the first result. `'body'` keeps its 2.x meaning (the body only).
- `replayAfterGuards` defaults to `true`: guards and request validation run before a replay, so a revoked caller gets `401`/`403` instead of the cached success, guards run on every replay, and a request failing validation never reserves the key.
- A `fingerprint` function may return any value: an object or array is canonicalized (keys sorted at every level); a string or other primitive is hashed by its string form, as before. An object used to hash as `"[object Object]"`, the same for every request.
- `replayAfterGuards` now rejects non-boolean values with a `TypeError`.

To keep the 2.x behaviour: `idempotencyPlugin({ fingerprint: false, replayAfterGuards: false })`.

No data step: scope hashes are unchanged and records stored by 2.x carry no fingerprint, so they keep replaying until they expire — except records 2.x fingerprinted under a hash that changes now (an app dropping an explicit `'body'` for the `'request'` default, or a function returning an object): a retry spanning the deploy gets `422`. Rolling deploys that share a `RedisIdempotencyStore` with `@basaltkit/fastify` ≤ 2.5 instances must move the whole fleet onto the last 2.x line (`@basaltkit/http` 2.8 / `@basaltkit/fastify` 2.6) first: older readers answer a concurrent repeat with `500` on the `pending:<fingerprint>` reservation every request now writes. Upgrade notes: https://basaltkit-docs.pages.dev/guide/whats-new#idempotency-strict-by-default
