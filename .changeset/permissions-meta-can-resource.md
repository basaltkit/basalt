---
'@basaltkit/permissions': minor
---

Resource-aware `meta.can` (BK-049 / FA-H04): policies now run in the route guard.

A plain `meta.can: 'projects:update'` is RBAC — the guard never passed a resource, so a policy registered with `definePolicy` was never consulted and the documented workaround was to call the Gate inside the handler. `meta.can` now also accepts a resource requirement, alone or mixed with permission strings in an array (all-of):

```ts
meta: { can: { permission: 'projects:update', resource: ({ params }) => projects.findById(params.id) } }
```

The guard answers 401 without a user, checks the plain permissions first, then loads the resource (with the route's parsed `params`/`query`/`body`, the user, tenant, container and request) and calls `gate.authorize(user, permission, resource)`, so the policy decides. A loader returning `null`/`undefined` answers 404 `RESOURCE_NOT_FOUND` (or an audited 403 with `notFound: 'deny'` / plugin option `resourceNotFound: 'deny'`); a throwing loader propagates. The handler reads the loaded resource with `canResource<T>(permission?)` instead of loading it again.

A malformed requirement, or one whose `resource:action` no registered policy decides, refuses the boot through `http:meta-validators` (unless `onMissingPolicy: 'rbac'`). Listings (`http:route-visibility`, MCP `tools/list`) never call a loader: a policy-decided requirement stays listed for authenticated callers, plain permissions beside it still filter. New exports: `canResource`, `ResourceNotFoundError`, `CanResourceUnavailableError`, `gate.hasPolicy()`, and the `CanMeta`/`CanRequirement`/`CanResourceLoader`/`CanResourceInput`/`CanResourceNotFound` types. The string and string-array forms are unchanged.
