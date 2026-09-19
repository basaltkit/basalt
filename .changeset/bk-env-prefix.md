---
'@basaltkit/env': minor
'create-basalt': minor
---

App-specific env prefixes (BK-018, the half PR #368 left open).

`node --env-file=.env` never overrides a variable already exported in the shell, so an app reading generic names (`DATABASE_URL`, `PORT`) silently boots against another project's database and only fails on the first request. #368 documented the trap; this closes it.

- `@basaltkit/env`: `defineEnv(shape, { prefix })` reads every variable as `<PREFIX>_<NAME>` first — `prefix: 'MY_SAAS'` makes `DATABASE_URL` come from `MY_SAAS_DATABASE_URL`, falling back to the bare `DATABASE_URL`. The fallback is explicit and configurable: `prefix: { value: 'MY_SAAS', fallback: false }` requires the prefixed names and ignores the bare ones. The shape's keys never change (`env.PORT`), the prefixed name wins whenever it is *set* (an empty value counts as set, as in `process.env`), and `NODE_ENV` is never prefixed — it is a Node-wide convention read by the whole toolchain and by `secret()`.
- Error reports name the key the app actually looked for: `MY_SAAS_DATABASE_URL (or DATABASE_URL): Required` when neither name is set, `MY_SAAS_PORT: …` (or `PORT: …`) for an invalid value, depending on where it came from. With `fallback: false` only the prefixed name is named.
- New `EnvPrefixError` (`ENV_PREFIX_INVALID`): a prefix must itself be a valid variable name — uppercase letters, digits and single inner underscores, starting with a letter and not ending in `_`. `my-saas` or `1APP` fails at boot instead of looking up a variable nobody can set.
- Without `prefix`, `defineEnv` is byte-for-byte the old behaviour: the source object is parsed as-is, reports use the shape keys, and an unset `NODE_ENV` still counts as production for `secret()`.
- `create-basalt`: a scaffolded app now wires this. `src/env.ts` passes `prefix: '<PROJECT_NAME>'` (`my-saas` → `MY_SAAS`), and `.env.example` plus the generated README use the prefixed names (`MY_SAAS_PORT`, `MY_SAAS_HOST`, `MY_SAAS_LOG_LEVEL`, `MY_SAAS_APP_SECRET`, and `MY_SAAS_DATABASE_URL` for when a database is added). `NODE_ENV` stays unprefixed. The documented bare-name fallback means an existing deployment exporting the generic names keeps booting.
