---
"@basaltkit/notifications": minor
---

BK-078: `POST /me/notifications/read-all` now marks every unread notification
instead of stopping at 100 and reporting 100 — through the store's
`markAllRead` when it has one, otherwise page by page with a bounded loop. It
returns the true count.

Additive:

- `InAppStore` gains optional `markAllRead`, `prune({ readBefore?, unreadBefore? })`
  and `upsertGroup`; `MemoryInAppStore` implements all three. Stores implementing
  only the original four methods keep working.
- `InAppMessage.groupKey` collapses unread repeats into one row with a `count`
  (`InAppNotification` gains `groupKey?` and `count?`).
- `defineNotification({ defaults, mandatory })`: per-channel defaults when the
  recipient stated nothing (`{ sms: false }` makes SMS opt-in), and channels
  that ignore every opt-out. Enforced by `Notifier`; `allowed()` is unchanged and
  the new `NotificationPreferences.preference()` returns `undefined` when no
  preference matches.
- `inAppRoutes({ meta })` merges extra route metadata; `auth: true` is always kept.
