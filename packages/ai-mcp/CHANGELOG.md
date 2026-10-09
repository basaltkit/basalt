# @basaltkit/ai-mcp

## 0.4.0

### Minor Changes

- f29b366: Reject malformed MCP `arguments` and stop echoing internal exception text (BK-047).
  
  - `@basaltkit/mcp-core`: `tools/call` now refuses a present-but-non-object `arguments` (array, string, number, `null`) with `INVALID_PARAMS` before the tool runs, and `prompts/get` requires an object of string values. An unexpected throw from a tool, resource or prompt now answers `INTERNAL_ERROR` with the generic text `Internal error` instead of the exception's `message` (which could carry secrets, paths or SQL). An error with `expose: true` keeps its message. The new `McpServerOptions.onError(error, message)` hook receives the original error for logging. Clients that parsed the `-32603` message text will now see `Internal error`.
  - `@basaltkit/mcp`: building the route request from tool arguments (argument splitting, URL filling) now runs inside the tool's error handling, so a failure there ends as a sanitised `isError` result instead of a raw `TypeError` text. New `onError` option on `mcpPlugin` / `McpServer` (and exported `reportMcpInternalError`, the default): an error that escapes a tool's own handling — the client sees only `Internal error` — is written as one line to stderr (never stdout, which carries the stdio protocol). Pass your own hook, or `false` to silence it. A tool call never forwards the idempotency key (`idempotency-key`, or the header `idempotencyPlugin({ header })` configured) into the route pipeline, even when it is listed in `forwardHeaders`: an idempotent replay returns the recorded response verbatim, so a replayed error would have reached the model with its `details` unredacted. Each tool call runs the handler; an app that listed the key to deduplicate tool calls must deduplicate inside the handler instead.
  - `@basaltkit/ai-mcp`: new `onError` option on `AiMcpOptions`; the `basalt-ai-mcp` bin logs the real cause of an internal error to stderr.

### Patch Changes

- Updated dependencies [e462501]
- Updated dependencies [f29b366]
  - @basaltkit/ai@1.4.0
  - @basaltkit/mcp-core@0.5.0

## 0.3.0

### Minor Changes

- b7171e5: Enforce "dev-only" at runtime and confine every tool's `workspaceRoot`.
  
  - **Breaking:** the server refuses to start when `NODE_ENV=production` (`AiMcpProductionError`, exported; the bin prints it and exits `1`, `createAiMcpHttpServer` rejects with it). Only an explicit `production` refuses — MCP clients launch the bin without `NODE_ENV`. Override deliberately with `--allow-production`, `allowProduction: true` or `BASALT_AI_MCP_ALLOW_PRODUCTION=1`. New exports: `assertDevOnly`, `AiMcpProductionError`, `ALLOW_PRODUCTION_ENV`, `WorkspaceEscapeError`.
  - **Breaking:** `basalt_analyze`, `basalt_doctor` and `basalt_plan` no longer accept an arbitrary absolute `workspaceRoot`. It must resolve inside the server's project root (`--cwd`), lexically and after symlink resolution; anything else returns a `Refused: … is outside the project root` tool error (and `resolveWorkspaceRoot` throws `WorkspaceEscapeError`). Relative roots now resolve against the project root.

## 0.2.0

### Minor Changes

- e54b7b1: `basalt_make` apply now fails closed (framework audit FA-040), and the HTTP
  transport requires a token off loopback (FA-039). Minor because the package is
  0.x, where a minor is the breaking slot.
  
  - **Breaking:** an `apply` that cannot be confirmed — the client does not
    support elicitation, or the call came over HTTP — is **refused** instead of
    writing silently. Over stdio, a client that announces the `elicitation`
    capability is now actually asked (the core wires `elicitation/create`).
    Restore the old behaviour explicitly with `--allow-unconfirmed-apply`
    (`allowUnconfirmedApply: true`).
  - **Breaking:** `--http --host=<non-loopback>` is refused unless a token is
    given (`--token=<secret>` or `BASALT_AI_MCP_TOKEN`); every request must then
    send `Authorization: Bearer <secret>`. New `--allowed-hosts=a,b` accepts the
    hostnames remote clients use. Programmatic: `token`, `authorize`,
    `maxBodyBytes`, and the exported `bearerAuthorizer(token)`.
- b69ea05: `createAiMcpHttpServer` now passes `sessions` and `principal` through to `@basaltkit/mcp-core`'s `serveHttp` (they were accepted by the type but dropped), and the bin gains `--sessions` (with `--http`). With sessions on, `initialize` issues an `Mcp-Session-Id`, later requests must carry it (`400` without, `404` for an unknown, expired or foreign one), and a `notifications/cancelled` POSTed separately cancels the call it names — e.g. a long `basalt_make` — within the same session only. The default is unchanged: stateless, so existing header-less clients keep working.

### Patch Changes

- Updated dependencies [e54b7b1]
- Updated dependencies [e53db52]
- Updated dependencies [b69ea05]
  - @basaltkit/mcp-core@0.4.0

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
