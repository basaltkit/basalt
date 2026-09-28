---
'@basaltkit/auth-prisma': minor
'@basaltkit/permissions-prisma': minor
'@basaltkit/teams-prisma': minor
'@basaltkit/prisma': patch
---

MySQL column limits for `auth-prisma`, `permissions-prisma` and `teams-prisma` (framework audit FA-070, completing the set).

The same guard the other `*-prisma` packages gained: on MySQL a bare `String`
is `VARCHAR(191)`, and a server outside strict mode truncates a longer value
silently — a cut password hash never verifies, a cut sealed TOTP secret no
longer opens, a cut invitation email no longer names its recipient, and two
long permission names cut to one prefix collapse into a single grant.

- Each package ships **`schema.mysql.prisma`** (exported as
  `@basaltkit/<pkg>/schema.mysql.prisma`). `auth-prisma`: `AuthUser.email`
  `VARCHAR(254)`; `passwordHash`, the API key `name`, the MFA `secret`, the
  account link `subject`/`email` and the passkey
  `credentialId`/`publicKey`/`transports`/`deviceName` `TEXT`; `scopes` and
  `recoveryCodes` `Json` (MySQL has no scalar lists — the stores now read
  either form). `teams-prisma`: invitation `email` `VARCHAR(254)`.
  `permissions-prisma`: every column is part of a composite primary key and
  stays `VARCHAR(191)`. Keys stay indexable within InnoDB's 3 072-byte limit.
- Every factory and store class takes an optional **`columnLimits`**
  (`'mysql'` — `authMysqlColumnLimits`, `permissionsMysqlColumnLimits`,
  `teamsMysqlColumnLimits` — or your own). With it set, a value longer than
  its column is refused with `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`,
  422) before anything is written; `grantToRole`/`grantToUser` check the whole
  batch first.
- `basalt prisma:sync` now finds a MySQL variant for every package; its
  warning for an (older) package without one suggests upgrading it.

Unset, nothing changes: PostgreSQL and SQLite are unaffected, and existing
calls keep their signatures (the option is a new trailing parameter).
