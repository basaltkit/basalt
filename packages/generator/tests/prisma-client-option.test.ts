import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryIo } from '@basaltkit/cli'
import { generate, generatorCommands } from '../src/index.js'

/**
 * B7 · which Prisma client the generated repository types itself against.
 *
 * The template hardcoded `PrismaClient` from `@prisma/client`. An application
 * with a schema-per-tenant setup has a second, generated client for the tenant
 * schemas — which is precisely what `prismaPlugin({ schemaPerTenant })` asks
 * for — and against that client the hardcoded type either does not compile or,
 * worse, compiles and points at the wrong models.
 *
 * It is a project-wide fact, not a per-command one, so it belongs to
 * `generatorCommands()` rather than to a flag repeated at every invocation.
 */

const tenantDb = { import: '../../tenant-db.js', type: 'TenantDb' }

describe('F-26 · prismaClient option', () => {
  it('defaults to PrismaClient from @prisma/client', () => {
    const { content } = generate('repository', 'Contact', { prisma: true })
    expect(content).toContain("import type { PrismaClient } from '@prisma/client'")
    expect(content).toContain('db<PrismaClient>().contact')
  })

  it('types the repository against the configured client', () => {
    const { content } = generate('repository', 'Contact', { prisma: true, prismaClient: tenantDb })
    expect(content).toContain("import type { TenantDb } from '../../tenant-db.js'")
    expect(content).toContain('db<TenantDb>().contact')
    // The default must be gone, not merely joined by the new one.
    expect(content).not.toContain('@prisma/client')
  })

  it('is inert for an in-memory repository', () => {
    const { content } = generate('repository', 'Contact', { prismaClient: tenantDb })
    expect(content).not.toContain('TenantDb')
    expect(content).toContain('InMemoryContactRepository')
  })
})

describe('F-26 · project defaults through generatorCommands', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-gen-b7-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const run = async (flags: Record<string, unknown>, defaults?: Parameters<typeof generatorCommands>[0]) => {
    const command = generatorCommands(defaults).find((c) => c.name === 'make:repository')!
    const io = memoryIo()
    const code = await command.handle({
      args: ['Contact'],
      // `force` because a test may generate twice into the same root.
      flags: { dir: root, force: true, ...flags },
      io,
      app: undefined as never,
      container: undefined as never,
    })
    expect(code).toBe(0)
    return readFile(join(root, 'src/modules/contact/contact.repository.ts'), 'utf8')
  }

  it('applies the configured client to a generated file', async () => {
    expect(await run({ prisma: true }, { prismaClient: tenantDb })).toContain('db<TenantDb>()')
  })

  it('lets the project default to Prisma-backed without --prisma', async () => {
    // An app where every repository is Prisma-backed should say so once.
    expect(await run({}, { prisma: true, prismaClient: tenantDb })).toContain('db<TenantDb>()')
  })

  it('lets --no-prisma override that default', async () => {
    // A default that a flag cannot turn off is a trap: the flag has to win in
    // both directions, not only when it agrees with the default.
    expect(await run({ prisma: false }, { prisma: true })).toContain('InMemoryContactRepository')
  })

  it('keeps flags winning over defaults for soft delete too', async () => {
    expect(await run({ 'soft-delete': true }, {})).toContain('deletedAt')
    expect(await run({ 'soft-delete': false }, { softDelete: true })).not.toContain('restore(')
  })
})
