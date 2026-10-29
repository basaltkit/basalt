---
'@basaltkit/ai': patch
---

The `ai:plan` package catalog now carries each package's wiring as its README shows it — plugin options, the Prisma store variant and the DI token — so plans name the real API instead of guessing it (e.g. `mailerPlugin({ driver, from })` and `container.get(MAILER)`, not `app.register(mailerPlugin, { provider: 'smtp' })`). A test fails if an example calls a function the monorepo does not export.
