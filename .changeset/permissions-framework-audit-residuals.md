---
'@basaltkit/permissions': major
'@basaltkit/permissions-sqlite': major
'@basaltkit/permissions-prisma': major
---

Framework audit residuals: empty permission segments and malformed store writes.

- **An empty segment never matches.** `permissionMatches('projects:*', 'projects:')` and `permissionMatches('', '')` used to return `true` (the wildcard matched the empty action; equal strings short-circuited). A permission with an empty `:` segment — `''`, `'projects:'`, `':read'`, `'a::b'` — now matches nothing, not even itself, and `'*'` does not cover it. New `hasEmptySegment(permission)` (also on the browser-safe `@basaltkit/permissions/match` entry).
- **The Gate refuses such permissions.** `can()`, `grantToRole`/`grantToUser`/`grantTemporarily`/`delegate` and `roleCatalog` throw a `TypeError` for a permission with an empty segment, as they already did for whitespace. `MemoryAccessStore.assignRole`/`grantToRole` also refuse an empty or non-string role name.
- **`SqliteAccessStore` / `PrismaAccessStore` validate direct writes.** `assignRole`, `removeRole`, `grantToRole` and `grantToUser` throw a `TypeError` for an empty or non-string user id, role name or scope, or a permission list that is not an array of non-empty strings — before anything is written. `''`, `null` and `undefined` used to be persisted and shared one "nobody" key.

**Why major:** input that used to be accepted now throws. Migration: find stored grants with an empty segment (`SELECT … WHERE permission LIKE '%:' OR permission LIKE ':%' OR permission LIKE '%::%' OR permission = ''`) — they never granted anything meaningful and can be deleted; seed scripts that write to the store directly must pass real ids and role names.
