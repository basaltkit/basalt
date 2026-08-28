---
"@basaltkit/prisma": patch
---

Drop the `@basaltkit/cli` runtime dependency.

`tenantMigrateCommand` and `prismaSyncCommand` imported `defineCommand` (an identity function) and the `CommandDefinition` type from the CLI, dragging the whole CLI module graph (runner, dev, upgrade, builtins) into every production app using Prisma repositories. The commands now use a structural mirror of the CLI's command contract (new exports: `CommandDefinition`, `CommandContext`, `CommandIo`) — the same pattern tenancy/queue/scheduler already use. Byte-identical runtime behavior; commands remain assignable to the CLI's `CommandDefinition` (proven by a compile-time + end-to-end `runCli` test), so `commandsPlugin([...generatorCommands(), prismaSyncCommand()])` keeps working unchanged. `@basaltkit/cli` moves to devDependencies (contract-parity test only).
