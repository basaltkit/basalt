import { names } from '@basaltkit/generator/resource'
import type { PlanField } from '../plan/types.js'
import { canonicalType, domainFields, type CanonicalType } from './fields.js'

export interface RepositoryOptions {
  softDelete: boolean
  /** Scope every query by tenantId from context (portable — no global extension needed). */
  tenantScoped: boolean
  /** Keep the generator's base `name` column. */
  keepName: boolean
}

/** TypeScript type of a Prisma row column for the mapper's parameter. */
function rowType(t: CanonicalType): string {
  switch (t) {
    case 'Int':
    case 'Float':
      return 'number'
    case 'Boolean':
      return 'boolean'
    case 'DateTime':
      return 'Date'
    case 'Json':
      return 'unknown'
    case 'String':
      return 'string'
  }
}

/** Expression mapping a Prisma row column to the API type (dates → ISO strings). */
function mapExpr(field: string, t: CanonicalType): string {
  return t === 'DateTime' ? `r.${field}.toISOString()` : `r.${field}`
}

/**
 * Render a complete Prisma repository for a resource — replacing the generator's,
 * which (a) only maps id/name/timestamps (dropping domain fields) and (b) relies
 * on the global tenancy extension to stamp tenantId. This one maps every domain
 * field and, when tenant-scoped, scopes tenantId explicitly from the request
 * context, so it works even on a raw client shared with non-tenant models.
 */
export function renderPrismaRepository(name: string, fields: PlanField[], options: RepositoryOptions): string {
  const n = names(name)
  const { softDelete, tenantScoped, keepName } = options

  const bodyFields: Array<{ name: string; canon: CanonicalType; values?: string[] }> = []
  if (keepName) bodyFields.push({ name: 'name', canon: 'String' })
  for (const f of domainFields(fields)) {
    bodyFields.push({ name: f.name, canon: canonicalType(f.type), ...(f.enum && f.enum.length > 0 ? { values: f.enum } : {}) })
  }

  // Enum columns are stored as String; the mapper narrows them to the union.
  const colType = (f: { canon: CanonicalType; values?: string[] }): string => (f.values ? 'string' : rowType(f.canon))
  const colExpr = (f: { name: string; canon: CanonicalType; values?: string[] }): string =>
    f.values ? `r.${f.name} as ${f.values.map((v) => `'${v}'`).join(' | ')}` : mapExpr(f.name, f.canon)

  const rowTypeEntries = [
    'id: string',
    ...bodyFields.map((f) => `${f.name}: ${colType(f)}`),
    'createdAt: Date',
    'updatedAt: Date',
    ...(softDelete ? ['deletedAt: Date | null'] : []),
  ].join('; ')

  const mapLines = [
    '  id: r.id,',
    ...bodyFields.map((f) => `  ${f.name}: ${colExpr(f)},`),
    '  createdAt: r.createdAt.toISOString(),',
    '  updatedAt: r.updatedAt.toISOString(),',
    ...(softDelete ? ['  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,'] : []),
  ].join('\n')

  const tenant = (soft: boolean): string =>
    ['id', tenantScoped ? 'tenantId: currentTenantId()' : '', soft && softDelete ? 'deletedAt: null' : '']
      .filter(Boolean)
      .join(', ')

  const listWhere = [tenantScoped ? 'tenantId: currentTenantId()' : '', softDelete ? 'deletedAt: null' : '']
    .filter(Boolean)
    .join(', ')

  const createData = tenantScoped ? '{ ...input, tenantId: currentTenantId() }' : 'input'

  const updateMethod = tenantScoped
    ? `  async update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null> {
    const res = await this.records.updateMany({ where: { ${tenant(true)} }, data: input })
    return res.count > 0 ? this.find(id) : null
  }`
    : `  async update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null> {
    try {
      return to${n.pascal}(await this.records.update({ where: { id }, data: input }))
    } catch {
      return null
    }
  }`

  const deleteMethod = renderDelete(tenantScoped, softDelete)
  const restoreMethod = softDelete ? `\n\n${renderRestore(tenantScoped)}` : ''
  const interfaceRestore = softDelete ? `\n  restore(id: string): Promise<boolean>` : ''

  const coreImport = tenantScoped ? 'createToken, tryCtx' : 'createToken'
  const httpImport = tenantScoped ? `\nimport { HttpError } from '@basaltkit/fastify'` : ''
  const tenantHelper = tenantScoped
    ? `
// Tenant-scoped model. Scoped by tenantId explicitly from the request context, so
// it works even on a raw client shared with non-tenant models (no global extension).
// A missing tenant is a client error (400) — never a silent 500.
const currentTenantId = (): string => {
  const id = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
  if (!id) throw new HttpError(400, 'TENANT_REQUIRED', 'No tenant in context — send the x-tenant-id header (or resolve a tenant first).')
  return id
}
`
    : ''

  return `import { ${coreImport} } from '@basaltkit/core'
import { db } from '@basaltkit/prisma'${httpImport}
import type { PrismaClient } from '@prisma/client'
import type { ${n.pascal}, Create${n.pascal}Input, Update${n.pascal}Input } from './${n.kebab}.schema.js'
${tenantHelper}
// Map the Prisma row (Date columns) to the API type (ISO-string timestamps).
const to${n.pascal} = (r: { ${rowTypeEntries} }): ${n.pascal} => ({
${mapLines}
})

export interface ${n.pascal}Repository {
  list(): Promise<${n.pascal}[]>
  find(id: string): Promise<${n.pascal} | null>
  create(input: Create${n.pascal}Input): Promise<${n.pascal}>
  update(id: string, input: Update${n.pascal}Input): Promise<${n.pascal} | null>
  delete(id: string): Promise<boolean>${interfaceRestore}
}

export class Prisma${n.pascal}Repository implements ${n.pascal}Repository {
  private get records() {
    return db<PrismaClient>().${n.camel}
  }

  async list(): Promise<${n.pascal}[]> {
    return (await this.records.findMany(${listWhere ? `{ where: { ${listWhere} } }` : ''})).map(to${n.pascal})
  }

  async find(id: string): Promise<${n.pascal} | null> {
    const r = await this.records.findFirst({ where: { ${tenant(true)} } })
    return r ? to${n.pascal}(r) : null
  }

  async create(input: Create${n.pascal}Input): Promise<${n.pascal}> {
    return to${n.pascal}(await this.records.create({ data: ${createData} }))
  }

${updateMethod}

${deleteMethod}${restoreMethod}
}

export const ${n.constant}_REPOSITORY = createToken<${n.pascal}Repository>('${n.kebab}.repository')
`
}

function renderDelete(tenantScoped: boolean, softDelete: boolean): string {
  if (tenantScoped) {
    const where = softDelete
      ? 'id, tenantId: currentTenantId(), deletedAt: null'
      : 'id, tenantId: currentTenantId()'
    const op = softDelete
      ? `updateMany({ where: { ${where} }, data: { deletedAt: new Date() } })`
      : `deleteMany({ where: { ${where} } })`
    return `  async delete(id: string): Promise<boolean> {
    const res = await this.records.${op}
    return res.count > 0
  }`
  }
  const op = softDelete
    ? `update({ where: { id }, data: { deletedAt: new Date() } })`
    : `delete({ where: { id } })`
  return `  async delete(id: string): Promise<boolean> {
    try {
      await this.records.${op}
      return true
    } catch {
      return false
    }
  }`
}

function renderRestore(tenantScoped: boolean): string {
  if (tenantScoped) {
    return `  async restore(id: string): Promise<boolean> {
    const res = await this.records.updateMany({ where: { id, tenantId: currentTenantId() }, data: { deletedAt: null } })
    return res.count > 0
  }`
  }
  return `  async restore(id: string): Promise<boolean> {
    try {
      await this.records.update({ where: { id }, data: { deletedAt: null } })
      return true
    } catch {
      return false
    }
  }`
}
