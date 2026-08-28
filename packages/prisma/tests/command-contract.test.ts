import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
// Dev-only import: the CLI is a devDependency here, used solely to PROVE the
// structural command contract stays assignable to the real CLI's — the
// runtime package no longer depends on @basaltkit/cli (ecosystem review
// 2026-08, finding A2).
import { commandsPlugin, memoryIo, runCli, type CommandDefinition as CliCommandDefinition } from '@basaltkit/cli'
import { tenantMigrateCommand } from '../src/migrate-command.js'
import { prismaSyncCommand } from '../src/sync-command.js'

describe('command contract (structural parity with @basaltkit/cli)', () => {
  it("prisma's commands are assignable to the CLI's CommandDefinition (compile-time proof)", () => {
    // If @basaltkit/prisma's structural CommandDefinition ever drifts from the
    // CLI's (field renamed, context widened beyond what the CLI provides),
    // this assignment stops compiling — exactly the scaffolded-app usage
    // `commandsPlugin([...generatorCommands(), prismaSyncCommand()])`.
    const commands: CliCommandDefinition[] = [
      tenantMigrateCommand({ tenants: () => [], target: { mode: 'database', urlFor: () => '' } }),
      prismaSyncCommand(),
    ]
    expect(commands.map((command) => command.name)).toEqual(['tenant:migrate', 'prisma:sync'])
  })

  it('the real CLI discovers and runs tenant:migrate end-to-end', async () => {
    const io = memoryIo()
    const app = createApp({
      plugins: [
        commandsPlugin([
          tenantMigrateCommand({ tenants: () => [], target: { mode: 'database', urlFor: () => '' } }),
        ]),
      ],
    })
    const code = await runCli({ app, argv: ['tenant:migrate'], io })
    expect(code).toBe(0)
    expect(io.lines).toContain('No tenants to migrate.')
  })

  it('the real CLI lists the registered prisma commands', async () => {
    const io = memoryIo()
    const app = createApp({ plugins: [commandsPlugin([prismaSyncCommand()])] })
    const code = await runCli({ app, argv: ['list'], io })
    expect(code).toBe(0)
    const table = JSON.stringify(io.lines)
    expect(table).toContain('prisma:sync')
  })
})
