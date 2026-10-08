---
'@basaltkit/audit': minor
---

BK-083 (e): a new opt-in `actor` option on `auditPlugin` and `new Audit(..., { actor })`: `(context) => string | undefined`. It resolves who acts in a request, as the `actorId` an entry records, so non-human callers such as a service API key (`ctx().apiKey.serviceId`) can be attributed in the app's own id format. For example: `actor: (c) => c?.user?.id ?? (c?.apiKey?.serviceId ? 'svc:' + c.apiKey.serviceId : undefined)`.

The default stays `ctx().user?.id`, so nothing changes unless you opt in. There is no built-in prefix, and the entry shape and the hash chain are unchanged.

The resolved value is the request actor everywhere, so a manual `record()` whose `scope.actorId` differs from it throws, as it already does for a user. A resolver that is not a function, or that returns an empty, over-long or control-character id, throws a `TypeError`.
