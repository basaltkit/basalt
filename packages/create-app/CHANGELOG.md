# create-machize

## 0.5.2

### Patch Changes

- 4926a63: Exit cleanly on Ctrl+C during the interactive prompts. Previously aborting a
  prompt dumped a raw Node `AbortError` stack trace; now it prints "Cancelled."
  and exits with code 130.

## 0.5.0

### Minor Changes

- Generated apps now pin `@machize/generator` at `^0.2.0` so they pick up the `make:resource` auto-wiring (in semver 0.x, `^0.1.0` locks the minor). Added a per-package version override map (`versionOf`) for @machize deps that cross a minor.

## 0.4.0

### Minor Changes

- New `--cli` flag scaffolds the `mach` CLI entrypoint (`bin/mach.ts`) and wires `@machize/cli` + `@machize/generator`, so a freshly-created app can run code generators and built-in commands out of the box: `pnpm mach make:resource Project` (full schema→repository→service→plugin→routes→test vertical), individual `make:*` generators, plus `mach routes` and `mach schedule:list`. The generated `app.ts` registers `commandsPlugin(generatorCommands())` and a `mach` npm script is added.

## 0.3.0

### Minor Changes

- New `--ui` flag scaffolds a `web/` frontend: React + authentic shadcn/ui components (`@machize/admin-shadcn`) talking to the API through the type-safe `@machize/sdk`, with a Vite dev server that proxies `/api` to the backend (no CORS). With auth on it ships a login/register gate and a small dashboard; otherwise a live status page. `web` is wired as a pnpm workspace member so its dependencies resolve.

## 0.2.0

### Minor Changes

- Generated apps now include a friendly `GET /` index route that lists the API's endpoints, so a fresh app no longer answers the root path with a bare 404. The generated smoke test covers it.
- The CLI became a real create-tool: interactive prompts when run without a name in a terminal, `--install` to install dependencies, `--git` to initialize a repository with a first commit, `--pm=<pnpm|npm|yarn|bun>` plus auto-detection via `npm_config_user_agent`, and `-y/--yes` to accept defaults. Next-steps output is tailored to the detected package manager.
- New exported helper `detectPackageManager()`.

## 0.1.1

### Patch Changes

- Fix generated apps depending on @machize/\* at the ^0.0.0 placeholder; now ^0.1.0 (the published range).

## 0.1.0

- Initial release.
