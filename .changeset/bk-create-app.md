---
'create-basalt': minor
---

pnpm 11 robustness and env-precedence guidance for scaffolded apps (BK-002, BK-018).

- Release-age aware version resolution: a third-party `latest` that is not provably older than pnpm's `minimumReleaseAge` window (default 1440 min, pnpm 11's default; follows `pnpm_config_minimum_release_age` / `npm_config_minimum_release_age`) keeps the bundled range instead of `^<latest>`, so the first `pnpm install` is never blocked by a just-published version. The age comes from one cheap `HEAD <registry>/<name>` per third-party package (`last-modified`, measured against the registry's `Date`); `@basaltkit/*` is never probed. New `ResolveLatestOptions.minimumReleaseAge` (`0` disables) and `now`, new `VersionResolution.tooFresh`, and exported `minimumReleaseAgeMinutes()` / `DEFAULT_MINIMUM_RELEASE_AGE_MINUTES` / `FreshVersion`.
- The generated `pnpm-workspace.yaml` documents that `minimumReleaseAgeExclude` is first-match-wins by package name (per-version exclusions of one package must be a single `'name@a || b'` union entry) and offers `verifyDepsBeforeRun: warn` as a commented, conscious opt-in.
- The generated README explains that with pnpm 11 `pnpm basalt …` may run `pnpm install` first and how to call the CLI directly (`node_modules/.bin/tsx bin/basalt.ts`).
- The generated `.env.example` and README warn that `--env-file` never overrides variables already exported in the shell and suggest an app-specific prefix derived from the project name (e.g. `MY_SAAS_DATABASE_URL`).
