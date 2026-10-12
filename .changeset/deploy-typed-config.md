---
'@basaltkit/deploy': minor
---

Typed config (RFC 0007 §2): `defineDeploy<typeof env>` types every `.env` key the config names (`env.fixed`/`generate`/`ask`/`derive`, `backup.urlKey`, infra `urlKey`s, `migrate.env`) from the app's `defineEnv`, with values following the schema (enum members, digits, `true`/`false`). `health.path` must start with `/`. Every field documents its default. New command `basalt-deploy check`: validates the config and types it with the app's own `tsc`, without a server. Configs without the type argument are unchanged.
