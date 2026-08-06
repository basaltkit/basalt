---
"@machize/generator": minor
---

`mach make:resource --prisma` (and per-artifact `make:repository --prisma`)
generates a Prisma-backed repository using `db<PrismaClient>()` plus a
`.prisma` model block to paste into schema.prisma, and wires the Prisma
repository in the generated plugin — closing the loop to real persistence
(incl. database-per-tenant). The default stays in-memory.
