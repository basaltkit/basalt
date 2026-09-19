import type { Names } from './names.js'

/** A file the generator produces, path relative to the project root. */
export interface GeneratedFile {
  path: string
  content: string
}

/** Which Prisma client a generated repository types itself against. */
export interface PrismaClientRef {
  /** Module specifier, written into the generated file as-is. Relative paths are from `src/modules/<name>/`. */
  import: string
  /** Name of the exported client type. */
  type: string
}

export interface GeneratorOptions {
  /** Generate a Prisma-backed repository (and a schema.prisma model) instead of in-memory. */
  prisma?: boolean
  /**
   * The Prisma client the repository is typed against. Defaults to
   * `PrismaClient` from `@prisma/client`.
   *
   * An application with more than one client — schema-per-tenant,
   * database-per-tenant, a read replica — needs the other one, and against it
   * the default either fails to compile or, worse, compiles and points at the
   * wrong models.
   *
   * ```ts
   * prismaClient: { import: '../../tenant-db.js', type: 'TenantDb' }
   * ```
   */
  prismaClient?: PrismaClientRef
  /**
   * Add a soft-delete column (`deletedAt`): `delete` marks the row instead of
   * removing it, `list`/`find` skip soft-deleted rows, and a `restore()` method
   * (+ `POST /…/:id/restore` route) brings it back.
   */
  softDelete?: boolean
  /**
   * Require an authenticated user on every generated route (`meta.auth`,
   * enforced by `@basaltkit/auth`'s `authPlugin`; the adapters refuse to boot
   * when no plugin enforces it). Default: `true` — secure by default. Pass
   * `false` (CLI: `--public`, or `--no-auth`) only for a deliberately public resource.
   */
  auth?: boolean
  /**
   * Treat the resource as tenant-owned: the repository scopes every read and
   * write to the context tenant via `requireTenantId()` from
   * `@basaltkit/tenancy` (fail-closed: no tenant → 400, never unscoped), and
   * the Prisma model gets an indexed `tenantId` column. Default: `false` here;
   * the `make:*` CLI commands turn it on when the project depends on
   * `@basaltkit/tenancy` (opt out with `--no-tenant`).
   */
  tenant?: boolean
}

const dir = (n: Names) => `src/modules/${n.kebab}`

export function schemaFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  const soft = options.softDelete ? '\n  deletedAt: z.string().nullable(),' : ''
  return {
    path: `${dir(n)}/${n.kebab}.schema.ts`,
    content: `import { z } from 'zod'

export const ${n.pascal}Schema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),${soft}
})
export type ${n.pascal} = z.infer<typeof ${n.pascal}Schema>

export const Create${n.pascal}Schema = z.object({
  name: z.string().min(1),
})
export type Create${n.pascal}Input = z.infer<typeof Create${n.pascal}Schema>

export const Update${n.pascal}Schema = Create${n.pascal}Schema.partial()
export type Update${n.pascal}Input = z.infer<typeof Update${n.pascal}Schema>
`,
  }
}

const repositoryInterface = (n: Names, soft: boolean): string => `export interface ${n.pascal}Repository {
  list(): Promise<${n.pascal}[]>
  find(id: string): Promise<${n.pascal} | null>
  create(input: Create${n.pascal}Input): Promise<${n.pascal}>
  update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null>
  delete(id: string): Promise<boolean>${soft ? '\n  restore(id: string): Promise<boolean>' : ''}
}`

function prismaRepository(n: Names, soft: boolean, prismaClient?: PrismaClientRef, tenant = false): string {
  const rowType = soft
    ? '{ id: string; name: string; createdAt: Date; updatedAt: Date; deletedAt: Date | null }'
    : '{ id: string; name: string; createdAt: Date; updatedAt: Date }'
  const mapper = soft
    ? `  id: r.id,
  name: r.name,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,`
    : `  id: r.id,
  name: r.name,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),`
  if (tenant) return tenantPrismaRepository(n, soft, rowType, mapper, prismaClient)
  const listCall = soft ? 'findMany({ where: { deletedAt: null } })' : 'findMany()'
  const findCall = soft ? 'findFirst({ where: { id, deletedAt: null } })' : 'findUnique({ where: { id } })'
  const deleteBody = soft
    ? `await this.records.update({ where: { id }, data: { deletedAt: new Date() } })`
    : `await this.records.delete({ where: { id } })`
  const restore = soft
    ? `

  async restore(id: string): Promise<boolean> {
    try {
      await this.records.update({ where: { id }, data: { deletedAt: null } })
      return true
    } catch {
      return false
    }
  }`
    : ''
  const client = prismaClient ?? { import: '@prisma/client', type: 'PrismaClient' }
  return `import { createToken } from '@basaltkit/core'
import { db } from '@basaltkit/prisma'
import type { ${client.type} } from '${client.import}'
import type { ${n.pascal}, Create${n.pascal}Input, Update${n.pascal}Input } from './${n.kebab}.schema.js'

// Map the Prisma row (Date columns) to the API type (ISO-string timestamps).
const to${n.pascal} = (r: ${rowType}): ${n.pascal} => ({
${mapper}
})

${repositoryInterface(n, soft)}

/** Prisma-backed. Requires prismaPlugin configured and a \`${n.pascal}\` model in schema.prisma. */
export class Prisma${n.pascal}Repository implements ${n.pascal}Repository {
  private get records() {
    return db<${client.type}>().${n.camel}
  }

  async list(): Promise<${n.pascal}[]> {
    return (await this.records.${listCall}).map(to${n.pascal})
  }

  async find(id: string): Promise<${n.pascal} | null> {
    const r = await this.records.${findCall}
    return r ? to${n.pascal}(r) : null
  }

  async create(input: Create${n.pascal}Input): Promise<${n.pascal}> {
    return to${n.pascal}(await this.records.create({ data: input }))
  }

  async update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null> {
    try {
      return to${n.pascal}(await this.records.update({ where: { id }, data: input }))
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      ${deleteBody}
      return true
    } catch {
      return false
    }
  }${restore}
}

export const ${n.constant}_REPOSITORY = createToken<${n.pascal}Repository>('${n.kebab}.repository')
`
}

/**
 * Tenant-owned Prisma repository: every query carries `tenantId` from the
 * request context (`requireTenantId()` fails closed — no tenant, no query), and
 * by-id writes use `updateMany`/`deleteMany` so a row of another tenant is
 * simply "not found" instead of being modified.
 */
function tenantPrismaRepository(
  n: Names,
  soft: boolean,
  rowType: string,
  mapper: string,
  prismaClient?: PrismaClientRef,
): string {
  const live = soft ? ', deletedAt: null' : ''
  const deleteBody = soft
    ? `const { count } = await this.records.updateMany({
      where: { id, tenantId: requireTenantId(), deletedAt: null },
      data: { deletedAt: new Date() },
    })
    return count > 0`
    : `const { count } = await this.records.deleteMany({ where: { id, tenantId: requireTenantId() } })
    return count > 0`
  const restore = soft
    ? `

  async restore(id: string): Promise<boolean> {
    const { count } = await this.records.updateMany({
      where: { id, tenantId: requireTenantId(), deletedAt: { not: null } },
      data: { deletedAt: null },
    })
    return count > 0
  }`
    : ''
  const client = prismaClient ?? { import: '@prisma/client', type: 'PrismaClient' }
  return `import { createToken } from '@basaltkit/core'
import { db } from '@basaltkit/prisma'
import { requireTenantId } from '@basaltkit/tenancy'
import type { ${client.type} } from '${client.import}'
import type { ${n.pascal}, Create${n.pascal}Input, Update${n.pascal}Input } from './${n.kebab}.schema.js'

// Map the Prisma row (Date columns) to the API type (ISO-string timestamps).
const to${n.pascal} = (r: ${rowType}): ${n.pascal} => ({
${mapper}
})

${repositoryInterface(n, soft)}

/**
 * Prisma-backed, tenant-owned. Requires prismaPlugin configured and a \`${n.pascal}\`
 * model (with \`tenantId\`) in schema.prisma. Every query is scoped to the
 * context tenant; with no tenant resolved it throws TENANT_REQUIRED (400).
 */
export class Prisma${n.pascal}Repository implements ${n.pascal}Repository {
  private get records() {
    return db<${client.type}>().${n.camel}
  }

  async list(): Promise<${n.pascal}[]> {
    return (await this.records.findMany({ where: { tenantId: requireTenantId()${live} } })).map(to${n.pascal})
  }

  async find(id: string): Promise<${n.pascal} | null> {
    const r = await this.records.findFirst({ where: { id, tenantId: requireTenantId()${live} } })
    return r ? to${n.pascal}(r) : null
  }

  async create(input: Create${n.pascal}Input): Promise<${n.pascal}> {
    return to${n.pascal}(await this.records.create({ data: { ...input, tenantId: requireTenantId() } }))
  }

  async update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null> {
    const { count } = await this.records.updateMany({ where: { id, tenantId: requireTenantId()${live} }, data: input })
    return count > 0 ? this.find(id) : null
  }

  async delete(id: string): Promise<boolean> {
    ${deleteBody}
  }${restore}
}

export const ${n.constant}_REPOSITORY = createToken<${n.pascal}Repository>('${n.kebab}.repository')
`
}

function memoryRepository(n: Names, soft: boolean, tenant = false): string {
  const createFields = soft ? 'createdAt: now, updatedAt: now, deletedAt: null' : 'createdAt: now, updatedAt: now'
  const listBody = soft
    ? 'return [...this.items.values()].filter((i) => i.deletedAt === null)'
    : 'return [...this.items.values()]'
  const findBody = soft
    ? `const item = this.items.get(id)
    return item && item.deletedAt === null ? item : null`
    : 'return this.items.get(id) ?? null'
  const updateGuard = soft ? ' || existing.deletedAt !== null' : ''
  const deleteBody = soft
    ? `const existing = this.items.get(id)
    if (!existing || existing.deletedAt !== null) return false
    this.items.set(id, { ...existing, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    return true`
    : 'return this.items.delete(id)'
  const restore = soft
    ? `

  async restore(id: string): Promise<boolean> {
    const existing = this.items.get(id)
    if (!existing || existing.deletedAt === null) return false
    this.items.set(id, { ...existing, deletedAt: null, updatedAt: new Date().toISOString() })
    return true
  }`
    : ''
  const tenancyImport = tenant ? `\nimport { requireTenantId } from '@basaltkit/tenancy'` : ''
  const storage = tenant
    ? `  // Tenant-owned: one partition per tenant. \`requireTenantId()\` fails closed
  // (TENANT_REQUIRED, 400) when no tenant is resolved — never a shared view.
  private readonly byTenant = new Map<string, Map<string, ${n.pascal}>>()

  private get items(): Map<string, ${n.pascal}> {
    const tenantId = requireTenantId()
    let items = this.byTenant.get(tenantId)
    if (!items) {
      items = new Map()
      this.byTenant.set(tenantId, items)
    }
    return items
  }`
    : `  private readonly items = new Map<string, ${n.pascal}>()`
  return `import { randomUUID } from 'node:crypto'
import { createToken } from '@basaltkit/core'${tenancyImport}
import type { ${n.pascal}, Create${n.pascal}Input, Update${n.pascal}Input } from './${n.kebab}.schema.js'

${repositoryInterface(n, soft)}

/** In-memory implementation — pass --prisma to generate a Prisma-backed one. */
export class InMemory${n.pascal}Repository implements ${n.pascal}Repository {
${storage}

  async list(): Promise<${n.pascal}[]> {
    ${listBody}
  }

  async find(id: string): Promise<${n.pascal} | null> {
    ${findBody}
  }

  async create(input: Create${n.pascal}Input): Promise<${n.pascal}> {
    const now = new Date().toISOString()
    const item: ${n.pascal} = { id: randomUUID(), ...input, ${createFields} }
    this.items.set(item.id, item)
    return item
  }

  async update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null> {
    const existing = this.items.get(id)
    if (!existing${updateGuard}) return null
    const updated: ${n.pascal} = { ...existing, ...input, updatedAt: new Date().toISOString() }
    this.items.set(id, updated)
    return updated
  }

  async delete(id: string): Promise<boolean> {
    ${deleteBody}
  }${restore}
}

export const ${n.constant}_REPOSITORY = createToken<${n.pascal}Repository>('${n.kebab}.repository')
`
}

export function repositoryFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  const soft = options.softDelete === true
  return {
    path: `${dir(n)}/${n.kebab}.repository.ts`,
    content: options.prisma
      ? prismaRepository(n, soft, options.prismaClient, options.tenant === true)
      : memoryRepository(n, soft, options.tenant === true),
  }
}

export function serviceFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  const restore = options.softDelete
    ? `

  restore(id: string) {
    return this.repository.restore(id)
  }`
    : ''
  return {
    path: `${dir(n)}/${n.kebab}.service.ts`,
    content: `import { createToken } from '@basaltkit/core'
import type { ${n.pascal}Repository } from './${n.kebab}.repository.js'
import type { Create${n.pascal}Input, Update${n.pascal}Input } from './${n.kebab}.schema.js'

export class ${n.pascal}Service {
  constructor(private readonly repository: ${n.pascal}Repository) {}

  list() {
    return this.repository.list()
  }

  get(id: string) {
    return this.repository.find(id)
  }

  create(input: Create${n.pascal}Input) {
    return this.repository.create(input)
  }

  update(id: string, input: Update${n.pascal}Input) {
    return this.repository.update(id, input)
  }

  remove(id: string) {
    return this.repository.delete(id)
  }${restore}
}

export const ${n.constant}_SERVICE = createToken<${n.pascal}Service>('${n.kebab}.service')
`,
  }
}

export function pluginFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  const repoClass = options.prisma ? `Prisma${n.pascal}Repository` : `InMemory${n.pascal}Repository`
  return {
    path: `${dir(n)}/${n.kebab}.plugin.ts`,
    content: `import { definePlugin } from '@basaltkit/core'
import { ${n.constant}_REPOSITORY, ${repoClass} } from './${n.kebab}.repository.js'
import { ${n.constant}_SERVICE, ${n.pascal}Service } from './${n.kebab}.service.js'

export const ${n.camel}Plugin = definePlugin({
  name: 'app:${n.kebab}',
  register({ container }) {
    container.singleton(${n.constant}_REPOSITORY, () => new ${repoClass}())
    container.singleton(
      ${n.constant}_SERVICE,
      (c) => new ${n.pascal}Service(c.get(${n.constant}_REPOSITORY)),
    )
  },
})
`,
  }
}

/** Prisma model block to paste into schema.prisma (emitted with --prisma). */
export function prismaModelFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  const soft = options.softDelete ? '\n  deletedAt DateTime?' : ''
  const tenantColumn = options.tenant ? '\n  tenantId  String' : ''
  const tenantIndex = options.tenant ? '\n\n  @@index([tenantId])' : ''
  return {
    path: `${dir(n)}/${n.kebab}.prisma`,
    content: `// Add this model to your schema.prisma, then run \`prisma migrate dev\`.
model ${n.pascal} {
  id        String   @id @default(cuid())${tenantColumn}
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt${soft}${tenantIndex}
}
`,
  }
}

export function routesFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  const restoreRoute = options.softDelete
    ? `
  route({
    method: 'POST',
    url: '/${n.pluralKebab}/:id/restore',
    params: z.object({ id: z.string() }),
    async handler({ params, reply }) {
      const restored = await service().restore(params.id)
      if (!restored) throw notFound()
      return reply.code(204).send()
    },
  }),
`
    : ''
  const auth = options.auth !== false
  // Applied to the exported array (not written per route) so every route —
  // including ones added later to the array — is covered.
  const authHelper = auth
    ? `
// Secure by default: every route below requires an authenticated user
// (\`meta.auth\`, enforced by authPlugin — the app refuses to boot without it).
// To make ONE route public, give it \`meta: { auth: false }\` deliberately.
const requireAuth = <R extends { meta?: Record<string, unknown> | undefined }>(r: R): R => ({
  ...r,
  meta: { auth: true, ...r.meta },
})
`
    : `
// PUBLIC: generated with --public — these routes accept anonymous callers.
`
  const authApply = auth ? '.map(requireAuth)' : ''
  return {
    path: `${dir(n)}/${n.kebab}.routes.ts`,
    content: `import { ctx, type Container } from '@basaltkit/core'
import { HttpError, route } from '@basaltkit/fastify'
import { z } from 'zod'
import { ${n.constant}_SERVICE } from './${n.kebab}.service.js'
import { Create${n.pascal}Schema, Update${n.pascal}Schema, ${n.pascal}Schema } from './${n.kebab}.schema.js'

const service = () => (ctx().container as Container).get(${n.constant}_SERVICE)
const notFound = () => new HttpError(404, '${n.constant}_NOT_FOUND', '${n.pascal} not found')
${authHelper}
export const ${n.camel}Routes = [
  route({
    method: 'GET',
    url: '/${n.pluralKebab}',
    response: { 200: z.array(${n.pascal}Schema) },
    async handler() {
      return service().list()
    },
  }),

  route({
    method: 'GET',
    url: '/${n.pluralKebab}/:id',
    params: z.object({ id: z.string() }),
    async handler({ params }) {
      const item = await service().get(params.id)
      if (!item) throw notFound()
      return item
    },
  }),

  route({
    method: 'POST',
    url: '/${n.pluralKebab}',
    body: Create${n.pascal}Schema,
    response: { 201: ${n.pascal}Schema },
    async handler({ body, reply }) {
      return reply.code(201).send(await service().create(body))
    },
  }),

  route({
    method: 'PATCH',
    url: '/${n.pluralKebab}/:id',
    params: z.object({ id: z.string() }),
    body: Update${n.pascal}Schema,
    async handler({ params, body }) {
      const item = await service().update(params.id, body)
      if (!item) throw notFound()
      return item
    },
  }),

  route({
    method: 'DELETE',
    url: '/${n.pluralKebab}/:id',
    params: z.object({ id: z.string() }),
    async handler({ params, reply }) {
      const removed = await service().remove(params.id)
      if (!removed) throw notFound()
      return reply.code(204).send()
    },
  }),
${restoreRoute}]${authApply}
`,
  }
}

export function testFile(n: Names, options: GeneratorOptions = {}): GeneratedFile {
  const auth = options.auth !== false
  const tenant = options.tenant === true
  const coreImport = auth ? `\nimport { definePlugin, ensureMetadata } from '@basaltkit/core'` : ''
  const fastifyImport = auth ? 'fastifyPlugin, HttpError, type RouteGuard' : 'fastifyPlugin'
  const authStub = auth
    ? `
// Stand-in for authPlugin: enforces \`meta.auth\` against the user impersonated
// by actingAs(), so the test proves the routes reject anonymous callers.
const testAuth = definePlugin({
  name: 'test:auth',
  register({ container }) {
    const metadata = ensureMetadata(container)
    const guard: RouteGuard = ({ route, context }) => {
      if (route.meta?.['auth'] === true && !context.user) throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required')
    }
    metadata.add('http:guards', guard)
    metadata.add('http:guarded-meta', 'auth')
  },
})
`
    : ''
  const plugins = auth
    ? `testAuth, ${n.camel}Plugin, fastifyPlugin({ routes: ${n.camel}Routes })`
    : `${n.camel}Plugin, fastifyPlugin({ routes: ${n.camel}Routes })`
  const actor = [auth ? `.actingAs({ id: 'user-1' })` : '', tenant ? `.asTenant('acme')` : ''].join('')
  const anonymous = auth
    ? `

  it('rejects anonymous callers', async () => {
    const app = await boot()
    expect((await app.get('/${n.pluralKebab}'${tenant ? ", { tenant: 'acme' }" : ''})).statusCode).toBe(401)
    expect((await app.post('/${n.pluralKebab}', { name: 'x' }${tenant ? ", { tenant: 'acme' }" : ''})).statusCode).toBe(401)
    await app.shutdown()
  })`
    : ''
  const isolation = tenant
    ? `

  it('keeps each tenant\\'s rows invisible to other tenants', async () => {
    const app = (await boot())${actor}
    const created = await app.post('/${n.pluralKebab}', { name: 'Acme only' })
    const id = created.json().id

    const other = { ${auth ? "user: { id: 'user-2' }, " : ''}tenant: 'globex' }
    expect((await app.get('/${n.pluralKebab}', other)).json()).toHaveLength(0)
    expect((await app.get(\`/${n.pluralKebab}/\${id}\`, other)).statusCode).toBe(404)
    expect((await app.patch(\`/${n.pluralKebab}/\${id}\`, { name: 'Hijacked' }, other)).statusCode).toBe(404)
    expect((await app.delete(\`/${n.pluralKebab}/\${id}\`, other)).statusCode).toBe(404)
    expect((await app.get(\`/${n.pluralKebab}/\${id}\`)).json().name).toBe('Acme only')

    await app.shutdown()
  })`
    : ''
  return {
    path: `tests/${n.kebab}.test.ts`,
    content: `import { describe, expect, it } from 'vitest'${coreImport}
import { ${fastifyImport} } from '@basaltkit/fastify'
import { createTestApp } from '@basaltkit/testing'
import { ${n.camel}Plugin } from '../src/modules/${n.kebab}/${n.kebab}.plugin.js'
import { ${n.camel}Routes } from '../src/modules/${n.kebab}/${n.kebab}.routes.js'
${authStub}
const boot = () =>
  createTestApp({
    plugins: [${plugins}],
  })

describe('${n.kebab} resource', () => {
  it('creates, lists, fetches, updates and deletes', async () => {
    const app = (await boot())${actor}

    const created = await app.post('/${n.pluralKebab}', { name: 'First' })
    expect(created.statusCode).toBe(201)
    const id = created.json().id

    expect((await app.get('/${n.pluralKebab}')).json()).toHaveLength(1)
    expect((await app.get(\`/${n.pluralKebab}/\${id}\`)).json().name).toBe('First')

    const updated = await app.patch(\`/${n.pluralKebab}/\${id}\`, { name: 'Renamed' })
    expect(updated.json().name).toBe('Renamed')

    expect((await app.delete(\`/${n.pluralKebab}/\${id}\`)).statusCode).toBe(204)
    expect((await app.get('/${n.pluralKebab}')).json()).toHaveLength(0)

    await app.shutdown()
  })${anonymous}${isolation}
})
`,
  }
}
