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

/** Operations whose `where` receives the tenant filter. */
const WHERE_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
])

/**
 * Pure transformation: returns the args scoped to the tenant.
 *
 * Unique-where operations (findUnique, update, delete, upsert) are left
 * untouched in v0 — Prisma requires the exact unique input there. Model them
 * with a composite unique key including the tenant field.
 */
export function applyTenantScope(
  operation: string,
  args: QueryArgs | undefined,
  tenantId: string,
  field: string,
): QueryArgs {
  const input = args ?? {}

  if (WHERE_OPERATIONS.has(operation)) {
    const where = (input['where'] as QueryArgs | undefined) ?? {}
    // spread order forces the tenant filter — callers cannot override it
    return { ...input, where: { ...where, [field]: tenantId } }
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

  return input
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
