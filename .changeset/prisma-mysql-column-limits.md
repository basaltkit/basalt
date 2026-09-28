---
'@basaltkit/activity-prisma': minor
'@basaltkit/audit-prisma': minor
'@basaltkit/comments-prisma': minor
'@basaltkit/events-prisma': minor
'@basaltkit/files-prisma': minor
'@basaltkit/notifications-prisma': minor
'@basaltkit/subscriptions-prisma': minor
'@basaltkit/tenancy-prisma': minor
'@basaltkit/webhooks-prisma': minor
'@basaltkit/prisma': minor
---

MySQL no longer truncates long values silently (framework audit FA-070).

On MySQL Prisma maps a bare `String` to `VARCHAR(191)`, and a server outside
strict mode cuts a longer value with only a warning: a webhook URL delivered
elsewhere, a file `path` stopped naming its object, JSON payloads stopped
parsing, and a truncated audit payload or hash broke the hash chain for good.

- Each package ships **`schema.mysql.prisma`** (exported as
  `@basaltkit/<pkg>/schema.mysql.prisma`): the same models with the free-text
  columns widened (`@db.Text`, `@db.MediumText`, `@db.VarChar(255)`) and the
  keys left at `VARCHAR(191)`. `comments-prisma`'s variant stores `mentions` as
  `Json` (MySQL has no scalar lists); the store now reads either form.
- Every factory and store class takes an optional **`columnLimits`**
  (`'mysql'` — the preset matching that schema, exported as
  `<domain>MysqlColumnLimits` — or your own per-model limits, in characters or
  `{ bytes }`). With it set, a value longer than its column is refused with
  `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`, 422) before anything is
  written. The outbox's diagnostic `lastError` is shortened (marked
  `…[truncated]`) instead, so `markFailed` still counts the attempt.
- `basalt prisma:sync` (`@basaltkit/prisma`) copies the MySQL variant when the
  app's `datasource` provider is `mysql`, and warns about a package without one.

Unset, nothing changes: PostgreSQL and SQLite are unaffected, and existing
calls keep their signatures (the option is a new trailing parameter).
