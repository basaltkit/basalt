# Configuration

Two small packages cover everything an app needs to know about its own settings.
[`@basaltkit/env`](/reference/packages/env) validates the **outside world** —
`process.env` — once, at startup, and hands back a typed frozen object.
[`@basaltkit/config`](/reference/packages/config) is the **inside world**: one
namespaced repository, read by dot-path, that any plugin can reach through the
`CONFIG` token. Both fail loud: a missing variable or a missing key is an error
at boot, never an `undefined` that surfaces three layers deep in a handler.

[[toc]]

## Mental model

There are three distinct layers, and confusing them is the usual source of
"where does this value actually come from?":

| Layer | Owned by | Validated by | Read as |
| --- | --- | --- | --- |
| Environment variables | The host (shell, `.env`, the platform dashboard) | `defineEnv(shape)` — once, before `createApp` | `env.PORT` — typed, frozen |
| Application settings | You, as one object organized by namespace | Nothing — it's your object | `config.get('mail.from')` |
| Per-plugin config slice | `createApp({ config })`, keyed by plugin name | The plugin's own `configSchema` | `context.config` inside the plugin |

The flow runs one way: **environment → settings object → `configPlugin`**. There
is no file scanner and no automatic `MAIL_FROM` → `mail.from` mapping. You write
the mapping yourself, which is why it is greppable.

::: tip Neither package reads `.env`
`defineEnv` reads `process.env` and nothing else. Load the file before the
module is imported — `node --env-file=.env` (Node 22 ships it) or your process
manager's own mechanism. A `.env` sitting next to `src/env.ts` does nothing on
its own.
:::

## Quickstart

```ts
import { createApp, definePlugin } from '@basaltkit/core'
import { CONFIG, configPlugin } from '@basaltkit/config'
import { defineEnv, secret } from '@basaltkit/env'
import { z } from 'zod'

// 1. Validate the environment first — this throws before anything boots.
const env = defineEnv({
  PORT: z.coerce.number().default(3000),
  SMTP_HOST: z.string(),
  APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-value' }),
})

// 2. Fold it into one settings object, organized by area.
const settings = {
  app: { name: 'my-app', port: env.PORT, secret: env.APP_SECRET },
  mail: { from: 'hi@basalt.dev', smtp: { host: env.SMTP_HOST, port: 587 } },
}

// 3. Any plugin reads it through the CONFIG token.
const mailPlugin = definePlugin({
  name: 'app:mail',
  dependsOn: ['basalt:config'], // config registers first
  register({ container }) {
    const config = container.get(CONFIG)
    const from = config.get<string>('mail.from')          // 'hi@basalt.dev'
    const port = config.get<number>('mail.smtp.port', 25) // 587 — 25 only if absent
  },
})

await createApp({ plugins: [configPlugin(settings), mailPlugin] }).boot()
```

`configPlugin` registers a `ConfigRepository` singleton under `CONFIG` and
`structuredClone`s the object you passed, so later writes to the repository
never mutate your source object (and vice versa).

## Reads that fail loud

```ts
config.get('mail.from')          // → 'hi@basalt.dev'
config.get<number>('mail.smtp.port') // → 587, typed by the explicit type argument
config.get('mail.replyTo', null) // → null   (explicit fallback, no throw)
config.get('mail.replyTo')       // → throws ConfigKeyError (CONFIG_KEY_MISSING)
config.has('queue.driver')       // → boolean, never throws
```

A missing key with **no** fallback throws `ConfigKeyError` — the mistake
surfaces where the value is first needed (usually plugin registration, i.e.
boot) rather than as an `undefined` that quietly becomes `NaN` at 3 a.m.

::: warning A fallback of `undefined` still counts as a fallback
The check is on the number of arguments, not on the value. `get(path,
undefined)` returns `undefined` instead of throwing. If you want the throw, call
`get(path)` with exactly one argument.
:::

## Writing and merging

`set` writes one path, creating intermediate objects as needed. `merge` layers a
whole object on top, deep-merging plain objects only:

```ts
config.set('queue.driver', 'bullmq')  // creates 'queue', then 'queue.driver'

config.merge({ mail: { smtp: { host: 'smtp.acme.com' } } })
config.get('mail.smtp.port') // 587 — the sibling key survives
config.get('mail.smtp.host') // 'smtp.acme.com'

config.all() // the whole tree, typed Readonly (it is the live object, not a copy)
```

Arrays and primitives are **replaced**, not concatenated — only plain objects
recurse. To append to an array, `get` it, change it, and `set` it back.

::: danger Prototype-pollution keys are refused
`set('__proto__.isAdmin', true)` — or a `constructor` / `prototype` segment —
throws `ConfigUnsafeKeyError` (`CONFIG_UNSAFE_KEY`). `merge` takes the same
three keys but **drops them silently** at every depth, because it is the method
that typically receives parsed JSON or remote overrides. Neither one can reach
`Object.prototype`.
:::

## Typing your namespaces

`ConfigRepository.get` is generic (`get<T>(path, fallback?)`), so a read is as
typed as you make it. For a namespace shared across packages, declare its shape
once with module augmentation — that is what the `BasaltConfig` interface is
for:

```ts
declare module '@basaltkit/config' {
  interface BasaltConfig {
    mail: { from: string; smtp: { host: string; port: number } }
  }
}
```

The augmentation documents and types the namespace for everyone consuming
`BasaltConfig`; the dot-path read itself still takes its type from the explicit
argument, `config.get<number>('mail.smtp.port')`.

## The environment layer

`defineEnv(shape)` validates every variable in one pass and aggregates **all**
failures into a single report, so you fix your environment once instead of
restarting after each missing variable:

```ts
import { defineEnv, EnvValidationError } from '@basaltkit/env'
import { z } from 'zod'

try {
  defineEnv({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    PORT: z.coerce.number().default(3000),
  })
} catch (error) {
  if (error instanceof EnvValidationError) {
    error.code   // 'ENV_INVALID'
    error.report // ['DATABASE_URL: Required', 'REDIS_URL: Required']
  }
}
```

Two things to remember. Environment variables are always **strings**, so use
`z.coerce.number()` / `z.coerce.boolean()`, never bare `z.number()`. And the
returned object is `Object.freeze`d — the environment is read-only by design; if
you need something mutable, that is what the config repository is for.

In tests, point it somewhere else instead of mutating `process.env`:

```ts
const env = defineEnv(
  { DATABASE_URL: z.string().url() },
  { source: { DATABASE_URL: 'postgres://localhost:5432/app' } },
)
```

## Secrets that fail closed

`secret()` is a Zod string schema for signing keys and API credentials, with a
production policy baked in:

```ts
export const env = defineEnv({
  // Boots out of the box in dev; refuses to boot in production without a real value.
  APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-value' }),
  // No devDefault: required in every environment.
  STRIPE_SECRET_KEY: secret(),
})
```

Three rules, decided by reading `process.env.NODE_ENV` at validation time:

- **Required in production** — `devDefault` is never applied when
  `NODE_ENV=production`. A fresh clone runs locally; the same code refuses to
  start in production until a real secret exists.
- **Placeholders rejected in production** — a value matching `change-me`,
  `changeme`, `placeholder`, `example`, `secret`, `password`, `default`, `test`,
  `xxxx…` or `0000…` fails. In development they pass, for convenience.
- **Minimum length everywhere** — 16 characters by default, including for the
  `devDefault` itself, which is validated like any other value.

Generate a real one with `openssl rand -base64 48`. See the
[security guide](/guide/security) for the rest of the production checklist.

## Per-plugin config slices

Separate from all of the above, `createApp({ config })` passes a **raw slice per
plugin name** to that plugin's lifecycle, validated by the plugin's own
`configSchema` before `register` runs:

```ts
await createApp({
  config: { 'basalt:cache': { driver: 'memory' } },
  plugins: [cachePlugin()],
}).boot()
```

An invalid slice throws `ConfigValidationError` (`CONFIG_INVALID`) at boot,
naming the plugin. Most Basalt plugins take their options as arguments
(`cachePlugin({ … })`) rather than through this channel — it exists for plugins
that want their configuration declared centrally, and it is unrelated to the
`CONFIG` repository. See [Core Concepts](/guide/concepts).

## Sources & precedence

Nothing is implicit, so precedence is just evaluation order — later writes win:

1. **`configPlugin(values)`** — the baseline, deep-cloned at boot.
2. **`config.merge(overrides)`** — layered on top after boot (deployment or
   per-environment overrides); plain objects deep-merge, everything else
   replaces.
3. **`config.set(path, value)`** — a single key, last word.
4. **`config.get(path, fallback)`** — the read-site default, used *only* when
   the path is absent entirely. It never overrides a stored value, not even
   `null`.

Environment variables have no independent precedence: they enter at step 1,
where you put them.

## Options reference

`configPlugin(values?)` — registers `ConfigRepository` as a singleton under
`CONFIG`, plugin name `basalt:config`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `values` | `Record<string, unknown>` | `{}` | Initial settings tree. `structuredClone`d, so it must contain only cloneable data — no functions, class instances or symbols |

`ConfigRepository`:

| Method | Signature | Purpose |
| --- | --- | --- |
| `get` | `get<T>(path, fallback?): T` | Dot-path read. No key **and** no fallback → `ConfigKeyError` |
| `has` | `has(path): boolean` | Existence check that never throws — use it to branch on optional features |
| `set` | `set(path, value): void` | Writes one path, creating intermediate objects; refuses unsafe keys |
| `merge` | `merge(values): void` | Deep-merges plain objects on top of the current tree; silently drops unsafe keys |
| `all` | `all(): Readonly<Record<string, unknown>>` | The whole tree — for diagnostics and startup logs (redact secrets first) |

`defineEnv(shape, options?)` — returns a frozen `z.infer` of the shape:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `shape` | `z.ZodRawShape` | — | One Zod schema per variable. Use `z.coerce.*` — every value arrives as a string |
| `options.source` | `Record<string, string \| undefined>` | `process.env` | Read from somewhere else — tests, or a secrets manager you loaded yourself |

`secret(options?)` — returns `z.ZodType<string>`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `minLength` | `number` | `16` | Minimum length in **every** environment, `devDefault` included. Raise it for JWT signing keys (32+) |
| `devDefault` | `string` | — | Value used outside production when the variable is unset, so a fresh clone runs. Never applied when `NODE_ENV=production` |

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `ConfigKeyError` | `CONFIG_KEY_MISSING` | — | `get(path)` with one argument and the path absent |
| `ConfigUnsafeKeyError` | `CONFIG_UNSAFE_KEY` | — | `set()` on a path containing `__proto__`, `constructor` or `prototype` |
| `EnvValidationError` | `ENV_INVALID` | boot | One or more variables failed `defineEnv`; `error.report` lists every one |
| `ConfigValidationError` | `CONFIG_INVALID` | boot | A `createApp({ config })` slice failed that plugin's `configSchema` |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | — | `container.get(CONFIG)` without `configPlugin` in `plugins`, or a consumer that registered first |
| `DataCloneError` | — | boot | `configPlugin(values)` where `values` holds a function, class instance or symbol — `structuredClone` refuses it |

- **`CONFIG_KEY_MISSING` for a key that is definitely in my `.env`** — nothing
  maps environment variables onto config paths automatically. Read the variable
  through `defineEnv` and put it into the settings object yourself.
- **`get` returns `undefined` instead of throwing** — you passed `undefined` as
  an explicit second argument; the fallback is detected by arity. Drop the
  argument.
- **`ENV_INVALID` in production with the same `.env` that works locally** —
  `secret()` switches rules on `NODE_ENV=production`: `devDefault` stops
  applying and placeholder-looking values are rejected. Check what `NODE_ENV`
  actually is in that environment.
- **`merge` wiped my array** — only plain objects deep-merge; arrays and
  primitives are replaced wholesale.
- **`DI_UNKNOWN_TOKEN` from a plugin that reads `CONFIG`** — add
  `dependsOn: ['basalt:config']` so it registers after `configPlugin`.

## Where to next

- [Core Concepts](/guide/concepts) — the container, the `CONFIG` token and the
  plugin lifecycle that decides read order.
- [Getting Started](/guide/getting-started) — the generated `src/env.ts`, which
  is exactly this pattern.
- [Security](/guide/security) — secret rotation, headers and the production
  checklist.
- [Production](/guide/production) — deploying with environment-provided config.
