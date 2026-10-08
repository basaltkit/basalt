import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryIo } from '@basaltkit/cli'
import { generate, generateResource, generatorCommands, type GeneratorOptions } from '../src/index.js'

/**
 * `--tenant` isolation modes (BK-086). A shared database needs a `tenantId`
 * column and a filter on every query; a schema- or database-per-tenant app
 * isolates physically, so a `tenantId` column there is dead weight that the
 * developer has to delete. Every mode stays fail-closed: no resolved tenant,
 * no query. The mode is explicit — never guessed from the project.
 */

const file = (files: { path: string; content: string }[], suffix: string): string =>
  files.find((f) => f.path.endsWith(suffix))!.content

describe('tenant isolation modes', () => {
  it("'column' is what tenant: true has always generated", () => {
    for (const softDelete of [false, true]) {
      const asTrue = generateResource('Invoice', { tenant: true, prisma: true, softDelete })
      const asColumn = generateResource('Invoice', { tenant: 'column', prisma: true, softDelete })
      expect(asColumn).toEqual(asTrue)
    }
    const model = file(generateResource('Invoice', { tenant: 'column', prisma: true }), '.prisma')
    expect(model).toMatch(/tenantId\s+String/)
    expect(model).toContain('@@index([tenantId])')
  })

  for (const mode of ['schema', 'database'] as const) {
    describe(`'${mode}'`, () => {
      const options: GeneratorOptions = { tenant: mode, prisma: true }

      it('emits no tenantId column and no tenant filter', () => {
        const files = generateResource('Invoice', options)
        const model = file(files, '.prisma')
        expect(model).not.toMatch(/tenantId\s+String|@@index/)
        expect(model).toContain(`TENANT schema.prisma (${mode}-per-tenant`)
        const repo = file(files, '.repository.ts')
        expect(repo).not.toMatch(/tenantId:|tenantId }/)
      })

      it('still fails closed: every access requires a resolved tenant', () => {
        for (const softDelete of [false, true]) {
          const repo = generate('repository', 'Invoice', { ...options, softDelete }).content
          expect(repo).toContain("import { requireTenantId } from '@basaltkit/tenancy'")
          // the single gateway to the client starts with requireTenantId()
          expect(repo).toMatch(/private get records\(\) \{\n {4}requireTenantId\(\)[^\n]*\n {4}return db<PrismaClient>\(\)\.invoice/)
          // every query goes through that gateway — no other client access
          expect(repo.match(/db</g)).toHaveLength(1)
          expect(repo).toContain(mode === 'schema' ? 'schemaPerTenant' : 'forTenant')
        }
      })

      it('respects a custom tenant Prisma client', () => {
        const repo = generate('repository', 'Invoice', {
          ...options,
          prismaClient: { import: '../../tenant-db.js', type: 'TenantDb' },
        }).content
        expect(repo).toContain("import type { TenantDb } from '../../tenant-db.js'")
        expect(repo).toContain('db<TenantDb>().invoice')
      })

      it('partitions the in-memory repository per tenant', () => {
        const repo = generate('repository', 'Invoice', { tenant: mode }).content
        expect(repo).toContain('requireTenantId()')
        expect(repo).toContain('byTenant')
      })

      it('the generated test runs as a tenant and asserts cross-tenant isolation', () => {
        const test = file(generateResource('Invoice', options), '.test.ts')
        expect(test).toContain(".asTenant('acme')")
        expect(test).toContain("tenant: 'globex'")
      })
    })
  }
})

describe('make:resource --tenant=<mode>', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-gen-tenant-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const run = async (flags: Record<string, unknown> = {}, defaults: GeneratorOptions = {}) => {
    const resource = generatorCommands(defaults).find((c) => c.name === 'make:resource')!
    const io = memoryIo()
    const code = await resource.handle({
      args: ['Invoice'],
      flags: { dir: root, register: false, ...flags } as never,
      io,
      app: undefined as never,
      container: undefined as never,
    })
    return { code, out: io.lines.join('\n') }
  }
  const read = (suffix: string) => readFile(join(root, `src/modules/invoice/invoice${suffix}`), 'utf8')

  it('--tenant=schema generates a model without tenantId and says how data is isolated', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@basaltkit/tenancy': '^1.0.0' } }))
    const { code, out } = await run({ tenant: 'schema', prisma: true })
    expect(code).toBe(0)
    expect(await read('.prisma')).not.toMatch(/tenantId\s+String/)
    expect(await read('.repository.ts')).toContain('requireTenantId()')
    expect(out).toMatch(/isolation: schema-per-tenant/)
    expect(out).toMatch(/no tenantId column/)
  })

  it('--tenant=database works without the tenancy package being detected', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    const { code, out } = await run({ tenant: 'database', prisma: true })
    expect(code).toBe(0)
    expect(await read('.prisma')).not.toMatch(/tenantId\s+String/)
    expect(out).toMatch(/isolation: database-per-tenant/)
  })

  it('a detected tenancy dependency still defaults to the tenantId column (no guessing)', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@basaltkit/tenancy': '^1.0.0' } }))
    const { out } = await run({ prisma: true })
    expect(await read('.prisma')).toMatch(/tenantId\s+String/)
    expect(out).toMatch(/isolation: tenantId column/)
  })

  it('a project-level mode default applies, also to a bare --tenant; a flag overrides it', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    await run({ prisma: true }, { tenant: 'schema' })
    expect(await read('.prisma')).not.toMatch(/tenantId\s+String/)
    await run({ prisma: true, tenant: true, force: true }, { tenant: 'schema' })
    expect(await read('.prisma')).not.toMatch(/tenantId\s+String/)
    await run({ prisma: true, tenant: 'column', force: true }, { tenant: 'schema' })
    expect(await read('.prisma')).toMatch(/tenantId\s+String/)
    await run({ prisma: true, tenant: false, force: true }, { tenant: 'schema' })
    expect(await read('.repository.ts')).not.toContain('requireTenantId')
  })

  it('rejects an unknown mode', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    const { code } = await run({ tenant: 'rls' })
    expect(code).toBe(1)
  })
})
