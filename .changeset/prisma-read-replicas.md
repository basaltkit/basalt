---
'@basaltkit/prisma': minor
---

Read replicas: `readReplica({ primary, replicas })` wraps a Prisma client so
model reads (`findMany`, `count`, `aggregate`, `$queryRaw`, …) round-robin
across read replicas while writes, transactions and `$executeRaw` stay on the
primary. It's a dependency-free `Proxy` — pass it straight to
`prismaPlugin({ client })`. `db().$primary` forces the primary for
read-your-writes right after a write. With no replicas it returns the primary
unchanged, so the same wiring runs in every environment.
