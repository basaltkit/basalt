<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/env

Typed validation of environment variables with [Zod](https://zod.dev): the application fails immediately at startup, with a single report of **all** problems, instead of crashing later in the middle of a request. You need this in any application that reads `process.env` (which is to say, practically all of them).

## What this module solves

An **environment variable** is a value defined outside the code — in the terminal, in a `.env` file, or in the server's dashboard — that the application reads from `process.env`. It's the usual way to pass things like the database address (`DATABASE_URL`) or secret keys. The problem: `process.env` always returns text (or `undefined`), with no guarantees at all. If you forget to set a variable, the error only shows up much later, somewhere hard to make sense of.

`@basaltkit/env` solves this with the `defineEnv` function: you declare the expected shape of each variable using a **schema** (a validatable description of the data's shape, written with the Zod library), and it validates everything the moment the module is loaded. If something is wrong, it throws an error with the full report — all missing or invalid variables at once, not one at a time. The returned object is typed (TypeScript knows `env.PORT` is a number) and frozen (nobody can change it by mistake).

It also includes the `secret()` helper, a special schema for secrets (API keys, JWT signing keys, …) with a *fail-closed* policy: with `NODE_ENV=development` (or `test`) it accepts a default value so you can get up and running right away, but everywhere else — including when `NODE_ENV` is unset — it requires a real secret — rejecting values that are missing, too short, or that look like a "placeholder" (`change-me`, `secret`, `password`, …).

## Installation

```bash
pnpm add @basaltkit/env zod
```

`zod` is a *peer dependency* (you have to install it yourself; Zod 4, `^4.0.0`, is required). `@basaltkit/core` comes along automatically as a dependency.

## Get started in 5 minutes

1. Create a `src/env.ts` file in your project.
2. Declare the variables your application needs.
3. Import `env` anywhere, with types guaranteed.

```ts
// src/env.ts
import { defineEnv, secret } from '@basaltkit/env'
import { z } from 'zod'

export const env = defineEnv({
  // required text in URL format:
  DATABASE_URL: z.string().url(),
  // text coerced to a number, with a default value:
  PORT: z.coerce.number().default(3000),
  // secret: uses devDefault in dev; requires a real value in production
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})
```

```ts
// src/server.ts
import { env } from './env.js'

console.log(env.DATABASE_URL) // string — guaranteed
console.log(env.PORT)         // number — already coerced (e.g. 3000)
```

If you start the app without `DATABASE_URL`, you'll immediately see something like:

```
EnvValidationError: Invalid environment variables:
  - DATABASE_URL: Required
```

Step by step, what happens: (1) `defineEnv` reads `process.env`; (2) it validates each variable against its schema; (3) if there are errors, it collects them all into an `EnvValidationError`; (4) if everything's fine, it returns a typed, frozen object (`Object.freeze`).

## Usage guide

### Validating with all errors at once

Unlike validating one variable at a time, the report brings everything together — you fix your `.env` in a single pass:

```ts
import { defineEnv, EnvValidationError } from '@basaltkit/env'
import { z } from 'zod'

try {
  defineEnv({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    PORT: z.coerce.number(),
  })
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(error.code)   // 'ENV_INVALID'
    console.error(error.report) // ['DATABASE_URL: Required', 'REDIS_URL: Required', 'PORT: ...']
  }
}
```

### Alternative source (tests)

By default, `defineEnv` reads `process.env`. In tests, pass your own source:

```ts
import { defineEnv } from '@basaltkit/env'
import { z } from 'zod'

const env = defineEnv(
  { DATABASE_URL: z.string().url() },
  { source: { DATABASE_URL: 'postgres://localhost:5432/app' } },
)
```

### App-specific prefix (`prefix`)

Generic names like `DATABASE_URL` or `PORT` are exported by *every* project. A shell that still has another project's `DATABASE_URL` exported is a silent trap: `node --env-file=.env` **never overrides a variable that is already set**, so your app boots against the wrong database and only finds out on the first request.

`prefix` makes the names app-specific without changing a single line of the rest of the code:

```ts
export const env = defineEnv(
  {
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().default(3000),
  },
  { prefix: 'MY_SAAS' },
)

env.DATABASE_URL // read from MY_SAAS_DATABASE_URL, falling back to DATABASE_URL
env.PORT         // read from MY_SAAS_PORT, falling back to PORT
```

Rules, all of them deliberate:

1. **Prefixed first, bare as a fallback.** `MY_SAAS_PORT` wins whenever it is *set* — an empty `MY_SAAS_PORT=` counts as set, exactly like `process.env` does. Only when it is absent does the bare `PORT` apply. The fallback exists so an already-running deployment that exports the generic names keeps booting after you add the prefix.
2. **The keys never change.** The shape's keys are what you declared, so the object is still `env.PORT` — never `env.MY_SAAS_PORT`.
3. **`NODE_ENV` is never prefixed.** It is a Node-wide convention read by the whole toolchain (and by `secret()` inside this package), so `MY_SAAS_NODE_ENV` is ignored.
4. **The error report names what was actually looked for.** A missing variable names *both* keys, an invalid one names the key the value came from:

```
EnvValidationError: Invalid environment variables:
  - MY_SAAS_DATABASE_URL (or DATABASE_URL): Required
  - MY_SAAS_PORT: Invalid input: expected number, received NaN
```

To require the prefixed names and ignore the bare ones entirely — the strictest setting, and the one that makes a stray `DATABASE_URL` in your shell impossible to pick up — turn the fallback off:

```ts
defineEnv(shape, { prefix: { value: 'MY_SAAS', fallback: false } })
```

The report then names only `MY_SAAS_DATABASE_URL`, because that is the only key the app reads.

The prefix must itself be a valid environment variable name: uppercase letters, digits and single inner underscores, starting with a letter and not ending in an underscore (`MY_SAAS`, `APP`, `A1_B2`). Anything else throws `EnvPrefixError` (`ENV_PREFIX_INVALID`) at boot, instead of quietly looking up a variable nobody can set.

> `create-basalt` wires this for you: a new app gets `prefix: '<PROJECT_NAME>'` in `src/env.ts` and prefixed names in `.env.example`.

### Secrets with `secret()`

`secret()` returns a Zod `string` schema with three protections (the dev/production decision is made by reading `process.env.NODE_ENV` at validation time):

1. **Required unless `NODE_ENV` is explicitly `development` or `test`** — `devDefault` only applies there. An **unset** `NODE_ENV` (or `staging`, a typo, …) counts as production, so a deploy that forgets `NODE_ENV` can never boot on the public dev default.
2. **Rejects placeholders outside development/test** — values like `change-me`, `changeme`, `placeholder`, `example`, `secret`, `password`, `default`, `test`, `xxxx…`, `0000…` are rejected (with `NODE_ENV=development`/`test` they're accepted, for convenience).
3. **Minimum length in any environment** — 16 characters by default.

```ts
import { defineEnv, secret } from '@basaltkit/env'

export const env = defineEnv({
  // boots right away in dev; requires a real value in production:
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
  // no devDefault: required in every environment; minimum 32 characters:
  JWT_SIGNING_KEY: secret({ minLength: 32 }),
})
```

The practical result: a fresh project runs "out of the box" with `NODE_ENV=development` and **refuses to boot** anywhere else (including when `NODE_ENV` is unset) until you set real secrets.

### Connecting to the rest of a Basalt application

Recommended pattern: validate the environment first and use it to build the application's configuration.

```ts
import { createApp } from '@basaltkit/core'
import { configPlugin } from '@basaltkit/config'
import { defineEnv, secret } from '@basaltkit/env'
import { z } from 'zod'

const env = defineEnv({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})

await createApp({
  plugins: [
    configPlugin({
      app: { port: env.PORT, secret: env.APP_SECRET },
      db: { url: env.DATABASE_URL },
    }),
  ],
}).boot()
```

## API reference

### `defineEnv(shape, options?)`

Validates and types the environment variables. Returns `z.infer<z.ZodObject<TShape>>` — a **frozen** object with the validated, coerced values. Throws `EnvValidationError` if any variable fails.

| Parameter | Type | Required? | Default | Description |
|---|---|---|---|---|
| `shape` | `z.ZodRawShape` (an object `{ NAME: zodSchema }`) | yes | — | One Zod schema per variable. |
| `options.source` | `Record<string, string \| undefined>` | no | `process.env` | Source of the values (useful in tests). |
| `options.prefix` | `string \| { value: string; fallback?: boolean }` | no | — | Read each variable as `<PREFIX>_<NAME>` first. A bare string means `{ value, fallback: true }`. `NODE_ENV` is never prefixed; the returned keys stay bare. |

#### `EnvPrefix`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `value` | `string` | yes | — | The prefix, e.g. `'MY_SAAS'`. Uppercase letters, digits and single inner underscores; must start with a letter and not end in `_`. |
| `fallback` | `boolean` | no | `true` | Also accept the bare `<NAME>` when `<PREFIX>_<NAME>` is unset. `false` requires the prefixed names. |

### `secret(options?)`

Returns `z.ZodType<string>` — a Zod schema for secret variables, *fail-closed* in production (see rules above).

| Option (`SecretOptions`) | Type | Required? | Default | Description |
|---|---|---|---|---|
| `minLength` | `number` | no | `16` | Minimum length, in all environments. |
| `devDefault` | `string` | no | — | Value used outside production when the variable isn't set. Never applies in production. |

Note: `devDefault` also has to satisfy `minLength` — validation runs over it too.

### `EnvValidationError`

Error thrown by `defineEnv`. Extends `BasaltError` from `@basaltkit/core`.

| Property | Type | Description |
|---|---|---|
| `code` | `string` | Always `'ENV_INVALID'`. |
| `report` | `string[]` | One line per problem, in the format `VARIABLE_NAME: message`. With a `prefix`, the name is the key actually read — `MY_SAAS_PORT`, or `MY_SAAS_PORT (or PORT)` when neither is set. |
| `message` | `string` | The full formatted report, ready to print. |

### `EnvPrefixError`

Thrown by `defineEnv` when `options.prefix` is not a valid environment variable name (see the table above). Extends `BasaltError`.

| Property | Type | Description |
|---|---|---|
| `code` | `string` | Always `'ENV_PREFIX_INVALID'`. |
| `prefix` | `string` | The rejected prefix. |

## Common errors and solutions (FAQ)

**"Invalid environment variables" on startup** — Read the report's lines: each one names the variable and the problem. Set the missing variables in your `.env` file (or in the server's environment) and start again. Note: `@basaltkit/env` doesn't read `.env` files on its own — use `node --env-file=.env` (Node 20+) or a tool like `dotenv` before the `env.ts` module is imported.

**The app booted against another project's database / port, and `.env` was ignored** — `--env-file` (and `dotenv`) **never override a variable that is already exported** in the shell. Check with `env | grep DATABASE_URL`. The fix is `prefix`: give the variables app-specific names (`MY_SAAS_DATABASE_URL`) so nothing else in the shell can collide with them — see [App-specific prefix](#app-specific-prefix-prefix). `env -u DATABASE_URL pnpm dev` unsets one variable for a single run, but it is a workaround, not a fix.

**"MY_SAAS_DATABASE_URL (or DATABASE_URL): Required"** — with a `prefix`, a missing variable names both keys the app looked for. Set either one (the prefixed name is the one to prefer). With `fallback: false` only the prefixed name is read, and only it is named.

**"is required in production" for a variable with `devDefault`** — This is the intended behavior: with `NODE_ENV=production`, `devDefault` is ignored. Set the real value in the production environment.

**"looks like a placeholder — set a strong, unique secret in production"** — The secret's value contains a forbidden word (`secret`, `password`, `change-me`, …). Generate a real random value, for example: `openssl rand -hex 32`.

**"must be at least 16 characters"** — The secret is too short. Use a longer value, or, if you really have a reason to, lower the limit with `secret({ minLength: 8 })` (not recommended).

**`env.PORT` comes back as text instead of a number** — Use `z.coerce.number()` instead of `z.number()`: environment variables are always text, and `coerce` handles the conversion.

**I want to change `env.X` at runtime but it errors** — The returned object is frozen with `Object.freeze` on purpose: the environment is read-only. If you need mutable values, use `ConfigRepository` from `@basaltkit/config`.

**Validation passed in dev but failed in production with the same `.env`** — `secret()` switches to production rules when `NODE_ENV=production`. Confirm what `NODE_ENV` is in each environment.

## How it connects to other modules

- **`@basaltkit/core`** — `EnvValidationError` extends `BasaltError` (with the stable `code` `ENV_INVALID`, like every other error in the ecosystem). `defineEnv` normally runs **before** `createApp`, so the application doesn't even attempt to boot with an invalid environment.
- **`@basaltkit/config`** — a natural pair: `defineEnv` validates the outside world (environment variables), and `configPlugin` distributes those values, already organized into namespaces, to every plugin through the container.
- **`@basaltkit/events`** — no direct link; use `env` to configure, for example, the `dispatch` destination of the outbox (webhook URLs, API keys).
