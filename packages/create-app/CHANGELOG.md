# create-basalt

## 1.0.1

### Patch Changes

- Register `basalt prisma:sync` in `--cli` apps out of the box. The generated CLI now
  adds `@basaltkit/prisma` and wires `prismaSyncCommand()` into `commandsPlugin`, so a
  fresh project can run `pnpm basalt prisma:sync --push` to merge every installed
  `@basaltkit/*-prisma` model into its `prisma/schema.prisma` — no hand-copying.
- Generated `pnpm-workspace.yaml` now excludes the `@basaltkit/*` scope from pnpm's
  `minimumReleaseAge` policy, so `pnpm up` is never blocked on a fresh Basalt release.

## 1.0.0

### Major Changes

- Generate 1.0 apps and ship ready-made auth flows. The @basaltkit/* dependency
  range is now `^1.0.0` (was `^0.4.0`/`^0.1.0`, which pinned very old packages).
  With `--auth`, the backend wires `mfaRoutes()` alongside `authRoutes()`, and the
  `--ui` frontend now ships the full standard flows out of the box: sign in with a
  TOTP challenge, register, forgot-password, reset-password (via the emailed
  `?token` link), and a dashboard that manages two-factor (enroll → secret/otpauth
  → activate → recovery codes → disable).

## 0.5.2

### Patch Changes

- 4926a63: Exit cleanly on Ctrl+C during the interactive prompts. Previously aborting a
  prompt dumped a raw Node `AbortError` stack trace; now it prints "Cancelled."
  and exits with code 130.

## 0.5.0

### Minor Changes

- Generated apps now pin `@basaltkit/generator` at `^0.2.0` so they pick up the `make:resource` auto-wiring (in semver 0.x, `^0.1.0` locks the minor). Added a per-package version override map (`versionOf`) for @basalt deps that cross a minor.

## 0.4.0

### Minor Changes

- New `--cli` flag scaffolds the `basalt` CLI entrypoint (`bin/basalt.ts`) and wires `@basaltkit/cli` + `@basaltkit/generator`, so a freshly-created app can run code generators and built-in commands out of the box: `pnpm basalt make:resource Project` (full schema→repository→service→plugin→routes→test vertical), individual `make:*` generators, plus `basalt routes` and `basalt schedule:list`. The generated `app.ts` registers `commandsPlugin(generatorCommands())` and a `basalt` npm script is added.

## 0.3.0

### Minor Changes

- New `--ui` flag scaffolds a `web/` frontend: React + authentic shadcn/ui components (`@basaltkit/admin-shadcn`) talking to the API through the type-safe `@basaltkit/sdk`, with a Vite dev server that proxies `/api` to the backend (no CORS). With auth on it ships a login/register gate and a small dashboard; otherwise a live status page. `web` is wired as a pnpm workspace member so its dependencies resolve.

## 0.2.0

### Minor Changes

- Generated apps now include a friendly `GET /` index route that lists the API's endpoints, so a fresh app no longer answers the root path with a bare 404. The generated smoke test covers it.
- The CLI became a real create-tool: interactive prompts when run without a name in a terminal, `--install` to install dependencies, `--git` to initialize a repository with a first commit, `--pm=<pnpm|npm|yarn|bun>` plus auto-detection via `npm_config_user_agent`, and `-y/--yes` to accept defaults. Next-steps output is tailored to the detected package manager.
- New exported helper `detectPackageManager()`.

## 0.1.1

### Patch Changes

- Fix generated apps depending on @basaltkit/\* at the ^0.0.0 placeholder; now ^0.1.0 (the published range).

## 0.1.0

- Initial release.
