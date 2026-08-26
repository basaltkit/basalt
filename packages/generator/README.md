<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/generator

Code generator ("scaffolding") for Basalt applications: the `basalt make:*` commands create all the files for a resource for you — schema, repository, service, plugin, HTTP routes, and test — already wired together and compiling. You need this whenever you're adding a new "entity" to the application (Projects, Customers, Invoices…) and don't want to write the same skeleton by hand.

## What this module solves

**Scaffolding** is the practice of automatically creating the repetitive files for a new feature. In a well-organized application, each resource (e.g. "Project") usually needs the same set of pieces every time: a **schema** (the validated description of the data, built with Zod), a **repository** (the layer that stores and reads the data), a **service** (the business logic), a **plugin** (which registers everything in the dependency container), **HTTP routes** (the REST endpoints), and a **test**.

Writing these six pieces by hand for every resource is slow and prone to naming mistakes — swap `blogPost` for `blogpost` in one spot and nothing compiles. The generator derives all the name variations at once (`BlogPost`, `blogPost`, `blog-post`, `blog-posts`, `BLOG_POST`) and uses them consistently across all files.

Besides generating the files, `make:resource` also wires the new resource into `src/app.ts` automatically (imports the plugin and routes and inserts them in the right places) and, with `--prisma`, generates a repository connected to the database via Prisma instead of the in-memory version.

## Installation

```bash
pnpm add @basaltkit/generator
```

> Note: depends on `@basaltkit/cli` (the `basalt` command framework). The generated code uses `@basaltkit/core`, `@basaltkit/fastify`, `zod`, and — in the generated tests — `@basaltkit/testing`, so it's worth having them in the project. If you created the project with `create-basalt --cli`, everything is already set up.

## Get started in 5 minutes

1. Make sure your application registers the generator's commands. In `src/app.ts`:

```typescript
import { createApp } from '@basaltkit/core'
import { commandsPlugin } from '@basaltkit/cli'
import { fastifyPlugin } from '@basaltkit/fastify'
import { generatorCommands } from '@basaltkit/generator'
import { appRoutes } from './routes.js'

export function buildApp() {
  return createApp({
    plugins: [
      commandsPlugin(generatorCommands()),
      fastifyPlugin({ routes: [...appRoutes] }),
    ],
  })
}
```

2. Make sure you have the `basalt` executable (created automatically by `create-basalt --cli`; see the `@basaltkit/cli` README if you don't have it).

3. Generate a complete resource:

```bash
pnpm basalt make:resource Project
```

4. See what was created:

```
Generated 6 file(s):
  src/modules/project/project.plugin.ts
  src/modules/project/project.repository.ts
  src/modules/project/project.routes.ts
  src/modules/project/project.schema.ts
  src/modules/project/project.service.ts
  tests/project.test.ts
Wired the plugin + routes into src/app.ts.
```

5. Run the tests and try out the endpoints:

```bash
pnpm test          # the generated test covers create/list/get/update/delete
pnpm dev           # GET/POST /projects, GET/PATCH/DELETE /projects/:id
```

## Usage guide

### `basalt make:resource <Name>` — the complete resource

Generates the entire "vertical slice": schema → repository → service → plugin → routes → test. By default, the repository is **in-memory** (data is lost on restart — great for getting started) and the resource is automatically wired into `src/app.ts`.

```bash
pnpm basalt make:resource BlogPost
```

The name can be given in any format — `BlogPost`, `blog-post`, `blog post` — the generator normalizes it. Endpoints use the plural in kebab-case: `/blog-posts`.

Options (common to all `make:*` commands, unless noted):

| Flag | What it does |
| --- | --- |
| `--dir=<path>` | Project root to write to (default: current directory) |
| `--force` | Overwrites existing files instead of refusing |
| `--prisma` | Generates a repository connected to Prisma + a model for `schema.prisma` |
| `--no-register` | (only `make:resource`) Doesn't touch `src/app.ts` |

### `--prisma` — real persistence with a database

```bash
pnpm basalt make:resource BlogPost --prisma
```

Instead of the in-memory repository, generates `PrismaBlogPostRepository` (which uses `db()` from `@basaltkit/prisma`) and an extra file `src/modules/blog-post/blog-post.prisma` with the model block to copy into your `schema.prisma`. Then run `prisma migrate dev`.

### Automatic wiring into `src/app.ts`

After writing the files, `make:resource` tries to:

1. add the plugin and routes `import`s after the last import;
2. insert `blogPostPlugin,` immediately before `fastifyPlugin(`;
3. spread `...blogPostRoutes, ` at the start of the `fastifyPlugin({ routes: [...] })` array.

It is **idempotent** (running it twice doesn't duplicate anything) and **all-or-nothing**: if `src/app.ts` doesn't exist, is already wired, or doesn't have the shape `fastifyPlugin({ routes: [...] })`, it changes nothing and explains why — in that case, wire it up by hand.

### Generating just one piece: `make:schema`, `make:repository`, …

Each artifact type has its own command:

```bash
pnpm basalt make:schema Invoice        # src/modules/invoice/invoice.schema.ts
pnpm basalt make:repository Invoice    # src/modules/invoice/invoice.repository.ts
pnpm basalt make:service Invoice       # src/modules/invoice/invoice.service.ts
pnpm basalt make:plugin Invoice        # src/modules/invoice/invoice.plugin.ts
pnpm basalt make:routes Invoice        # src/modules/invoice/invoice.routes.ts
pnpm basalt make:test Invoice          # tests/invoice.test.ts
```

Without a name, any command prints usage and returns exit code 1:

```
Usage: basalt make:resource <Name> [--dir=<path>] [--force] [--prisma]
```

### Using the generator as a library (Advanced)

You can generate files programmatically, without going through the CLI:

```typescript
import { generateResource, writeGenerated, registerResourceInApp } from '@basaltkit/generator'

const files = generateResource('BlogPost', { prisma: false })
const written = await writeGenerated(files, { baseDir: '/path/to/project' })
console.log(written) // relative paths, sorted

const result = await registerResourceInApp('BlogPost', { baseDir: '/path/to/project' })
console.log(result.registered) // true if it wired into src/app.ts
```

## API reference

Exported from `@basaltkit/generator`:

### `names(input: string): Names`

Derives all variations of a name. Throws `Error` if it can't extract words from the input.

| `Names` field | Example (`blog-post`) | Used for |
| --- | --- | --- |
| `raw` | `blog-post` | Original input |
| `pascal` | `BlogPost` | Class and type names |
| `camel` | `blogPost` | Variables and identifiers |
| `kebab` | `blog-post` | File and folder names |
| `pluralKebab` | `blog-posts` | Route paths |
| `constant` | `BLOG_POST` | Tokens and error codes |

Pluralization is English and simplified (`company` → `companies`, `box` → `boxes`, otherwise → `+s`).

### `generate(kind, name, options?): GeneratedFile`

Generates **one** artifact. `kind` is a `GeneratorKind`: `'schema' | 'repository' | 'service' | 'plugin' | 'routes' | 'test'`.

### `generateResource(name, options?): GeneratedFile[]`

Generates the complete vertical slice. With `options.prisma: true`, adds the `.prisma` file and swaps the repository for the Prisma version.

`GeneratorOptions`:

| Field | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `prisma` | `boolean` | No | `false` | Prisma repository (+ `schema.prisma` model) instead of in-memory |

`GeneratedFile`: `{ path: string; content: string }` — the path is relative to the project root.

### `writeGenerated(files, options?): Promise<string[]>`

Writes the files to disk (creates the necessary folders). Returns the written paths, sorted. If any file already exists and `force` is false, throws `FileExistsError` **before** writing anything.

`WriteOptions`:

| Field | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `baseDir` | `string` | No | `process.cwd()` | Project root paths are resolved against |
| `force` | `boolean` | No | `false` | Overwrite existing files |

### `registerResourceInApp(name, options?): Promise<AppRegistration>`

Wires a generated resource into `src/app.ts` (imports + plugin + routes spread). Never throws because of the file's shape — it reports the reason instead.

`AppRegistration`:

| Field | Type | Description |
| --- | --- | --- |
| `registered` | `boolean` | `true` if it changed the file |
| `reason` | `string?` | When not registered: `'src/app.ts not found'`, `'already registered'`, or `'app.ts does not use fastifyPlugin({ routes: [...] })'` |
| `appPath` | `string` | Absolute path of the `src/app.ts` considered |

### `generatorCommands(): CommandDefinition[]`

Returns the `make:resource` and `make:<kind>` commands (one per `GeneratorKind`) ready to register with `commandsPlugin` from `@basaltkit/cli`.

### `GENERATORS` (Advanced)

Map of `kind → generator function` (`{ schema, repository, service, plugin, routes, test }`). `GeneratorKind` is `keyof typeof GENERATORS`.

### `FileExistsError`

Error thrown by `writeGenerated` when there are conflicts without `force`. Has a `paths: string[]` property with the conflicting files.

### Exported types

`Names`, `GeneratedFile`, `GeneratorKind`, `GeneratorOptions`, `WriteOptions`, `AppRegistration` — described above.

## Common issues and solutions (FAQ)

**`Refusing to overwrite existing files (use force to replace): …`**
The generator never overwrites files by default. If you really want to regenerate, add `--force` (in the CLI) or `{ force: true }` (in the API). Warning: you'll lose manual changes to those files.

**`Could not auto-wire src/app.ts (app.ts does not use fastifyPlugin({ routes: [...] })).`**
Automatic wiring only recognizes the `fastifyPlugin({ routes: [...] })` shape in `src/app.ts`. If you reorganized the file, wire it up by hand: import `<name>Plugin` and `<name>Routes` from the generated module, add the plugin to the `plugins` list, and spread the routes (`...<name>Routes`) into the `routes` array.

**I generated with `--prisma` but get an error that `blogPost` doesn't exist on PrismaClient.**
The Prisma repository assumes a model with the PascalCase name (`model BlogPost`) in your `schema.prisma`. Copy the generated `.prisma` file's contents into `schema.prisma`, run `prisma migrate dev`, and regenerate the Prisma client.

**Data disappears when I restart the server.**
This is the expected behavior of the in-memory repository (the default). For real persistence, generate with `--prisma` or implement the `<Name>Repository` interface yourself and register it in the plugin.

**`Usage: basalt make:resource <Name> …` and exit code 1.**
The resource name is missing: `pnpm basalt make:resource Project`.

**I ran `make:resource` twice and `app.ts` didn't change the second time.**
Correct — wiring is idempotent. The message `Already wired into src/app.ts — left it as is.` confirms nothing was duplicated.

## How it connects to other modules

- **`@basaltkit/cli`** — direct dependency: `generatorCommands()` returns `CommandDefinition[]` to register with `commandsPlugin`; this is what makes `make:*` appear in `basalt`.
- **`@basaltkit/core`** — the generated code uses `createToken`, `definePlugin`, and `ctx` from the framework core.
- **`@basaltkit/fastify`** — generated routes use `route(...)` and `HttpError`; automatic wiring looks for `fastifyPlugin({ routes: [...] })` in `app.ts`.
- **`@basaltkit/prisma`** — with `--prisma`, the generated repository uses `db()` from this package.
- **`@basaltkit/testing`** — the generated test uses `createTestApp` to exercise the full CRUD.
- **`create-basalt`** — with `--cli`, the new project already comes with `@basaltkit/generator` installed and the commands registered.
