---
'create-basalt': minor
---

A new app ships `deploy.config.ts` (RFC 0007 §3): `@basaltkit/deploy` as a devDependency, PM2 behind Apache, a dedicated Postgres when the app has one, the compiled build, its own `APP_SECRET` generated on the server, typed by `src/env.ts`. `add ui` adds the frontend build to it. The domain is the one value to change.
