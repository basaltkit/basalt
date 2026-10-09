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

To work on a single package, let turbo build its workspace dependencies first:

```bash
pnpm turbo run test --filter @basaltkit/core      # builds its @basaltkit/* deps, then tests
pnpm turbo run build --filter @basaltkit/core...  # the package and everything it depends on
```

Packages import each other through their published entry points, i.e. the
sibling's `dist/`. A bare `pnpm --filter <pkg> test` skips that build, so it
runs against whatever `dist/` is on disk: after you change `@basaltkit/http`,
`pnpm --filter @basaltkit/auth test` still exercises the OLD http until http is
rebuilt — green or red for the wrong reason. Use it only when the sibling
`dist/` folders are fresh (e.g. right after `pnpm build`). CI always builds
first (`turbo.json`: `test` depends on `^build`), so this only bites locally.
The three HTTP adapters resolve `@basaltkit/http` to its source in their vitest
config, so the adapter parity suites always see the current http.

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

- **Scaffold boot (`create-basalt`)** — `tests/production.test.ts` builds fresh
  scaffolds and starts `node dist/src/server.js`; the `--prisma` variant also
  migrates and boots against PostgreSQL when `BASALT_SCAFFOLD_DATABASE_URL`
  points at a **disposable** database (it applies the scaffold's schema there).

`docker compose up -d` also brings up Redis and MinIO for running a real app.

## Workflow

1. **Branch** from `main`.
2. **Make the change** with a test that fails without it and passes with it.
   Every bug fix and feature needs a test; we do not merge untested behavior.
3. **Add a changeset** describing the user-facing change:
   ```bash
   pnpm changeset
   ```
   Pick the affected packages and the bump type (patch/minor/major). Each
   `@basaltkit/*` package is versioned **independently** — a changeset bumps only
   the packages it touches.
4. **Open a pull request.** CI runs build, typecheck and tests on the supported
   Node versions; all must pass.

### Testing checklist

Two audit findings (FA-001, FA-002) slipped through suites that were green
because they only exercised the unusual case. Before calling a change tested:

- [ ] **Test the common handler shape on all three adapters.** Most handlers
  *return* a value (`handler: () => ({ ok: true })`); `reply.send(...)` is the
  exception. Anything that touches the request/response path gets a case in the
  shared suites every adapter runs — the parity matrix
  `packages/http/tests/adapter-parity.ts` (run by
  `packages/{fastify,express,hono}/tests/parity.test.ts`) or the cross-adapter
  conformance suite `packages/testing/tests/conformance.test.ts` — never a
  Fastify-only test. Cover the return-value shape, and `reply.send` only in
  addition to it.
- [ ] **Feed prototype names to every lookup keyed by user input.** Roles,
  permissions, tenant/plan/feature ids, header or field names, map/record keys:
  include `constructor`, `__proto__`, `toString` and `hasOwnProperty` as inputs
  and assert they behave like any unknown key (no match, no crash, no
  inherited value). Prefer `Map` or `Object.hasOwn` over `obj[key]` in the fix.
- [ ] **Prove the regression test fails on the old code.** Run the new test
  against the pre-fix sources (e.g. `git show HEAD:<path>` into a scratch copy,
  or temporarily revert the fix) and see it go red for the right reason, then
  green with the fix. Say so in the pull request.

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
