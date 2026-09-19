# @basaltkit/ai-mcp

## 0.1.4

### Patch Changes

- fb85c40: Security (scaffold & dev tooling hardening):
  
  - `create-basalt`: with tenancy + auth (the default), new apps now depend on `@basaltkit/teams` and register `teamsPlugin()` + `tenantMembershipPlugin()`, so an authenticated user can no longer act on a tenant they do not belong to by changing `x-tenant-id`/`Host` (a dev-only seed adds registrants to the `demo` tenant). The `securityPlugin` global per-IP rate limit is now enabled, not commented out. `pnpm dev` runs a new `src/dev.ts` that opts into `NODE_ENV=development`; `pnpm start` does not, and the app's `NODE_ENV` now defaults to `production`. `@basaltkit/*` dependency ranges are generated from each package's current release line instead of a frozen `^1.0.0`. A `.dockerignore` is scaffolded.
  - `@basaltkit/env`: `secret()` applies `devDefault`, and accepts placeholder-looking values, only when `NODE_ENV` is explicitly `development` or `test`. An unset `NODE_ENV` (or any other value) now counts as production, so a deploy that forgets `NODE_ENV` can no longer boot on the public dev default. Set `NODE_ENV=development` locally (the scaffold's `pnpm dev` does this).
  - `@basaltkit/ai`: the `missing-tenant-membership` doctor rule now fires for tenancy + auth even when `@basaltkit/teams` is not installed (recommending installing it). Plans are validated before code generation: field and relation names must be plain identifiers, entity and audit-event names are restricted, and enum values are emitted as escaped string literals, so a crafted plan cannot inject code into generated sources (`assertSafePlan` / `UnsafePlanError`).
  - `@basaltkit/ai-mcp`: `basalt_make` validates the client-supplied plan against `ArchitecturePlanSchema` instead of casting it, and rejects invalid plans.
  - `@basaltkit/cli`: `basalt publish dockerfile` also writes a `.dockerignore`, so `COPY . .` can no longer bake `.env` or private keys into image layers.
- Updated dependencies [fb85c40]
- Updated dependencies [fb85c40]
  - @basaltkit/ai@1.3.0

## 0.1.3

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/ai@1.1.2
  - @basaltkit/mcp-core@0.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [f197518]
  - @basaltkit/mcp-core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [552cbe8]
- Updated dependencies [552cbe8]
- Updated dependencies [552cbe8]
- Updated dependencies [552cbe8]
- Updated dependencies [552cbe8]
  - @basaltkit/mcp-core@0.2.0
  - @basaltkit/ai@1.1.0
