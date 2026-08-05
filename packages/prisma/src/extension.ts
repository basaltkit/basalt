import { MachizeError, tryCtx } from '@machize/core'

export class MissingTenantError extends MachizeError {
  constructor() {
    super(
      'PRISMA_TENANT_MISSING',
      'A tenant-scoped query ran without a tenant in the context. ' +
        "Wrap the call in tenancy.run() or set onMissingTenant: 'bypass'.",
    )
  }
}

type QueryArgs = Record<string, unknown>

/**
 * Operations whose `where` receives the tenant filter. This includes the
 * unique-where operations (findUnique/update/delete): since Prisma 5 a
 * where-unique input accepts extra non-unique fields as additional filters,
 * so injecting the tenant field narrows the match to the current tenant
 * (a cross-tenant row simply "isn't found").
 */
const WHERE_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
])

/**
 * Pure transformation: returns the args scoped to the tenant. Reads and
 * writes are both covered — a caller cannot escape the current tenant, and
 * new rows always carry the tenant field.
 */
export function applyTenantScope(
  operation: string,
  args: QueryArgs | undefined,
  tenantId: string,
  field: string,
): QueryArgs {
  const input = args ?? {}

  if (WHERE_OPERATIONS.has(operation)) {
    // spread order forces the tenant filter — callers cannot override it
    return scopeWhere(input, tenantId, field)
  }

  if (operation === 'create') {
    const data = (input['data'] as QueryArgs | undefined) ?? {}
    return { ...input, data: { ...data, [field]: tenantId } }
  }

  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    const data = input['data']
    const rows = Array.isArray(data) ? data : data === undefined ? [] : [data]
    return {
      ...input,
      data: rows.map((row) => ({ ...(row as QueryArgs), [field]: tenantId })),
    }
  }

  if (operation === 'upsert') {
    // filter the match to this tenant AND stamp the created row; the update
    // branch is left as-is (updating the tenant field would be wrong)
    const create = (input['create'] as QueryArgs | undefined) ?? {}
    return {
      ...scopeWhere(input, tenantId, field),
      create: { ...create, [field]: tenantId },
    }
  }

  return input
}

function scopeWhere(input: QueryArgs, tenantId: string, field: string): QueryArgs {
  const where = (input['where'] as QueryArgs | undefined) ?? {}
  return { ...input, where: { ...where, [field]: tenantId } }
}

export interface TenancyExtensionOptions {
  /** Column holding the tenant id. Default: 'tenantId' */
  tenantField?: string
  /** How to obtain the current tenant id. Default: reads ctx().tenant.id */
  getTenantId?: () => string | undefined
  /**
   * Behavior when there is no tenant in scope:
   * - 'bypass' (default): run the query unscoped — central/admin context
   * - 'error': throw PRISMA_TENANT_MISSING — strictest isolation
   */
  onMissingTenant?: 'bypass' | 'error'
}

const defaultTenantId = (): string | undefined => {
  const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
  return tenant?.id
}

/**
 * Prisma client extension for the shared-database tenancy mode:
 *
 * const db = new PrismaClient().$extends(tenancyExtension())
 *
 * Every query on every model is scoped to ctx().tenant at call time —
 * app code just writes `db.project.findMany()`.
 */
export function tenancyExtension(options: TenancyExtensionOptions = {}) {
  const field = options.tenantField ?? 'tenantId'
  const getTenantId = options.getTenantId ?? defaultTenantId

  return {
    name: 'machize-tenancy',
    query: {
      $allModels: {
        async $allOperations({
          operation,
          args,
          query,
        }: {
          operation: string
          args: QueryArgs
          query: (args: QueryArgs) => Promise<unknown>
        }) {
          const tenantId = getTenantId()
          if (!tenantId) {
            if (options.onMissingTenant === 'error') throw new MissingTenantError()
            return query(args)
          }
          return query(applyTenantScope(operation, args, tenantId, field))
        },
      },
    },
  }
}
