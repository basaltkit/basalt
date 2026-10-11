---
'@basaltkit/notifications': major
---

`preference()` is the only decision point; `NotificationPreferences.allowed()` is removed.

The `Notifier` decides each channel through `mandatory`, an inline opt-out, `NotificationPreferences.preference()`, an inline opt-in and the definition's `defaults` — nothing else. 1.3 detected a subclass that overrode `allowed()` and let it decide instead (deprecated); that detection is gone, and so is `allowed()` itself.

A preferences object that still defines `allowed()` (a 1.x override, with or without the `override` keyword) now makes `new Notifier()` throw the new `LegacyAllowedOverrideError` (`NOTIFICATION_ALLOWED_OVERRIDE_REMOVED`), so quiet hours or a compliance block written there are never dropped in silence. `notificationsPlugin` builds its own `NotificationPreferences` and is unaffected.

**Migrating.** Move the logic of an `allowed()` override into `preference()`: return `false` to block, `true` to send, and `undefined` (or `super.preference(...)`) to let the stored preferences and the definition's `defaults` decide. Unlike `allowed()`, `defaults` now apply when you return `undefined`, and `mandatory` channels still bypass it. Code that called `prefs.allowed(user, notification, channel)` can use `(await prefs.preference(user, notification, channel)) ?? true`.
