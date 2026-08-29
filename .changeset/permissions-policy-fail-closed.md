---
'@basaltkit/permissions': minor
---

`can(user, permission, resource)` no longer degrades silently from ABAC to RBAC when the policy is missing.

**Advisory — this tightens a default.** `can()` looked up `resource:action` in the registered policies and, when nothing matched, *fell through to the permission strings*. A typo in either half — `doc:updat`, or `docs:update` for a policy registered as `doc` — meant the ownership check the author wrote never ran, and a broad grant like `doc:*` allowed the request. The gate answered `true` for a document owned by someone else.

Passing a resource is an explicit statement of ABAC intent, so an unmatched policy now throws `MissingPolicyError` (`PERMISSION_POLICY_MISSING`, 500). The message names the permission, lists the registered policies, and points at the three fixes: register the check with `definePolicy()`, correct the `resource:action` spelling, or drop the resource argument if plain RBAC was what you meant.

Nothing else moves: `can()` **without** a resource is untouched pure RBAC, a registered policy still decides on its own, and `superAdmin` still short-circuits first. The route guard never passes a resource, so no shipped route changes behaviour. To restore the historic fall-through — for apps that pass resources opportunistically — set `onMissingPolicy: 'rbac'` on the gate.
