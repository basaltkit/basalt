---
'@basaltkit/permissions': major
---

`hasRole()` answers role membership; `GET /me/access` reports every source a check honours (FRAMEWORK-AUDIT "Melhorias" 3).

**Breaking — `gate.hasRole(user, role)` no longer returns `true` for every role to a super admin.** It now answers only whether the user actually holds `role` (in the current scope or globally), like `effectiveRoles()` and the audience guard already did. The `superAdmin` bypass still short-circuits `can()`, `authorize()` and `meta.can` — it is authority, not membership: a super admin used to "hold" `client`, `trainee` and any role name ever typed, so role-based UI and audience-style logic misclassified them.

Migration: where `hasRole()` was used as an authorization check, check the permission instead (`gate.can(user, 'billing:refund')`), or ask for the bypass explicitly with the new `gate.isSuperAdmin(user)`:

```ts
// before
if (await gate.hasRole(user, 'billing-manager')) { … }
// after — same answer for super admins as before
if ((await gate.isSuperAdmin(user)) || (await gate.hasRole(user, 'billing-manager'))) { … }
```

**`GET /me/access` (`accessRoutes()`) no longer hides doors that open.** It used to read the current tenant's standing grants only, so a `@global` grant or role, a temporary grant (`grantTemporarily`), a delegation (`delegate`) or the super-admin bypass passed on the server while the menu hid the control. The response now comes from the new `gate.describeAccess(user)`:

- `roles` — roles held in the current scope **or globally** (what `hasRole()` answers `true` for);
- `permissions` — every permission that opens a door (current scope + global + legacy global when read, live temporary grants, live delegations narrowed to what the delegator holds, `'*'` for a super admin), sorted and deduplicated; `permitted(permissions, p)` agrees with `gate.can(user, p)`;
- `superAdmin` — new boolean;
- `grants` — new: each permission with its `source` (`'direct' | 'role' | 'temporary' | 'delegation' | 'super-admin'`), `scope`, and `role` / `id` / `fromUserId` / `expiresAt` where they apply (a delegation's `expiresAt` is the earlier of its own deadline and that of the delegator's temporary grant it rests on).

`roles` and `permissions` keep their shape; clients reading them see more (correct) entries. New exports: `gate.describeAccess()`, `gate.isSuperAdmin()`, and the `AccessReport` / `AccessGrant` types.
