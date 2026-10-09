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
- `Notifier` now decides each channel through `preference()` (then the
  notification's `defaults` and `mandatory`). A `NotificationPreferences`
  subclass that overrides `allowed()` (quiet hours, compliance blocks, plan
  gating) keeps working: the `Notifier` detects the override and lets it
  decide, as before — its answer is final and `defaults` do not apply to it
  (`mandatory` channels still bypass it). Overriding `allowed()` is
  deprecated: override `preference()` instead (`undefined` means "no stated
  preference"); the next major stops consulting an `allowed()` override.
- `inAppRoutes({ meta })` merges extra route metadata; `auth: true` is always kept.
