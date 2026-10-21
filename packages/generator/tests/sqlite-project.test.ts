import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryIo } from '@basaltkit/cli'
import { generate, generatorCommands, names } from '../src/index.js'
import { sqliteMigration } from '../src/templates.js'

/**
 * `make:resource --sqlite`: a repository over `node:sqlite`, its table appended
 * to the `MIGRATIONS` of `src/db.ts` — and that module created, with
 * `DATABASE_PATH` in `src/env.ts`, the first time.
 */

const ENV = `import { defineEnv } from '@basaltkit/env'
import { z } from 'zod'

export const env = defineEnv(
  {
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  },
  { prefix: 'MY_SHOP' },
)
`

describe('make:resource --sqlite', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-gen-sqlite-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const scaffold = async (options: { tenancy?: boolean; db?: string; schema?: boolean } = {}) => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { '@basaltkit/prisma': '^4.0.0', ...(options.tenancy ? { '@basaltkit/tenancy': '^4.0.0' } : {}) },
      }),
    )
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/env.ts'), ENV)
    await writeFile(join(root, '.gitignore'), 'node_modules\ndist\n')
    if (options.db !== undefined) await writeFile(join(root, 'src/db.ts'), options.db)
    if (options.schema) {
      await mkdir(join(root, 'prisma'))
      await writeFile(join(root, 'prisma/schema.prisma'), 'datasource db {\n  provider = "postgresql"\n}\n')
    }
  }

  const run = async (flags: Record<string, unknown> = {}, name = 'Product') => {
    const io = memoryIo()
    const code = await generatorCommands()
      .find((c) => c.name === 'make:resource')!
      .handle({
        args: [name],
        flags: { dir: root, 'no-register': true, ...flags },
        io,
        app: undefined as never,
        container: undefined as never,
      })
    return { code, out: io.lines.join('\n') }
  }

  const read = (path: string) => readFile(join(root, path), 'utf8')
  const exists = (path: string) =>
    access(join(root, path)).then(
      () => true,
      () => false,
    )

  it('creates src/db.ts with the table, declares DATABASE_PATH and ignores data/', async () => {
    await scaffold()
    const { code, out } = await run({ sqlite: true })
    expect(code).toBe(0)

    const db = await read('src/db.ts')
    expect(db).toContain("import { DatabaseSync } from 'node:sqlite'")
    expect(db).toContain("env.NODE_ENV === 'test' ? ':memory:' : env.DATABASE_PATH")
    expect(db).toContain('  `CREATE TABLE products (\n     id         TEXT PRIMARY KEY,')
    expect(await read('src/env.ts')).toContain("DATABASE_PATH: z.string().default('./data/app.db'),")
    expect(await read('.gitignore')).toMatch(/^data\/$/m)

    const repository = await read('src/modules/product/product.repository.ts')
    expect(repository).toContain('export class SqliteProductRepository implements ProductRepository')
    expect(repository).not.toContain('requireTenantId')
    const plugin = await read('src/modules/product/product.plugin.ts')
    expect(plugin).toContain("import { database } from '../../db.js'")
    expect(plugin).toContain('new SqliteProductRepository(database())')

    // The step lives in src/db.ts, not in a side file.
    expect(await exists('src/modules/product/product.sql')).toBe(false)
    expect(out).toContain('Created src/db.ts')
    expect(out).toContain('DATABASE_PATH is declared in src/env.ts.')
  })

  it('appends the next table to MIGRATIONS, and defaults to SQLite once src/db.ts is the SQLite module', async () => {
    await scaffold()
    await run({ sqlite: true })
    const { code, out } = await run({}, 'BlogPost')
    expect(code).toBe(0)

    const db = await read('src/db.ts')
    expect(db.indexOf('CREATE TABLE products')).toBeLessThan(db.indexOf('CREATE TABLE blog_posts'))
    expect(db).toMatch(/CREATE TABLE blog_posts[\s\S]*`,\n\]/)
    expect(await read('src/modules/blog-post/blog-post.repository.ts')).toContain('SqliteBlogPostRepository')
    expect(out).toContain('Added the blog_posts table to MIGRATIONS in src/db.ts')
    // DATABASE_PATH is declared once.
    expect((await read('src/env.ts')).match(/DATABASE_PATH/g)).toHaveLength(1)
  })

  it('never adds a table twice, even with --force', async () => {
    await scaffold()
    await run({ sqlite: true })
    const before = await read('src/db.ts')
    const { code, out } = await run({ force: true })
    expect(code).toBe(0)
    expect(await read('src/db.ts')).toBe(before)
    expect(out).toContain('already creates the products table')
  })

  it('scopes a tenant-owned table by an indexed tenant_id column', async () => {
    await scaffold({ tenancy: true })
    const { code, out } = await run({ sqlite: true })
    expect(code).toBe(0)
    const repository = await read('src/modules/product/product.repository.ts')
    expect(repository).toContain("import { requireTenantId } from '@basaltkit/tenancy'")
    expect(repository).toContain("'SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(id, requireTenantId())")
    expect(await read('src/db.ts')).toContain('CREATE INDEX products_tenant ON products (tenant_id);')
    expect(out).toContain('the table has an indexed tenant_id column')
  })

  it('refuses schema- and database-per-tenant, and --prisma with --sqlite', async () => {
    await scaffold({ tenancy: true })
    expect((await run({ sqlite: true, tenant: 'schema' })).code).toBe(1)
    expect((await run({ sqlite: true, prisma: true })).code).toBe(1)
    expect(await exists('src/db.ts')).toBe(false)
  })

  it('wins over a Prisma project default, but leaves a Prisma src/db.ts alone', async () => {
    const prismaDb = 'export const prisma = {}\nexport const db = prisma\n'
    await scaffold({ schema: true, db: prismaDb })
    const { code, out } = await run({ sqlite: true })
    expect(code).toBe(0)
    expect(await read('src/db.ts')).toBe(prismaDb)
    expect(await read('prisma/schema.prisma')).not.toContain('model Product')
    expect(await read('src/modules/product/product.repository.ts')).toContain('SqliteProductRepository')
    expect(await read('src/modules/product/product.sql')).toContain('CREATE TABLE products (')
    expect(out).toContain('src/db.ts is not the SQLite module')
  })

  it('--no-sqlite keeps a SQLite project resource in memory', async () => {
    await scaffold()
    await run({ sqlite: true })
    expect((await run({ sqlite: false }, 'Note')).code).toBe(0)
    expect(await read('src/modules/note/note.repository.ts')).toContain('InMemoryNoteRepository')
    expect(await read('src/db.ts')).not.toContain('CREATE TABLE notes')
  })
})

describe('the generated SQLite repository', () => {
  // Every statement the repository prepares must compile against the table its
  // migration creates — a typo in a column name only shows up at runtime.
  it.each([
    { tenant: false, softDelete: false },
    { tenant: true, softDelete: false },
    { tenant: false, softDelete: true },
    { tenant: true, softDelete: true },
  ])('prepares against its own table (%o)', ({ tenant, softDelete }) => {
    const options = { sqlite: true, tenant, softDelete }
    const db = new DatabaseSync(':memory:')
    db.exec(sqliteMigration(names('BlogPost'), options))
    const repository = generate('repository', 'BlogPost', options).content
    const statements = [...repository.matchAll(/\.prepare\('([^']+)'\)/g)].map((m) => m[1] as string)
    expect(statements.length).toBeGreaterThanOrEqual(softDelete ? 6 : 5)
    for (const sql of statements) expect(() => db.prepare(sql), sql).not.toThrow()
    db.close()
  })
})
