# @machize/env

Typed validation of environment variables with [Zod](https://zod.dev): the application fails immediately at startup, with a single report of **all** problems, instead of crashing later in the middle of a request. You need this in any application that reads `process.env` (which is to say, practically all of them).

## What this module solves

An **environment variable** is a value defined outside the code — in the terminal, in a `.env` file, or in the server's dashboard — that the application reads from `process.env`. It's the usual way to pass things like the database address (`DATABASE_URL`) or secret keys. The problem: `process.env` always returns text (or `undefined`), with no guarantees at all. If you forget to set a variable, the error only shows up much later, somewhere hard to make sense of.

`@machize/env` solves this with the `defineEnv` function: you declare the expected shape of each variable using a **schema** (a validatable description of the data's shape, written with the Zod library), and it validates everything the moment the module is loaded. If something is wrong, it throws an error with the full report — all missing or invalid variables at once, not one at a time. The returned object is typed (TypeScript knows `env.PORT` is a number) and frozen (nobody can change it by mistake).

It also includes the `secret()` helper, a special schema for secrets (API keys, JWT signing keys, …) with a *fail-closed* policy in production: in development it accepts a default value so you can get up and running right away, but in production it requires a real secret — rejecting values that are missing, too short, or that look like a "placeholder" (`change-me`, `secret`, `password`, …).

## Installation

```bash
pnpm add @machize/env zod
```

`zod` is a *peer dependency* (you have to install it yourself; both `^3.24.0` and `^4.0.0` are supported). `@machize/core` comes along automatically as a dependency.

## Get started in 5 minutes

1. Create a `src/env.ts` file in your project.
2. Declare the variables your application needs.
3. Import `env` anywhere, with types guaranteed.

```ts
// src/env.ts
import { defineEnv, secret } from '@machize/env'
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
import { defineEnv, EnvValidationError } from '@machize/env'
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
import { defineEnv } from '@machize/env'
import { z } from 'zod'

const env = defineEnv(
  { DATABASE_URL: z.string().url() },
  { source: { DATABASE_URL: 'postgres://localhost:5432/app' } },
)
```

### Secrets with `secret()`

`secret()` returns a Zod `string` schema with three protections (the dev/production decision is made by reading `process.env.NODE_ENV` at validation time):

1. **Required in production** — `devDefault` never applies when `NODE_ENV=production`.
2. **Rejects placeholders in production** — values like `change-me`, `changeme`, `placeholder`, `example`, `secret`, `password`, `default`, `test`, `xxxx…`, `0000…` are rejected (in development they're accepted, for convenience).
3. **Minimum length in any environment** — 16 characters by default.

```ts
import { defineEnv, secret } from '@machize/env'

export const env = defineEnv({
  // boots right away in dev; requires a real value in production:
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
  // no devDefault: required in every environment; minimum 32 characters:
  JWT_SIGNING_KEY: secret({ minLength: 32 }),
})
```

The practical result: a fresh project runs "out of the box" in development and **refuses to boot** in production until you set real secrets.

### Connecting to the rest of a Machize application

Recommended pattern: validate the environment first and use it to build the application's configuration.

```ts
import { createApp } from '@machize/core'
import { configPlugin } from '@machize/config'
import { defineEnv, secret } from '@machize/env'
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

### `secret(options?)`

Returns `z.ZodType<string>` — a Zod schema for secret variables, *fail-closed* in production (see rules above).

| Option (`SecretOptions`) | Type | Required? | Default | Description |
|---|---|---|---|---|
| `minLength` | `number` | no | `16` | Minimum length, in all environments. |
| `devDefault` | `string` | no | — | Value used outside production when the variable isn't set. Never applies in production. |

Note: `devDefault` also has to satisfy `minLength` — validation runs over it too.

### `EnvValidationError`

Error thrown by `defineEnv`. Extends `MachizeError` from `@machize/core`.

| Property | Type | Description |
|---|---|---|
| `code` | `string` | Always `'ENV_INVALID'`. |
| `report` | `string[]` | One line per problem, in the format `VARIABLE_NAME: message`. |
| `message` | `string` | The full formatted report, ready to print. |

## Common errors and solutions (FAQ)

**"Invalid environment variables" on startup** — Read the report's lines: each one names the variable and the problem. Set the missing variables in your `.env` file (or in the server's environment) and start again. Note: `@machize/env` doesn't read `.env` files on its own — use `node --env-file=.env` (Node 20+) or a tool like `dotenv` before the `env.ts` module is imported.

**"is required in production" for a variable with `devDefault`** — This is the intended behavior: with `NODE_ENV=production`, `devDefault` is ignored. Set the real value in the production environment.

**"looks like a placeholder — set a strong, unique secret in production"** — The secret's value contains a forbidden word (`secret`, `password`, `change-me`, …). Generate a real random value, for example: `openssl rand -hex 32`.

**"must be at least 16 characters"** — The secret is too short. Use a longer value, or, if you really have a reason to, lower the limit with `secret({ minLength: 8 })` (not recommended).

**`env.PORT` comes back as text instead of a number** — Use `z.coerce.number()` instead of `z.number()`: environment variables are always text, and `coerce` handles the conversion.

**I want to change `env.X` at runtime but it errors** — The returned object is frozen with `Object.freeze` on purpose: the environment is read-only. If you need mutable values, use `ConfigRepository` from `@machize/config`.

**Validation passed in dev but failed in production with the same `.env`** — `secret()` switches to production rules when `NODE_ENV=production`. Confirm what `NODE_ENV` is in each environment.

## How it connects to other modules

- **`@machize/core`** — `EnvValidationError` extends `MachizeError` (with the stable `code` `ENV_INVALID`, like every other error in the ecosystem). `defineEnv` normally runs **before** `createApp`, so the application doesn't even attempt to boot with an invalid environment.
- **`@machize/config`** — a natural pair: `defineEnv` validates the outside world (environment variables), and `configPlugin` distributes those values, already organized into namespaces, to every plugin through the container.
- **`@machize/events`** — no direct link; use `env` to configure, for example, the `dispatch` destination of the outbox (webhook URLs, API keys).
