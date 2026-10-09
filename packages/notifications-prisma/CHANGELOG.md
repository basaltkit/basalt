# @basaltkit/notifications-prisma

## 1.2.0

### Minor Changes

- 06337df: BK-078: the in-app stores implement the new optional `markAllRead` (one
  statement, uncapped), `prune` (retention across recipients) and `upsertGroup`
  (collapse onto the recipient's unread row with the same `groupKey`). Each also
  ships a durable `PreferenceStore`: `prismaPreferenceStore(prisma)` /
  `PrismaPreferenceStore` over a new `NotificationPreference` model, and
  `sqliteInAppStore(...).preferences` / `SqlitePreferenceStore` over a
  `notification_preferences` table.
  
  Prisma: the reference schemas gain the optional `groupKey String?` and
  `count Int?` columns on `InAppNotification` and the `NotificationPreference`
  model. The grouping columns are written only by grouped notifications, so an
  existing schema keeps working until you use `groupKey`; the preference model is
  only needed for `prismaPreferenceStore`. SQLite: `migrate()` adds the
  `group_key`/`count` columns to databases created by older versions.

## 1.1.0

### Minor Changes

- b69ea05: MySQL no longer truncates long values silently (framework audit FA-070).
  
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

## 1.0.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.4

### Patch Changes

- Fail fast with an actionable error when the Prisma client is missing the models this package needs (previously a cryptic "reading create of undefined") — points to `basalt prisma:sync` or the reference schema. Lazy/proxy clients (database-per-tenant) are tolerated.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.29.0

### Minor Changes

- Initial release. Prisma-backed implementation of the @basaltkit/notifications `InAppStore` (in-app inbox), on a Prisma client (PostgreSQL/MySQL); ships a reference `schema.prisma`. `prismaInAppStore(prisma)` returns the store named to drop straight into `notificationsPlugin`. The production counterpart to `@basaltkit/notifications-sqlite`.
