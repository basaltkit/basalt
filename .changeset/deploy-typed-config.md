---
'@basaltkit/deploy': minor
---

Typed config (RFC 0007 §2): `defineDeploy<typeof env>` types every `.env` key the config names (`env.fixed`/`generate`/`ask`/`derive`, `backup.urlKey`, infra `urlKey`s, `migrate.env`) from the app's `defineEnv`, with values following the schema (enum members, digits, `true`/`false`). `health.path` must start with `/`. Every field documents its default. New command `basalt-deploy check`: validates the config and types it with the app's own `tsc`, without a server. Configs without the type argument are unchanged.

`basalt-deploy init` writes `deploy.config.ts` from the project (RFC 0007 §3): the env schema read as text (secrets the app mints are generated, provider-issued ones and required keys asked), Prisma central/tenant migrations or the app's `db:deploy`, `web/`, a production compose file whose images are variables (Dockerfiles from `build:` or `docker/<name>/`), else PM2 with dedicated Postgres/Redis/MinIO from the env keys; with `--server`, the Apache vhosts already serving the domain and the ports taken. It never overwrites a config and runs `check` on what it wrote.
