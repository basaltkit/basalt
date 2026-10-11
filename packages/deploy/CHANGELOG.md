# @basaltkit/deploy

## 0.1.1

### Patch Changes

- 0dd8440: What the first production deploy (LexFirma) showed. Preflight now probes the git remote with prompts disabled: missing credentials are a warning at a terminal (with how to store them once) and an error without one, before anything changes; a branch missing on the remote is an error. Without a terminal the fetch runs with prompts disabled, so cron and CI fail instead of hanging. `prisma migrate deploy` runs by default only when `build.prisma` is set, and the pre-migration dump only when something is migrated and there is a Postgres to dump (`backup.beforeMigrate` and `migrate.central` still force either way); `plan` says why a step is skipped. The env, infra, validate and release steps print what they did. Every install hint is now `sudo node node_modules/@basaltkit/deploy/dist/bin.js install --user="$USER"` (`INSTALL_COMMAND`), which works when root has no pnpm on its PATH.

## 0.1.0

### Minor Changes

- abe7f86: New package (RFC 0006, phase 1): `basalt-deploy` deploys a Basalt app on one Linux server — `plan`, `run`, `env`, `rollback`, `status`, and `install` (root, once). `deploy.config.ts` (`defineDeploy`) declares the `.env` (fixed / generated once / asked once / derived / forbidden), dedicated Docker infra adopted or created by name (`dockerInfra`: Postgres, Redis, MinIO on 127.0.0.1, credentials read back from running containers), the build, migrations (central + `tenant:migrate`), a PM2 runtime and an Apache proxy whose vhost is written only by `install` and diffed, never rewritten, on every deploy. Every run validates the `.env` against the app's own `defineEnv` schema in a child process that sees only the file, dumps the database before migrating, health-checks on loopback and through the public URL, and rolls the code back when the release does not answer (never over a migration marked `destructive`). Preflight checks C1–C10 cover a foreign process on the app port, `sites-enabled` copies, a PM2 process running from another directory, process names outside `<app>-`, malformed `.env` lines, `"0"` read as true by a coerced boolean, a volume given a new password, the apex and wildcard certificates, the package-manager major, and forbidden or drifted keys. Secrets never reach a command line, the compose file or the terminal.
