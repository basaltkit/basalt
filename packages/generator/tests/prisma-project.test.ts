import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryIo } from '@basaltkit/cli'
import { generatorCommands } from '../src/index.js'

/**
 * `make:resource` in an app scaffolded with `create-basalt --prisma`.
 *
 * The scaffold generates the Prisma client into the project (`#db/client.js`),
 * keeps one `prisma/schema.prisma` and exports the application client from
 * `src/db.ts`. The generator used to know none of it: the repository imported
 * `PrismaClient` from `@prisma/client` (TS2305 under Prisma 7), the model was
 * left in a side file for the developer to paste, and the test booted without
 * `prismaPlugin`, so every request answered 500.
 */

const SCHEMA = `generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}
`

describe('make:resource in a create-basalt --prisma app', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-gen-prisma-project-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const scaffold = async (options: { schema?: boolean; dbModule?: boolean; alias?: boolean } = {}) => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { '@basaltkit/prisma': '^4.0.0', '@basaltkit/tenancy': '^4.0.0' },
        scripts: { 'db:migrate': 'prisma migrate dev', 'db:generate': 'prisma generate' },
        ...(options.alias === false ? {} : { imports: { '#db/*': './generated/prisma/*' } }),
      }),
    )
    if (options.schema !== false) {
      await mkdir(join(root, 'prisma'))
      await writeFile(join(root, 'prisma/schema.prisma'), SCHEMA)
    }
    if (options.dbModule !== false) {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src/db.ts'), 'export const prisma = {}\nexport const db = prisma\n')
    }
  }

  const run = async (command: string, flags: Record<string, unknown> = {}, defaults?: Parameters<typeof generatorCommands>[0]) => {
    const io = memoryIo()
    const code = await generatorCommands(defaults)
      .find((c) => c.name === command)!
      .handle({
        args: ['Product'],
        flags: { dir: root, 'no-register': true, ...flags },
        io,
        app: undefined as never,
        container: undefined as never,
      })
    expect(code).toBe(0)
    return io.lines.join('\n')
  }

  const read = (path: string) => readFile(join(root, path), 'utf8')
  const exists = (path: string) =>
    access(join(root, path)).then(
      () => true,
      () => false,
    )

  it('generates a Prisma repository typed against the generated client, without --prisma', async () => {
    await scaffold()
    await run('make:resource')
    const repository = await read('src/modules/product/product.repository.ts')
    expect(repository).toContain("import type { PrismaClient } from '#db/client.js'")
    expect(repository).not.toContain('@prisma/client')
    expect(repository).toContain('class PrismaProductRepository')
  })

  it('appends the model to prisma/schema.prisma and says how to migrate it', async () => {
    await scaffold()
    const output = await run('make:resource')
    const schema = await read('prisma/schema.prisma')
    expect(schema.startsWith(SCHEMA.trimEnd())).toBe(true)
    expect(schema).toMatch(/\n\nmodel Product \{\n {2}id {8}String {3}@id @default\(cuid\(\)\)\n {2}tenantId {2}String/)
    expect(schema).not.toContain('Add this model')
    expect(await exists('src/modules/product/product.prisma')).toBe(false)
    expect(output).toContain('Added model Product to prisma/schema.prisma')
    expect(output).toContain('pnpm db:migrate --name add_product && pnpm db:generate')
  })

  it('never appends a model twice, even with --force', async () => {
    await scaffold()
    await run('make:resource')
    const output = await run('make:resource', { force: true })
    expect((await read('prisma/schema.prisma')).match(/^model Product \{/gm)).toHaveLength(1)
    expect(output).toContain('already has a model Product')
  })

  it('tests against the app database and skips without one', async () => {
    await scaffold()
    await run('make:resource')
    const test = await read('tests/product.test.ts')
    expect(test).toContain("import { prismaPlugin } from '@basaltkit/prisma'")
    expect(test).toContain("const client = await import('../src/db.js').then((m) => m.db).catch(() => undefined)")
    expect(test).toContain('prismaPlugin({ client: client! }), testAuth, productPlugin')
    expect(test).toContain("describe.skipIf(!client)('product resource'")
    // Rows outlive the run: fresh tenants, relative counts.
    expect(test).toContain('const acme = `acme-${randomUUID()}`')
    expect(test).toContain('.asTenant(acme)')
    expect(test).toContain('toHaveLength(before + 1)')
    expect(test).not.toContain("'acme'")
  })

  it('stays in-memory in an app without prisma/schema.prisma, @basaltkit/prisma or not', async () => {
    // Every scaffold depends on @basaltkit/prisma (for prisma:sync); only the
    // schema says the app has a database.
    await scaffold({ schema: false })
    await run('make:resource')
    expect(await read('src/modules/product/product.repository.ts')).toContain('class InMemoryProductRepository')
    const test = await read('tests/product.test.ts')
    expect(test).not.toContain('prismaPlugin')
    expect(test).toContain("asTenant('acme')")
  })

  it('lets --no-prisma override the detected default', async () => {
    await scaffold()
    await run('make:resource', { prisma: false })
    expect(await read('src/modules/product/product.repository.ts')).toContain('class InMemoryProductRepository')
    expect(await read('prisma/schema.prisma')).toBe(SCHEMA)
  })

  it('keeps a configured client over the detected one', async () => {
    await scaffold()
    await run('make:resource', {}, { prismaClient: { import: '../../platform/db.js', type: 'TenantDb' } })
    expect(await read('src/modules/product/product.repository.ts')).toContain(
      "import type { TenantDb } from '../../platform/db.js'",
    )
  })

  it('writes the model file to paste when there is no single schema file', async () => {
    await scaffold({ schema: false, dbModule: false, alias: false })
    const output = await run('make:resource', { prisma: true })
    expect(await read('src/modules/product/product.prisma')).toContain('model Product {')
    expect(output).toContain('Model Product is in src/modules/product/product.prisma: paste it into your schema.prisma')
    // No src/db.ts to take a client from: the test stays as before.
    expect(await read('tests/product.test.ts')).not.toContain('prismaPlugin')
  })

  it('leaves a schema-per-tenant model out of the shared schema', async () => {
    await scaffold()
    const output = await run('make:resource', { tenant: 'schema' })
    expect(await read('prisma/schema.prisma')).toBe(SCHEMA)
    expect(await read('src/modules/product/product.prisma')).toContain('TENANT schema.prisma')
    expect(output).toContain('paste it into your schema.prisma (the tenant one)')
  })
})
