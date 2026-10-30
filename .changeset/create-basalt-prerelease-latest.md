---
'create-basalt': patch
---

`update` and the scaffold no longer blame the registry when a package's `latest` tag points at a pre-release (e.g. prisma `8.0.0-rc.29`): they say so and keep the current range, instead of "The registry did not answer for prisma".
