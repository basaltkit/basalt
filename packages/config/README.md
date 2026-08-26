<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/config

Central, namespace-organized configuration for Basalt applications, with dot-path reads (`config.get('mail.from')`). You need this when you want a single place to store and query your application's settings (addresses, ports, service options).

## What this module solves

Almost every application has settings: the sender for emails, the SMTP server port, the job queue driver, etc. Without a system, these settings end up scattered across constants, loose files, and objects passed hand to hand — and nobody knows where the "true" value lives.

`@basaltkit/config` gives you a single repository: `ConfigRepository`. You put an object with all the settings into it, organized by area (`mail`, `queue`, `app`, …), and then read any value with a simple dot-separated path, like `mail.smtp.port`. If you request a key that doesn't exist and don't provide a fallback value, the repository throws a clear error instead of silently returning `undefined` — you catch the problem early.

The package also includes `configPlugin`, which wires the repository into the Basalt application (from `@basaltkit/core`): the repository gets registered in the *container* (the "box" of shared services) and any plugin can fetch it via the `CONFIG` token.

## Installation

```bash
pnpm add @basaltkit/config
```

The package depends on `@basaltkit/core` (installed automatically as a dependency).

## Get started in 5 minutes

1. Define your configuration as a plain object.
2. Add `configPlugin` to the application.
3. Read values in any plugin via the `CONFIG` token.

```ts
import { createApp, definePlugin } from '@basaltkit/core'
import { CONFIG, configPlugin } from '@basaltkit/config'

// 1. The application's settings, organized by area:
const settings = {
  app: { name: 'my-app' },
  mail: { from: 'hi@basalt.dev', smtp: { port: 587 } },
}

// 2. A plugin that reads the configuration:
const mailPlugin = definePlugin({
  name: 'app:mail',
  dependsOn: ['basalt:config'], // ensures config registers first
  boot({ container }) {
    const config = container.get(CONFIG)
    console.log(config.get('mail.from'))            // 'hi@basalt.dev'
    console.log(config.get('mail.smtp.port'))       // 587
    console.log(config.get('mail.replyTo', 'n/a'))  // 'n/a' (fallback)
  },
})

// 3. Boot the application with the config plugin:
await createApp({
  plugins: [configPlugin(settings), mailPlugin],
}).boot()
```

Note: `configPlugin` makes a deep copy (`structuredClone`) of the object you pass it — later changes to the repository don't affect the original object, and vice versa.

## Usage guide

### Using `ConfigRepository` directly (without an application)

You can use the repository on its own, e.g. in scripts or tests:

```ts
import { ConfigRepository } from '@basaltkit/config'

const config = new ConfigRepository({
  mail: { from: 'hi@basalt.dev', smtp: { port: 587 } },
})

config.get('mail.from')          // 'hi@basalt.dev'
config.has('queue.driver')       // false
config.get('mail.replyTo', 'x')  // 'x' — fallback when the key is missing
config.get('mail.replyTo')       // throws ConfigKeyError (no fallback)
```

### Writing and merging values

`set` creates intermediate levels automatically; `merge` does a deep merge without erasing sibling keys:

```ts
import { ConfigRepository } from '@basaltkit/config'

const config = new ConfigRepository({
  mail: { from: 'hi@basalt.dev', smtp: { port: 587 } },
})

// set: creates 'queue' and then 'queue.driver'
config.set('queue.driver', 'bullmq')
config.get('queue.driver') // 'bullmq'

// merge: adds 'host' without erasing 'port'
config.merge({ mail: { smtp: { host: 'smtp.acme.com' } } })
config.get('mail.smtp.port') // 587 — still there
config.get('mail.smtp.host') // 'smtp.acme.com'

// all(): the full object (read-only by convention)
console.log(config.all())
```

Note: in `merge`, arrays and plain values are **replaced**, not merged — only plain objects are deep-merged.

### Typing your namespaces (Advanced)

Packages and applications can declare the shape of their namespace via *module augmentation* (a TypeScript technique for extending interfaces from another module):

```ts
declare module '@basaltkit/config' {
  interface BasaltConfig {
    mail: { from: string }
  }
}
```

This documents and types the `mail` namespace for anyone using the `BasaltConfig` interface.

## API reference

### `ConfigRepository`

`new ConfigRepository(values?)` — `values` is the initial object (default `{}`). The object is used as-is (no copy); if you want isolation, pass a copy or use `configPlugin`.

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `get<T>(path, fallback?)` | `path: string`, `fallback?: T` | `T` | Reads by dot path. Without the key **and** without a fallback, throws `ConfigKeyError`. The fallback counts even if it's `undefined` (you just need to pass the 2nd argument). |
| `has(path)` | `path: string` | `boolean` | `true` if the path exists. |
| `set(path, value)` | `path: string`, `value: unknown` | `void` | Writes, creating intermediate levels as needed. |
| `merge(values)` | `values: Record<string, unknown>` | `void` | Deep merge of plain objects on top of the current values. |
| `all()` | — | `Readonly<Record<string, unknown>>` | All values. |

### `configPlugin(values?)`

| Parameter | Type | Required? | Default | Description |
|---|---|---|---|---|
| `values` | `Record<string, unknown>` | No | `{}` | Initial values; cloned with `structuredClone`. |

Returns a Basalt plugin with `name: 'basalt:config'` that, during the `register` phase, registers a `ConfigRepository` as a *singleton* in the container under the `CONFIG` token.

### `CONFIG`

Dependency injection token (`Token<ConfigRepository>`) to obtain the repository: `container.get(CONFIG)`.

### `ConfigKeyError`

Error thrown by `get()` without a fallback. Extends core's `BasaltError`, with `code: 'CONFIG_KEY_MISSING'` and a message that includes the missing path.

### `BasaltConfig` (Advanced)

Empty interface, extensible via *module augmentation*, for typing namespaces (see above).

## Common issues and solutions (FAQ)

**"Missing configuration key: …" (`CONFIG_KEY_MISSING`)** — You requested a key that doesn't exist and didn't provide a fallback. Either set the value in the initial object, or pass a second argument: `config.get('mail.replyTo', 'default-value')`.

**`get` returns `undefined` instead of throwing an error** — You probably passed `undefined` explicitly as the fallback: `get(path, undefined)` counts as "has a fallback" (the check is based on the number of arguments). Call `get(path)` with just one argument to get the error.

**`merge` erased my array/value** — `merge` only deep-merges plain objects; arrays and primitives are replaced entirely. If you need to append to an array, read it with `get`, modify it, and write it back with `set`.

**I changed the config but the original object didn't change (or vice versa)** — With `configPlugin`, values are cloned at startup; this is expected behavior. Use `container.get(CONFIG)` as the single source of truth after startup.

**`container.get(CONFIG)` throws `DI_UNKNOWN_TOKEN`** — `configPlugin` wasn't added to the application, or your plugin ran before it. Add `configPlugin(...)` to `plugins` and declare `dependsOn: ['basalt:config']` on the consuming plugin.

## How it connects to other modules

- **`@basaltkit/core`** — the foundation: `configPlugin` is a core plugin, `CONFIG` is a core container token, and `ConfigKeyError` extends `BasaltError`. Note: this is different from core plugins' `configSchema` — `configSchema` validates **one plugin's** config slice at startup; `@basaltkit/config` is a read/write repository for **the whole** application.
- **`@basaltkit/env`** — typical combination: validate environment variables with `defineEnv` and use those values to build the object you pass to `configPlugin` (environment → configuration).
- **`@basaltkit/events`** — no direct link, but both follow the same pattern: a plugin that registers a singleton service in the container (`EVENTS` / `CONFIG`).
