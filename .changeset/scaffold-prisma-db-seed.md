---
'create-basalt': patch
---

`--prisma` scaffolds: `pnpm db:seed` now runs `prisma db seed` instead of `tsx prisma/seed.ts`. The old script did not load `.env`, so on a fresh app it died in `src/env.ts` (`<PREFIX>_DATABASE_URL` / `<PREFIX>_APP_SECRET` missing); through Prisma, `prisma.config.ts` loads `.env` and runs the `migrations.seed` command it already declares. The generated README and the docs no longer claim that `pnpm db:migrate` seeds the `demo` tenant — Prisma 7's `migrate dev` does not run the seed — and list `pnpm db:seed` as its own step. Existing apps can make the same one-line change to their `db:seed` script. Found by the new real-PostgreSQL e2e of the scaffold (CI job `scaffold-postgres`).
