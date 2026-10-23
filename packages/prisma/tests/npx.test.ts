import { describe, expect, it } from 'vitest'
import { localPrismaArgs } from '../src/npx.js'
import { prismaMigrateArgs } from '../src/migrate.js'
import { prismaStatusArgs } from '../src/status-command.js'

describe('localPrismaArgs', () => {
  it('runs the project\'s own Prisma CLI: npx never installs one, and the Prisma flags stay after --', () => {
    expect(localPrismaArgs(['migrate', 'deploy', '--config', 'prisma.config.ts']))
      .toEqual(['--no', '--', 'prisma', 'migrate', 'deploy', '--config', 'prisma.config.ts'])
    expect(localPrismaArgs(['--version'])).toEqual(['--no', '--', 'prisma', '--version'])
  })

  it('wraps the argv the migrator and the status command build', () => {
    expect(localPrismaArgs(prismaMigrateArgs({ configPath: 'p/t.config.ts' }).slice(1)))
      .toEqual(['--no', '--', 'prisma', 'migrate', 'deploy', '--config', 'p/t.config.ts'])
    expect(localPrismaArgs(prismaStatusArgs({ schemaPath: 's.prisma' }).slice(1)))
      .toEqual(['--no', '--', 'prisma', 'migrate', 'status', '--schema', 's.prisma'])
  })
})
