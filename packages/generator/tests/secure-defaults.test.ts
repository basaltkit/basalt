import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryIo } from '@basaltkit/cli'
import { generate, generateResource, generatorCommands } from '../src/index.js'

/**
 * Security invariant: `basalt make:resource` must not scaffold (and auto-wire)
 * anonymous, tenant-agnostic CRUD. Generated routes require an authenticated
 * user unless the developer opts out explicitly, and in a multi-tenant project
 * every repository operation is scoped to the context tenant (fail-closed).
 */

const file = (files: { path: string; content: string }[], suffix: string): string =>
  files.find((f) => f.path.endsWith(suffix))!.content

describe('generated routes require authentication by default', () => {
  it('every generated route declares meta.auth', () => {
    const routes = file(generateResource('Invoice'), '.routes.ts')
    expect(routes).toMatch(/meta: \{ auth: true/)
    // the guard is applied to the exported array, i.e. to every route in it
    expect(routes).toMatch(/export const invoiceRoutes = \[[\s\S]*\]\.map\(requireAuth\)/)
  })

  it('soft-delete restore route is covered too (make:routes emits the same guard)', () => {
    const routes = generate('routes', 'Invoice', { softDelete: true }).content
    expect(routes).toContain("url: '/invoices/:id/restore'")
    expect(routes).toMatch(/\]\.map\(requireAuth\)/)
  })

  it('auth: false is the explicit, named opt-out for public resources', () => {
    const routes = file(generateResource('Invoice', { auth: false }), '.routes.ts')
    expect(routes).not.toContain('auth: true')
    expect(routes).not.toContain('requireAuth')
  })

  it('the generated test authenticates and asserts anonymous access is rejected', () => {
    const test = file(generateResource('Invoice'), '.test.ts')
    expect(test).toContain('actingAs(')
    expect(test).toContain('toBe(401)')
  })
})

describe('tenant-owned resources are scoped to the context tenant', () => {
  it('in-memory repository partitions rows by requireTenantId()', () => {
    const repo = generate('repository', 'Invoice', { tenant: true }).content
    expect(repo).toContain("import { requireTenantId } from '@basaltkit/tenancy'")
    expect(repo).toContain('requireTenantId()')
    // no single global id → row map shared by every tenant
    expect(repo).not.toMatch(/private readonly items = new Map<string, Invoice>\(\)/)
  })

  it('Prisma repository scopes every read and write by tenantId', () => {
    for (const softDelete of [false, true]) {
      const repo = generate('repository', 'Invoice', { tenant: true, prisma: true, softDelete }).content
      expect(repo).toContain("import { requireTenantId } from '@basaltkit/tenancy'")
      // no by-id access that ignores the tenant
      expect(repo).not.toMatch(/where: \{ id \}/)
      expect(repo).not.toContain('findUnique(')
      expect(repo).toMatch(/findMany\(\{ where: \{ tenantId: requireTenantId\(\)/)
      expect(repo).toMatch(/create\(\{ data: \{ \.\.\.input, tenantId: requireTenantId\(\) \} \}\)/)
      const scopedById = repo.match(/where: \{ id, tenantId: requireTenantId\(\)/g) ?? []
      // find, update, delete (+ restore)
      expect(scopedById.length).toBe(softDelete ? 4 : 3)
    }
  })

  it('Prisma model carries an indexed tenantId column', () => {
    const model = file(generateResource('Invoice', { tenant: true, prisma: true }), '.prisma')
    expect(model).toMatch(/tenantId\s+String/)
    expect(model).toContain('@@index([tenantId])')
  })

  it('the generated test asserts cross-tenant isolation', () => {
    const test = file(generateResource('Invoice', { tenant: true }), '.test.ts')
    expect(test).toContain("asTenant('acme')")
    expect(test).toContain("tenant: 'globex'")
  })
})

describe('make:resource detects tenancy and prints a security note', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'basalt-gen-sec-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const run = async (flags: Record<string, unknown> = {}) => {
    const resource = generatorCommands().find((c) => c.name === 'make:resource')!
    const io = memoryIo()
    const code = await resource.handle({
      args: ['Invoice'],
      flags: { dir: root, ...flags } as never,
      io,
      app: undefined as never,
      container: undefined as never,
    })
    expect(code).toBe(0)
    return io.lines.join('\n')
  }
  const repo = () => readFile(join(root, 'src/modules/invoice/invoice.repository.ts'), 'utf8')
  const routes = () => readFile(join(root, 'src/modules/invoice/invoice.routes.ts'), 'utf8')

  it('a project depending on @basaltkit/tenancy gets tenant-scoped code', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@basaltkit/tenancy': '^1.0.0' } }),
    )
    const out = await run()
    expect(await repo()).toContain('requireTenantId()')
    expect(await routes()).toContain('.map(requireAuth)')
    expect(out).toMatch(/Security:/)
    expect(out).toMatch(/authenticated/)
    expect(out).toMatch(/tenant/)
  })

  it('a project without tenancy is still authenticated, and not tenant-scoped', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    const out = await run()
    expect(await repo()).not.toContain('requireTenantId')
    expect(await routes()).toContain('.map(requireAuth)')
    expect(out).toMatch(/Security:/)
  })

  it('--no-tenant and --no-auth are explicit opt-outs, and the note says so', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@basaltkit/tenancy': '^1.0.0' } }),
    )
    const out = await run({ tenant: false, auth: false })
    expect(await repo()).not.toContain('requireTenantId')
    expect(await routes()).not.toContain('requireAuth')
    expect(out).toMatch(/PUBLIC/)
    expect(out).toMatch(/NOT tenant-scoped/)
  })

  it('--public is the named opt-out for anonymous routes', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    const out = await run({ public: true })
    expect(await routes()).not.toContain('requireAuth')
    expect(out).toMatch(/PUBLIC/)
  })
})
