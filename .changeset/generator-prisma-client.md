---
'@basaltkit/generator': minor
---

The generated repository can be typed against any Prisma client, and
`generatorCommands()` takes project defaults.

The template hardcoded `import type { PrismaClient } from '@prisma/client'` and
`db<PrismaClient>()`. An application with a second client — schema-per-tenant,
database-per-tenant, a read replica — needs the other one, and against that
client the hardcoded type either fails to compile or, worse, compiles and points
at the wrong models. One application hand-edited fourteen generated repositories
for exactly this, which contradicts the point of generating them.

It is a fact about the project, not about one invocation, so it belongs where
the commands are registered rather than in a flag typed every time:

```ts
generatorCommands({
  prisma: true, // every repository in this project is Prisma-backed
  prismaClient: { import: '../../tenant-db.js', type: 'TenantDb' },
})
```

`import` is written into the generated file as-is; a relative path resolves from
`src/modules/<name>/`, where the file lands.

The same argument covers `prisma` and `softDelete`, so `generatorCommands` takes
the whole `GeneratorOptions` as defaults. **A flag still wins in both
directions**: `--no-prisma` generates the in-memory repository even where
`prisma: true` is configured. A default that a flag can only agree with is a
trap, and the CLI's argv parser already gives the negated form its own value.

Nothing changes for a project that configures neither: the default remains
`PrismaClient` from `@prisma/client`.
