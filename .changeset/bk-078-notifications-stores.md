---
"@basaltkit/notifications-prisma": minor
"@basaltkit/notifications-sqlite": minor
---

BK-078: the in-app stores implement the new optional `markAllRead` (one
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
