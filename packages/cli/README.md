# @basaltkit/cli

Terminal command framework (the `basalt` command) for Basalt applications: define your own commands, run them against the already-booted application, and inspect HTTP routes and scheduled tasks. You need it when you want to give your application its own "command line" — for example `basalt routes` or `basalt db:seed`.

## What this module solves

A **CLI** (Command Line Interface) is a way to interact with a program by typing commands into a terminal, instead of clicking buttons. Almost every server application needs administrative tasks that don't make sense as web pages: listing registered routes, running migrations, seeding the database, and so on.

The problem is that these tasks usually need the application "alive": with the database connected, plugins registered, and configuration loaded. Writing a standalone script for each task forces you to repeat all that bootstrapping manually.

`@basaltkit/cli` solves this: you describe each command with `defineCommand`, register the commands with the `commandsPlugin` plugin, and `runCli` handles the rest — boots the application, parses the terminal arguments, runs the right command, and shuts everything down at the end. It also ships with two built-in commands (`routes` and `schedule:list`) and utilities for testing commands without printing anything to the screen.

## Installation

```bash
pnpm add @basaltkit/cli
```

> Note: the package depends on `@basaltkit/core` (the heart of the framework, where `createApp` and the dependency container live). If you created the project with `create-basalt --cli`, both are already installed.

## Get started in 5 minutes

1. Create a `bin/basalt.ts` file at the root of the project — this will be the entry point for the `basalt` command:

```typescript
#!/usr/bin/env node
import { runCli } from '@basaltkit/cli'
import { buildApp } from '../src/app.js'

const app = buildApp({ logLevel: 'silent' })
process.exit(await runCli({ app }))
```

2. Define one of your own commands, for example in `src/commands/greet.ts`:

```typescript
import { defineCommand } from '@basaltkit/cli'

export const greetCommand = defineCommand({
  name: 'greet',
  description: 'Greets someone',
  handle({ args, io }) {
    io.log(`Hello, ${args[0] ?? 'world'}!`)
  },
})
```

3. Register the command in the application (in `src/app.ts`), inside the plugin list:

```typescript
import { createApp } from '@basaltkit/core'
import { commandsPlugin } from '@basaltkit/cli'
import { greetCommand } from './commands/greet.js'

export function buildApp() {
  return createApp({
    plugins: [commandsPlugin([greetCommand])],
  })
}
```

4. Add a shortcut in `package.json`:

```json
{
  "scripts": {
    "basalt": "tsx bin/basalt.ts"
  }
}
```

5. Run it in the terminal:

```bash
pnpm basalt list          # lists all available commands
pnpm basalt greet Maria   # prints: Hello, Maria!
```

## Usage guide

### Built-in commands

Without registering anything, `runCli` always provides:

| Command | What it does |
| --- | --- |
| `basalt list` (or `basalt` with no arguments) | Lists all available commands, with their descriptions |
| `basalt routes` | Lists the HTTP routes registered by the application (read from the `http:routes` metadata bucket, populated by HTTP adapters such as `@basaltkit/fastify`) |
| `basalt schedule:list` | Lists scheduled tasks and their cron expressions (read from the `schedule:entries` bucket, populated by `@basaltkit/scheduler`) |
| `basalt dev [--entry] [--worker] [--queue] [--no-routes]` | Runs the app with watch + restart, **prints the route table on boot**, and with `--worker` also starts a watched `queue:work` alongside it (server + worker in one command). Delegates watching to `tsx watch` / `node --watch`. |
| `basalt upgrade [--dry] [--only=<id>]` | Applies framework upgrade codemods (ships the `@machize/*` → `@basaltkit/*` scope rename; `--dry` previews) |
| `basalt publish [<id>] [--force]` | Copies a bundled stub group into the app — `dockerfile`, `ci`, `editorconfig` (run with no id to list) |

If you also install `@basaltkit/generator`, you gain the `make:*` commands. Feature
plugins register their own: `queue:work|stats|retry` (`@basaltkit/queue`),
`tenant:list|create|migrate|seed|run` (`@basaltkit/tenancy`), `generate:docs`
(`@basaltkit/http`), and `mail:preview` (`@basaltkit/mailer`).

### Defining a command with arguments and flags

**Positional arguments** are the loose words after the command name; **flags** are options in the format `--name` or `--name=value`. The parser is simple and predictable:

- `--fresh` → `flags.fresh === true` (boolean)
- `--step=2` → `flags.step === '2'` (string — convert it to a number yourself if you need to)

```typescript
import { defineCommand } from '@basaltkit/cli'

export const migrateCommand = defineCommand({
  name: 'tenant:migrate',
  description: 'Migrates a tenant database',
  async handle({ args, flags, container, io }) {
    const tenantId = args[0]
    if (!tenantId) {
      io.error('Usage: basalt tenant:migrate <tenantId> [--fresh] [--step=N]')
      return 1 // exit code ≠ 0 signals an error to the terminal
    }
    const fresh = flags['fresh'] === true
    const step = typeof flags['step'] === 'string' ? Number(flags['step']) : undefined

    io.log(`Migrating ${tenantId} (fresh=${fresh}, step=${step ?? 'all'})…`)
    // use container.get(TOKEN) to get application services
    return 0
  },
})
```

Naming convention: `noun:verb`, for example `tenant:migrate`, `db:seed`.

### Testing commands without printing to the screen

`memoryIo()` captures everything the command would print, so you can assert on it in tests (a real example from the package's test suite):

```typescript
import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { commandsPlugin, defineCommand, memoryIo, runCli } from '@basaltkit/cli'

it('runs the greet command', async () => {
  const io = memoryIo()
  const app = createApp({
    plugins: [
      commandsPlugin([
        defineCommand({
          name: 'greet',
          handle: ({ args, io }) => io.log(`Hello, ${args[0]}!`),
        }),
      ]),
    ],
  })

  const code = await runCli({ app, argv: ['greet', 'world', '--loud'], io })
  expect(code).toBe(0)
  expect(io.lines).toEqual(['Hello, world!'])
})
```

## API reference

Everything the package exports from `@basaltkit/cli`:

### `defineCommand(command)`

A typed identity function — returns the definition as-is, it just ensures the object has the right shape.

`CommandDefinition`:

| Field | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | `string` | Yes | — | Command name; convention `noun:verb` |
| `description` | `string` | No | — | Description shown in `basalt list` |
| `handle` | `(context) => void \| number \| Promise<void \| number>` | Yes | — | The function that runs; returns the exit code (omit = 0) |

`CommandContext` (the object received by `handle`):

| Field | Type | Description |
| --- | --- | --- |
| `app` | `BasaltApp` | The application (already booted) |
| `container` | `Container` | The dependency container — use `container.get(TOKEN)` to get services |
| `io` | `CommandIo` | Write surface (`log`, `error`, `table`) |
| `args` | `string[]` | Positional arguments after the command name |
| `flags` | `Record<string, string \| boolean>` | Flags: `--key=value` → string, `--flag` → `true` |

### `runCli(options): Promise<number>`

Boots the application (if it's still in the `created` phase), resolves the command (built-in + registered in the `commands` metadata bucket), runs it, and shuts down the application at the end (`app.shutdown()`, even on error). Returns the exit code instead of calling `process.exit` — the caller decides what to do with it.

`RunCliOptions`:

| Field | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `app` | `BasaltApp` | Yes | — | The application created with `createApp` |
| `argv` | `string[]` | No | `process.argv.slice(2)` | Arguments to parse |
| `io` | `CommandIo` | No | `consoleIo()` | Write surface — swap for `memoryIo()` in tests |

Behavior: no command (or `list`) shows the command table and returns `0`; an unknown command prints an error and returns `1`; otherwise it returns the command's own code (`?? 0`).

### `commandsPlugin(commands: CommandDefinition[])`

A Basalt plugin that registers the commands in the `'commands'` metadata bucket, where `runCli` fetches them from. Pass it in the `plugins` list of `createApp`.

### `parseArgv(argv: string[]): ParsedArgv`

A minimal argument parser: the first "loose" word is the command; `--key=value` and `--flag` become flags. Returns `{ command: string | undefined, args: string[], flags: Record<string, string | boolean> }`.

### `consoleIo(): CommandIo`

A `CommandIo` implementation that writes to the console (`console.log` / `console.error`; `table` renders via `renderTable`). It's the default for `runCli`.

### `memoryIo(): CommandIo & { lines: string[]; errors: string[] }`

An in-memory implementation for tests: accumulates messages in `lines` and `errors` instead of printing them.

### `renderTable(rows: Record<string, unknown>[]): string`

Renders the rows as an aligned text table, with no external dependencies. Returns `'(empty)'` for an empty list. `undefined`/`null` cells are left blank.

### `builtinCommands(): CommandDefinition[]`

Returns `[routesCommand, scheduleListCommand, devCommand, upgradeCommand, publishCommand]`. *(Advanced — `runCli` already includes them automatically.)*

### `routesCommand` / `scheduleListCommand`

The definitions of the built-in `routes` and `schedule:list` commands. *(Advanced — useful only if you want to run them directly or compose your own list.)*

### Exported types

| Type | Description |
| --- | --- |
| `CommandDefinition`, `CommandContext`, `CommandIo` | Described above |
| `RunCliOptions`, `ParsedArgv` | Described above |
| `RouteMetadata` | `{ method: string; url: string; [key: string]: unknown }` — entries from the `http:routes` bucket |
| `ScheduleMetadata` | `{ name: string; cron: string; timezone: string }` — entries from the `schedule:entries` bucket |

## Common errors and solutions (FAQ)

**`Unknown command "x". Run "basalt list" to see what is available.`**
The command isn't registered. Confirm you passed it inside `commandsPlugin([...])` and that plugin is in the `plugins` list of `createApp`. Run `basalt list` to see what's available.

**My command runs but the `--step 2` flag doesn't work.**
The parser only recognizes the equals-sign form: `--step=2`. Written with a space, `2` is treated as a positional argument (it shows up in `args`).

**`basalt routes` says "No routes registered."**
The command reads the `http:routes` metadata bucket, which is populated by the HTTP adapter (for example `fastifyPlugin`). Make sure the adapter is registered on the same application you pass to `runCli`.

**The application "hangs" after the command finishes.**
`runCli` always calls `app.shutdown()` at the end. If something stays alive, it's probably a resource left open outside the application's lifecycle (a `setInterval` you created, for example) — close it in the command itself.

**I want a custom error exit code.**
Return a number from `handle` (for example `return 3`). `runCli` propagates it; the example `bin/basalt.ts` passes it to `process.exit`.

## How it connects to other modules

- **`@basaltkit/core`** — direct dependency: `runCli` receives a `BasaltApp` from `createApp`, and commands access the `Container` and the metadata buckets (`ensureMetadata`).
- **`@basaltkit/generator`** — provides `generatorCommands()`, a list of `make:*` commands (code generators) ready to pass to `commandsPlugin`. That's how `basalt make:resource` shows up.
- **`@basaltkit/fastify`** — writes routes into the `http:routes` bucket, which the built-in `routes` command reads.
- **`@basaltkit/scheduler`** — writes tasks into the `schedule:entries` bucket, which `schedule:list` reads.
- **`create-basalt`** — with the `--cli` flag, the project generator creates `bin/basalt.ts`, the `pnpm basalt` script, and registers `commandsPlugin(generatorCommands())` for you.
