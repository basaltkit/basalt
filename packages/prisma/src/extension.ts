import { BasaltError, tryCtx } from '@basaltkit/core'

export class MissingTenantError extends BasaltError {
  constructor() {
    super(
      'PRISMA_TENANT_MISSING',
      'A tenant-scoped query ran without a tenant in the context. ' +
        "Wrap the call in tenancy.run() or set onMissingTenant: 'bypass'.",
    )
  }
}

/**
 * Raw SQL/command methods ($queryRaw, $executeRaw, …) bypass the model-level
 * tenant scoping entirely, so running one INSIDE a tenant context would read or
 * mutate every tenant's rows. This is thrown to fail closed on that path.
 */
export class RawQueryInTenantContextError extends BasaltError {
  constructor(method: string) {
    super(
      'PRISMA_RAW_IN_TENANT',
      `${method}() is not tenant-scoped and was called inside a tenant context, so it would ` +
        'ignore tenant isolation and touch every tenant\'s rows. Add the tenant predicate ' +
        'yourself and run it outside the tenant context (central/admin code), or set ' +
        "onRawInTenant: 'allow' if you have manually scoped the query.",
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
   * - 'error' (default): throw PRISMA_TENANT_MISSING — fail closed, so a query
   *   that runs without a tenant can never leak/mutate across tenants.
   * - 'bypass': run the query UNSCOPED — opt-in, for explicit central/admin code
   *   paths only (wrap them in a context with no tenant deliberately).
   *
   * @security Defaults to 'error'. Do NOT set 'bypass' globally — it disables
   * tenant isolation whenever a tenant isn't resolved (a forgotten job context,
   * an unauthenticated route), returning every tenant's rows.
   */
  onMissingTenant?: 'bypass' | 'error'
  /**
   * Behavior for raw methods ($queryRaw/$queryRawUnsafe/$executeRaw/
   * $executeRawUnsafe) invoked WHILE a tenant is in scope — these bypass the
   * model-level scoping and would touch every tenant's rows:
   * - 'error' (default): throw PRISMA_RAW_IN_TENANT — fail closed.
   * - 'allow': run the raw query as-is (only for queries you have already
   *   scoped by tenant by hand).
   *
   * Raw queries with NO tenant in scope are always allowed (central/admin code).
   *
   * @security Defaults to 'error'. Do not set 'allow' globally.
   */
  onRawInTenant?: 'allow' | 'error'
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

  // Raw methods bypass model-level scoping. Refuse them when a tenant is in
  // scope (they would ignore isolation); allow them otherwise (central code).
  const rawGuard = (method: string) =>
    async ({ args, query }: { args: unknown; query: (args: unknown) => Promise<unknown> }) => {
      if (options.onRawInTenant !== 'allow' && getTenantId() !== undefined) {
        throw new RawQueryInTenantContextError(method)
      }
      return query(args)
    }

  return {
    name: 'basalt-tenancy',
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
            // Fail closed by default: only an explicit 'bypass' runs unscoped.
            if (options.onMissingTenant !== 'bypass') throw new MissingTenantError()
            return query(args)
          }
          return query(applyTenantScope(operation, args, tenantId, field))
        },
      },
      // Client-level raw operations (Prisma extends these top-level, not under
      // $allModels) — guarded so raw SQL can't silently escape tenant scoping.
      $queryRaw: rawGuard('$queryRaw'),
      $queryRawUnsafe: rawGuard('$queryRawUnsafe'),
      $executeRaw: rawGuard('$executeRaw'),
      $executeRawUnsafe: rawGuard('$executeRawUnsafe'),
    },
  }
}
