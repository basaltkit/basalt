<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/logger

Structured logging for Basalt applications, built on top of [pino](https://getpino.io): every log line is emitted as JSON, automatically enriched with the request context (`requestId`, `tenantId`, `userId`), with sensitive data (passwords, tokens) redacted by default.

You need this module as soon as you want to understand what your application is doing — in development, and especially in production.

---

## What this module solves

A **log** is the application's diary: every relevant event ("user logged in", "payment failed") is written as a line. With `console.log`, those lines are loose text, hard to search. **Structured logging** writes each line as JSON — a format with fields (`{"level":30,"msg":"login ok","userId":"u-9"}`) that tools like Datadog, Loki, or CloudWatch can filter and aggregate.

The next problem is **correlation**: when ten requests run at the same time, how do you know which lines belong to which request? This module reads the application's active context (the `@basaltkit/core` "request context", stored in AsyncLocalStorage) and **automatically** adds `requestId`, `correlationId`, `traceId`, `userId`, and `tenantId` to every line — without you passing anything in your log calls. If the context has `tenant`/`user` objects with an `id`, they become `tenantId`/`userId`.

Finally, **security**: it's far too easy to accidentally dump a password or token into the logs. By default, fields like `password`, `token`, `secret`, and `authorization` (at any nesting depth: `*.password`, etc.) are replaced with `[REDACTED]`.

## Installation

```bash
pnpm add @basaltkit/logger
```

Depends on `@basaltkit/core` and `pino`. For readable output in development (`pretty: true`), also install `pino-pretty`:

```bash
pnpm add -D pino-pretty
```

## Get started in 5 minutes

**1. Register the plugin:**

```ts
import { createApp } from '@basaltkit/core'
import { LOGGER, loggerPlugin } from '@basaltkit/logger'

const app = await createApp({
  plugins: [loggerPlugin({ level: 'info' })],
}).boot()
```

**2. Get the logger from the container and use it:**

```ts
const logger = app.container.get(LOGGER)

logger.info('application started')
logger.info({ port: 3000 }, 'server listening')      // extra fields + message
logger.warn({ quota: 0.9 }, 'quota almost exhausted')
logger.error({ err: new Error('boom') }, 'failed')
```

Output (JSON, one line per call):

```json
{"level":30,"time":1754500000000,"msg":"server listening","port":3000}
```

**3. Inside a request with context, the fields appear on their own:**

```ts
import { runWithContext } from '@basaltkit/core'

runWithContext({ requestId: 'req-1', tenant: { id: 't-acme' }, user: { id: 'u-9' } }, () => {
  logger.info('inside the request')
  // → {"msg":"inside the request","requestId":"req-1","tenantId":"t-acme","userId":"u-9",...}
})
```

(In a real application, it's the HTTP middleware that does the `runWithContext` for you.)

## Usage guide

### Creating a logger without the plugin

`createLogger` returns a plain pino logger — use it in scripts, tests, or outside the container:

```ts
import { createLogger } from '@basaltkit/logger'

const logger = createLogger({ level: 'debug', base: { service: 'api' } })
logger.debug('starting')
```

### Log levels

Pino's levels, from chattiest to most severe: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. The `level` option sets the minimum emitted — with `level: 'warn'`, `info` and `debug` calls are dropped:

```ts
import { createLogger } from '@basaltkit/logger'

const logger = createLogger({ level: 'warn' })
logger.info('does not appear')
logger.warn('appears')
```

### Readable output in development

```ts
import { createLogger } from '@basaltkit/logger'

const logger = createLogger({ pretty: true }) // requires pino-pretty to be installed
```

In production, leave `pretty` off — JSON is the format aggregators expect.

### Redacting sensitive data

By default, these are redacted: `password`, `*.password`, `token`, `*.token`, `secret`, `*.secret`, `authorization`, `*.authorization`, `headers.authorization`. You can add more paths:

```ts
import { createLogger } from '@basaltkit/logger'

const logger = createLogger({ redact: ['creditCard', '*.creditCard'] })
logger.info({ email: 'a@b.c', password: '123', auth: { token: 'jwt' } }, 'login')
// → {"msg":"login","email":"a@b.c","password":"[REDACTED]","auth":{"token":"[REDACTED]"}}
```

Note: the extra paths are **added to** the defaults, not replacing them.

### Child loggers (per-module sub-loggers)

A *child logger* inherits the configuration and adds fixed fields — useful for identifying the module:

```ts
const subscriptionsLogger = logger.child({ pkg: 'subscriptions' })
subscriptionsLogger.warn('low quota')
// → {"msg":"low quota","pkg":"subscriptions", ...active context...}
```

Context enrichment still works on child loggers.

### Capturing output in tests

The `destination` option accepts any stream with `write(msg)` — in tests, capture the lines and assert on them:

```ts
import { createLogger } from '@basaltkit/logger'

const lines: Record<string, unknown>[] = []
const logger = createLogger({
  destination: { write: (msg: string) => void lines.push(JSON.parse(msg)) },
})

logger.info({ pkg: 'core' }, 'boot ok')
// lines[0] → { msg: 'boot ok', pkg: 'core', ... }
```

## API reference

### `createLogger(options?: LoggerOptions): Logger`

Creates a pino logger with automatic context enrichment and redaction. `Logger` is an alias for the pino logger (`PinoLogger<string, boolean>`) — you get the full pino API: `info/warn/error/debug/trace/fatal`, `child()`, `flush()`, etc.

`LoggerOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `level` | `string` | No | `'info'` | Minimum level emitted (`trace`…`fatal`). |
| `pretty` | `boolean` | No | `false` (JSON) | Colorized, readable output for dev — requires `pino-pretty` to be installed. |
| `redact` | `string[]` | No | `[]` | **Extra** redaction paths, added to the defaults. Redactor: `[REDACTED]`. |
| `base` | `Record<string, unknown>` | No | `{}` | Fixed fields on every line (e.g. `{ service: 'api' }`). Note: the default `{}` removes the `pid`/`hostname` fields that pino normally includes. |
| `destination` | `DestinationStream` | No | stdout | Destination stream — used in tests to capture output. |

Context fields automatically promoted onto every line (when there's an active context): `requestId`, `correlationId`, `traceId`, `userId`, `tenantId`; plus `tenant.id` → `tenantId`, `user.id` → `userId` (without overwriting values already present in the context).

### `loggerPlugin(options?: LoggerOptions)`

Basalt plugin: registers `createLogger(options)` as a singleton on the `LOGGER` token; on `shutdown`, calls `logger.flush()` to drain buffers. Accepts exactly the same options as `createLogger`.

```ts
import { LOGGER, loggerPlugin } from '@basaltkit/logger'
// register:  plugins: [loggerPlugin({ level: 'info' })]
// retrieve:  const logger = app.container.get(LOGGER)
```

### Exports

| Export | Type | Description |
|---|---|---|
| `createLogger` | function | Creates a logger. |
| `loggerPlugin` | function | Plugin for `createApp`. |
| `LOGGER` | `Token<Logger>` | Injection token for the logger in the container. |
| `Logger` | type | Alias for the pino logger. |
| `LoggerOptions` | type | Options (table above). |

## Common errors and solutions (FAQ)

**I enabled `pretty: true` and it crashed with "unable to determine transport target for pino-pretty".**
`pino-pretty` isn't installed. Run `pnpm add -D pino-pretty`, or remove `pretty` (production should use JSON).

**Lines don't have `requestId`/`tenantId`.**
Those fields only exist when there's an **active context** — code running inside `runWithContext(...)` (normally handled by the HTTP middleware). Outside a request, it's expected that they won't appear.

**My `logger.info(...)` doesn't print anything.**
The level is set above the call (e.g. `level: 'warn'` drops `info`). Lower the `level`, or raise the severity of the call.

**I see `[REDACTED]` on a field that isn't sensitive.**
The field name matches a default path (e.g. any top-level `token` or `*.token`). Rename the field (e.g. `inviteTokenId`) — the defaults can't be removed via options, only added to.

**What's the difference between `logger.info('msg')` and `logger.info({ a: 1 }, 'msg')`?**
Pino convention: the **first** argument can be an object of extra fields; the message comes after. `logger.info('msg', { a: 1 })` is wrong — the object would be interpolated into the message.

**I lost logs at the end of the process.**
Shut down the application with `app.shutdown()` — the plugin calls `flush()` on shutdown.

## How it connects to other modules

- **`@basaltkit/core`** — the source of the context (AsyncLocalStorage via `runWithContext`/`tryCtx`) that enriches every line; `loggerPlugin` uses `definePlugin`/`createToken` from core.
- **`@basaltkit/queue`** — the queue propagates the request context to workers; logs written inside a job's `handle` come out with the `requestId`/`tenantId` of the request that dispatched it — end-to-end correlation.
- **`@basaltkit/scheduler`** — uses the logger inside scheduled tasks and `onFailure` handlers to trace periodic runs.
- **`@basaltkit/audit` / `@basaltkit/activity`** — different roles: the logger is technical diagnostics (ephemeral, for operators); audit and activity are business records (persistent, for compliance and for the end user). Use all three together.
