---
'create-basalt': patch
---

BK-076: the scaffolded Prisma schema's `AuthSession` model carries the new nullable `lastSeenAt` column, matching `@basaltkit/auth-prisma`'s reference schema.
