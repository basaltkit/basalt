---
'create-basalt': minor
'@basaltkit/env': major
'@basaltkit/ai': minor
'@basaltkit/ai-mcp': patch
'@basaltkit/cli': patch
---

Security (scaffold & dev tooling hardening):

- `create-basalt`: with tenancy + auth (the default), new apps now depend on `@basaltkit/teams` and register `teamsPlugin()` + `tenantMembershipPlugin()`, so an authenticated user can no longer act on a tenant they do not belong to by changing `x-tenant-id`/`Host` (a dev-only seed adds registrants to the `demo` tenant). The `securityPlugin` global per-IP rate limit is now enabled, not commented out. `pnpm dev` runs a new `src/dev.ts` that opts into `NODE_ENV=development`; `pnpm start` does not, and the app's `NODE_ENV` now defaults to `production`. `@basaltkit/*` dependency ranges are generated from each package's current release line instead of a frozen `^1.0.0`. A `.dockerignore` is scaffolded.
- `@basaltkit/env`: `secret()` applies `devDefault`, and accepts placeholder-looking values, only when `NODE_ENV` is explicitly `development` or `test`. An unset `NODE_ENV` (or any other value) now counts as production, so a deploy that forgets `NODE_ENV` can no longer boot on the public dev default. Set `NODE_ENV=development` locally (the scaffold's `pnpm dev` does this).
- `@basaltkit/ai`: the `missing-tenant-membership` doctor rule now fires for tenancy + auth even when `@basaltkit/teams` is not installed (recommending installing it). Plans are validated before code generation: field and relation names must be plain identifiers, entity and audit-event names are restricted, and enum values are emitted as escaped string literals, so a crafted plan cannot inject code into generated sources (`assertSafePlan` / `UnsafePlanError`).
- `@basaltkit/ai-mcp`: `basalt_make` validates the client-supplied plan against `ArchitecturePlanSchema` instead of casting it, and rejects invalid plans.
- `@basaltkit/cli`: `basalt publish dockerfile` also writes a `.dockerignore`, so `COPY . .` can no longer bake `.env` or private keys into image layers.
