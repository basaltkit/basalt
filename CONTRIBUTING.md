# Contributing to Basalt

Thanks for helping build Basalt. This guide covers the setup, the workflow and
the conventions that keep the monorepo coherent.

## Setup

Requirements: Node.js ≥ 22 and [pnpm](https://pnpm.io) (the version is pinned in
`package.json` via `packageManager`; `corepack enable` picks it up).

```bash
pnpm install
pnpm build       # turbo, topological
pnpm test        # every package
pnpm typecheck
```

To work on a single package:

```bash
pnpm --filter @basaltkit/core test
pnpm --filter @basaltkit/core build
```

### Integration tests

Two levels of database integration:

- **In-process (default `pnpm test`)** — `@basaltkit/prisma` runs against real
  PostgreSQL via [pglite](https://github.com/electric-sql/pglite) (WASM, no
  server), covering `CREATE SCHEMA`, per-tenant `search_path` isolation and
  tenant-scoped filtering everywhere, including CI.
- **Server + real Prisma client (`apps/pg-integration`)** — exercises the
  `tenancyExtension` end to end through a generated Prisma client against a
  PostgreSQL server. Gated on `TEST_DATABASE_URL`, so it skips in the default
  run; the CI `integration` job runs it against a Postgres service. Locally:

  ```bash
  docker compose up -d
  export TEST_DATABASE_URL=postgresql://basalt:basalt@localhost:5432/basalt
  pnpm --filter pg-integration prisma:generate
  pnpm --filter pg-integration db:push
  pnpm --filter pg-integration test:integration
  ```

`docker compose up -d` also brings up Redis and MinIO for running a real app.

## Workflow

1. **Branch** from `main`.
2. **Make the change** with a test that fails without it and passes with it.
   Every bug fix and feature needs a test; we do not merge untested behavior.
3. **Add a changeset** describing the user-facing change:
   ```bash
   pnpm changeset
   ```
   Pick the affected packages and the bump type (patch/minor/major). The
   `@basaltkit/*` packages are versioned in lockstep — bumping one bumps all.
4. **Open a pull request.** CI runs build, typecheck and tests on the supported
   Node versions; all must pass.

## Conventions

- **TypeScript, strict.** No `any` at API boundaries; let inference flow from
  Zod schemas through to callers.
- **Comments and error messages in English.** This is an international project.
- **Stable error codes are API.** The `code` on a `BasaltError` subclass is
  part of the contract — renaming one is a breaking change.
- **The dependency-layer rule.** A package may only depend on packages in a
  lower layer (foundation → infrastructure → domain → product). Same-layer
  packages communicate through events and core contracts, never direct imports.
  See [ARCHITECTURE.md](./ARCHITECTURE.md) §2.
- **Every driver passes the same conformance suite.** New cache/storage/queue/
  mail drivers must satisfy the shared contract and its tests.
- **Prefer fakes over mocks.** Use the in-memory stores and `@basaltkit/testing`
  fakes; assert on behavior, not on call counts where a fake will do.

## Reporting bugs

Open an issue using the bug template and include a **minimal reproduction** —
ideally a small repo or a StackBlitz. A reproduction is the single most useful
thing you can attach.

## Security

Do not open public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the MIT
License, the same as the project.
