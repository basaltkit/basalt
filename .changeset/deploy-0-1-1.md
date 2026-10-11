---
'@basaltkit/deploy': patch
---

What the first production deploy (LexFirma) showed. Preflight now probes the git remote with prompts disabled: missing credentials are a warning at a terminal (with how to store them once) and an error without one, before anything changes; a branch missing on the remote is an error. Without a terminal the fetch runs with prompts disabled, so cron and CI fail instead of hanging. `prisma migrate deploy` runs by default only when `build.prisma` is set, and the pre-migration dump only when something is migrated and there is a Postgres to dump (`backup.beforeMigrate` and `migrate.central` still force either way); `plan` says why a step is skipped. The env, infra, validate and release steps print what they did. Every install hint is now `sudo node node_modules/@basaltkit/deploy/dist/bin.js install --user="$USER"` (`INSTALL_COMMAND`), which works when root has no pnpm on its PATH.
