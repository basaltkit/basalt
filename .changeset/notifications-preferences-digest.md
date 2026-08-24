---
'@basaltkit/notifications': minor
---

Add per-user preferences and digest batching. `NotificationPreferences`
(`optOut`/`optIn`/`allowed`, backed by a `PreferenceStore`) persists opt-outs per
notification × channel with most-specific-wins resolution; the `Notifier` skips a
channel a user opted out of. `Digest` (`collect`/`flush`, backed by a
`DigestStore`) holds rendered notifications and flushes them grouped per
recipient+channel as one batch — a daily summary instead of immediate sends.
`notificationsPlugin({ preferences: true, digest: true })` wires both (in-memory
by default) and exposes the `PREFERENCES` / `DIGEST` tokens.
