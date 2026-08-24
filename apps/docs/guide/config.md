# Configuration

[`@basaltkit/config`](/reference/packages/config) gives your app **one** place for
settings — addresses, ports, driver options — read by a dot-path like
`config.get('mail.smtp.port')`. Ask for a key that doesn't exist and it throws a clear
error instead of silently returning `undefined`, so misconfiguration surfaces early.

## Register and read

Put your settings in one object, organized by area, and register `configPlugin`. Any
plugin fetches the repository via the `CONFIG` token:

```ts
import { createApp, definePlugin } from '@basaltkit/core'
import { CONFIG, configPlugin } from '@basaltkit/config'

const settings = {
  app: { name: 'my-app' },
  mail: { from: 'hi@basalt.dev', smtp: { port: 587 } },
}

const mailPlugin = definePlugin({
  name: 'app:mail',
  dependsOn: ['basalt:config'], // config registers first
  register({ container }) {
    const config = container.get(CONFIG)
    const from = config.get('mail.from')            // 'hi@basalt.dev'
    const port = config.get('mail.smtp.port', 25)   // 587 (or the fallback if missing)
  },
})

await createApp({ plugins: [configPlugin(settings), mailPlugin] }).boot()
```

## Reads that fail loud

```ts
config.get('mail.from')          // → 'hi@basalt.dev'
config.get('mail.replyTo', null) // → null  (explicit fallback, no throw)
config.get('mail.replyTo')       // → throws ConfigKeyError — the key is missing
config.has('queue.driver')       // → boolean, no throw
```

A missing key with **no** fallback throws `ConfigKeyError` — you catch the mistake at
boot, not as an `undefined` deep in a handler. Pair it with [`@basaltkit/env`](/guide/getting-started)
to load secrets/host-specific values from the environment and fold them into the
settings object.
