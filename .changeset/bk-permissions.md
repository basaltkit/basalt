---
'@basaltkit/permissions': minor
---

Role catalogue for per-tenant roles (BK-016). A role's permissions were looked up only in the scope where the role is held, so a catalogue granted once in `GLOBAL_SCOPE` never applied to roles `@basaltkit/teams` assigns per tenant — apps had to copy it into every tenant.

- `roleCatalog: { owner: ['*'], admin: [...], member: [...] }` (Gate / `permissionsPlugin` option): a code-defined role → permissions map valid in every scope. A role held in a scope grants its catalogue permissions in that scope only — never in another tenant, never globally. Union with store grants; snapshotted and validated at construction.
- `inheritGlobalRolePermissions: true | string[]` (opt-in, default `false`): a tenant-held role also resolves its permissions from its `GLOBAL_SCOPE` definition (and the legacy one with `readLegacyGlobalScope`), still granting only in that tenant. A list restricts it to those role names.
- New `gate.rolePermissions(role, scope)`; `GET /me/access` uses it when reading the Gate's store, so the frontend sees the same resolution.

Roles themselves (`hasRole`, `effectiveRoles`, `audienceRoles`, audience confinement) are unchanged.
