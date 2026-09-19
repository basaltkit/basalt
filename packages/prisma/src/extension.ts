import { BasaltError, tryCtx } from '@basaltkit/core'
import { DEFAULT_TENANT_SETTING, setTenantConfigSql, tenantConfigParams } from './rls.js'

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

/**
 * Thrown when a tenant is in scope and the extension is asked to run an
 * operation it does not know how to scope (a Prisma operation added after this
 * code was written, for example). Fails closed: an operation that cannot be
 * scoped is refused rather than run across every tenant.
 */
export class UnscopedOperationError extends BasaltError {
  constructor(operation: string) {
    super(
      'PRISMA_UNSCOPED_OPERATION',
      `${operation} cannot be tenant-scoped by basalt-tenancy and was refused inside a tenant ` +
        'context. Run it outside the tenant context (central/admin code) with the tenant ' +
        'predicate added by hand.',
    )
  }
}

/**
 * Thrown when a write inside a tenant context tries to set the tenant field of
 * an existing row to another tenant (moving the row out of the tenant).
 */
export class CrossTenantWriteError extends BasaltError {
  constructor(field: string) {
    super(
      'PRISMA_CROSS_TENANT_WRITE',
      `An update inside a tenant context tried to change "${field}" to another tenant. ` +
        'Rows cannot be moved between tenants through the tenant-scoped client.',
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
  'delete',
  'deleteMany',
])

/** Filtered like WHERE_OPERATIONS, and their `data` is checked for nested writes. */
const UPDATE_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn'])

/**
 * Model-level raw operations (MongoDB). They take a raw filter/pipeline the
 * extension cannot rewrite reliably, so they are treated like `$queryRaw`.
 */
const RAW_MODEL_OPERATIONS = new Set(['findRaw', 'aggregateRaw'])

/** Keys of a Prisma nested (relation) write, e.g. `{ project: { connect: { id } } }`. */
const NESTED_WRITE_KEYS = new Set([
  'create',
  'createMany',
  'connect',
  'connectOrCreate',
  'upsert',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'set',
  'disconnect',
])

function isPlainObject(value: unknown): value is QueryArgs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * `Prisma.skip`: Prisma drops a key holding it, exactly like `undefined`.
 * Detected by shape so this package does not import `@prisma/client`.
 */
function isPrismaSkip(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !isPlainObject(value) &&
    typeof (value as { ifUndefined?: unknown }).ifUndefined === 'function'
  )
}

/**
 * Keys Prisma actually reads: a key whose value is `undefined` or
 * `Prisma.skip` is dropped by Prisma, so it must not change how the input is
 * classified (otherwise `{ connect, extra: undefined }` would hide a relation
 * write from the scoper and run unscoped).
 */
function presentKeys(value: QueryArgs): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined && !isPrismaSkip(value[key]))
}

/** A value shaped like a relation write: every key is a nested-write operation. */
function isRelationWrite(value: unknown): value is QueryArgs {
  if (!isPlainObject(value)) return false
  const keys = presentKeys(value)
  return keys.length > 0 && keys.every((key) => NESTED_WRITE_KEYS.has(key))
}

/** Applies `fn` to one value or to each element of an array. */
function each(value: unknown, fn: (item: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(fn) : fn(value)
}

/**
 * Tenant-scoping of args, including relation writes nested inside `data`:
 * nested creates are stamped with the tenant, and every nested where
 * (connect, set, update, delete, …) is narrowed to the tenant so a relation
 * cannot be linked to, or modify, another tenant's row.
 */
class Scoper {
  constructor(
    private readonly tenantId: string,
    private readonly field: string,
  ) {}

  /** Adds the tenant filter to a where object (non-objects are left as-is). */
  where = (where: unknown): unknown =>
    isPlainObject(where) ? { ...where, [this.field]: this.tenantId } : where

  /** Create data: nested writes scoped, tenant field forced (spread order). */
  createData = (data: unknown): unknown => {
    const input = isPlainObject(data) ? data : {}
    return { ...this.relations(input), [this.field]: this.tenantId }
  }

  /** Update data: the tenant field may not change, nested writes are scoped. */
  updateData = (data: unknown): unknown => {
    if (!isPlainObject(data)) return data
    this.assertTenantField(data)
    return this.relations(data)
  }

  private assertTenantField(data: QueryArgs): void {
    if (!(this.field in data)) return
    const value = data[this.field]
    if (value === undefined || isPrismaSkip(value) || value === this.tenantId) return
    if (isPlainObject(value) && Object.keys(value).length === 1 && value['set'] === this.tenantId) return
    throw new CrossTenantWriteError(this.field)
  }

  private relations(data: QueryArgs): QueryArgs {
    const out: QueryArgs = {}
    for (const [key, value] of Object.entries(data)) {
      out[key] = key !== this.field && isRelationWrite(value) ? this.relationWrite(value) : value
    }
    return out
  }

  private relationWrite(ops: QueryArgs): QueryArgs {
    const out: QueryArgs = {}
    for (const [op, value] of Object.entries(ops)) {
      switch (op) {
        case 'create':
          out[op] = each(value, this.createData)
          break
        case 'createMany':
          out[op] = isPlainObject(value)
            ? { ...value, data: each(value['data'], this.createData) }
            : value
          break
        case 'connectOrCreate':
          out[op] = each(value, (item) =>
            isPlainObject(item)
              ? { ...item, where: this.where(item['where']), create: this.createData(item['create']) }
              : item,
          )
          break
        case 'upsert':
          // to-many upserts carry a where-unique; to-one upserts accept an
          // optional where filter, which is added so a foreign related row
          // (reached through a foreign-key scalar) is not updated
          out[op] = each(value, (item) =>
            isPlainObject(item)
              ? {
                  ...item,
                  where: this.where(item['where'] ?? {}),
                  create: this.createData(item['create']),
                  update: this.updateData(item['update']),
                }
              : item,
          )
          break
        case 'update':
          out[op] = each(value, (item) => {
            if (!isPlainObject(item)) return item
            // `{ where, data }` (to-many, or to-one with a filter) or, for a
            // to-one relation, the update data itself — rewritten to the
            // `{ where, data }` form so the related row must be this tenant's.
            const wrapped =
              isPlainObject(item['data']) &&
              presentKeys(item).every((key) => key === 'where' || key === 'data')
            const data = wrapped ? item['data'] : item
            const where = wrapped ? (item['where'] ?? {}) : {}
            return { where: this.where(where), data: this.updateData(data) }
          })
          break
        case 'updateMany':
          out[op] = each(value, (item) =>
            isPlainObject(item)
              ? { ...item, where: this.where(item['where'] ?? {}), data: this.updateData(item['data']) }
              : item,
          )
          break
        case 'delete':
          // to-one `delete: true` becomes a tenant filter (a foreign related
          // row is then "not found" instead of deleted)
          out[op] = value === true ? { [this.field]: this.tenantId } : each(value, this.where)
          break
        case 'connect':
        case 'set':
        case 'deleteMany':
        case 'disconnect':
          // where-unique / filter inputs; booleans (to-one disconnect) pass through
          out[op] = each(value, this.where)
          break
        default:
          out[op] = value
      }
    }
    return out
  }
}

/**
 * Pure transformation: returns the args scoped to the tenant. Reads and
 * writes are both covered — a caller cannot escape the current tenant, new
 * rows (including nested creates) always carry the tenant field, relation
 * writes are narrowed to the tenant, and an update cannot change the tenant
 * field. An operation it does not know throws `UnscopedOperationError`
 * (fail closed) instead of running unscoped.
 */
export function applyTenantScope(
  operation: string,
  args: QueryArgs | undefined,
  tenantId: string,
  field: string,
): QueryArgs {
  const input = args ?? {}
  const scoper = new Scoper(tenantId, field)

  if (WHERE_OPERATIONS.has(operation)) {
    // spread order forces the tenant filter — callers cannot override it
    return scopeWhere(input, tenantId, field)
  }

  if (UPDATE_OPERATIONS.has(operation)) {
    return { ...scopeWhere(input, tenantId, field), data: scoper.updateData(input['data'] ?? {}) }
  }

  if (operation === 'create') {
    return { ...input, data: scoper.createData(input['data']) }
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
    // branch may not change the tenant field
    return {
      ...scopeWhere(input, tenantId, field),
      create: scoper.createData(input['create']),
      update: scoper.updateData(input['update'] ?? {}),
    }
  }

  throw new UnscopedOperationError(operation)
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
   * $executeRawUnsafe/$queryRawTyped/$runCommandRaw, every other client-level
   * operation, and the MongoDB model-level findRaw/aggregateRaw) invoked WHILE
   * a tenant is in scope — these bypass the model-level scoping and would
   * touch every tenant's rows:
   * - 'error' (default): throw PRISMA_RAW_IN_TENANT — fail closed.
   * - 'allow': run the raw query as-is (only for queries you have already
   *   scoped by tenant by hand).
   *
   * Raw queries with NO tenant in scope are always allowed (central/admin code).
   *
   * @security Defaults to 'error'. Do not set 'allow' globally.
   */
  onRawInTenant?: 'allow' | 'error'
  /**
   * Postgres Row-Level Security, applied automatically. With `rls` on, every
   * model operation in tenant scope runs as a batch transaction whose first
   * statement is `set_config('<setting>', <tenantId>, true)` — so the policies
   * installed by `rlsPolicySql` filter the rows in the database too, even for
   * a query the application layer cannot scope (an `include` that follows a
   * cross-tenant foreign key, for example).
   *
   * Costs: one extra statement per operation (same round-trip batch), and
   * every tenant-scoped operation becomes a (short) transaction. Operations
   * already inside a transaction are NOT wrapped again — open interactive
   * transactions with {@link tenantTransaction}, and lead a batch
   * `$transaction([...])` with the `set_config` statement yourself.
   *
   * `true` uses the default setting `app.tenant_id`.
   */
  rls?: boolean | RlsExtensionOptions
}

export interface RlsExtensionOptions {
  /** Postgres setting (GUC) the RLS policies read. Default: 'app.tenant_id'. */
  setting?: string
}

/** Minimal shape of the Prisma client this module drives (no @prisma/client import). */
interface RawCapableClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): PromiseLike<unknown>
  $transaction(arg: unknown, options?: unknown): Promise<unknown>
  $extends(extension: unknown): unknown
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
 * app code just writes `db.project.findMany()`. Operations it cannot scope
 * (raw queries, unknown operations) are refused inside a tenant context.
 *
 * Limits: a foreign-key SCALAR (`data: { projectId }`) is not checked against
 * the tenant — use composite foreign keys `(tenantId, id)` and/or RLS
 * (`rlsPolicySql`) as the database-level guarantee.
 */
/**
 * `true` when a raw call is exactly the statement that sets the RLS tenant
 * setting to the tenant ALREADY in scope (`setTenantConfigSql()` with
 * `tenantConfigParams(tenantId, setting)`). It reads no rows and grants
 * nothing the scoping does not already enforce, so the raw guard lets it
 * through — it is how a transaction you open yourself tells Postgres which
 * tenant is active.
 */
function isOwnTenantConfig(operation: string, args: unknown, tenantId: string, setting: string): boolean {
  if (operation !== '$executeRawUnsafe' && operation !== '$queryRawUnsafe') return false
  if (!Array.isArray(args) || args.length !== 3) return false
  const [sql, name, value] = args as unknown[]
  return (
    typeof sql === 'string' &&
    sql.trim().toLowerCase() === setTenantConfigSql() &&
    name === setting &&
    value === tenantId
  )
}

/** The transaction a Prisma query callback runs in, if any (`__internalParams.transaction`). */
function transactionOf(params: { __internalParams?: unknown }): unknown {
  const internal = params.__internalParams as { transaction?: unknown } | undefined
  return internal?.transaction
}

function rlsSetting(rls: TenancyExtensionOptions['rls']): string | undefined {
  if (!rls) return undefined
  const setting = (rls === true ? undefined : rls.setting) ?? DEFAULT_TENANT_SETTING
  // validates the name eagerly: a bad setting fails at boot, not per query
  tenantConfigParams('validate', setting)
  return setting
}

type TenancyQueryHooks = ReturnType<typeof buildQueryHooks>

/** The extension object form (no RLS). */
export interface TenancyExtension {
  name: 'basalt-tenancy'
  query: TenancyQueryHooks
}

/**
 * The function form Prisma's `$extends` also accepts (`rls` on): it receives
 * the client being extended, which it needs to open the `set_config` batch.
 * Typed as identity so `$extends` keeps the client's own type.
 */
export type TenancyRlsExtension = <C>(client: C) => C

/**
 * Prisma client extension for the shared-database tenancy mode:
 *
 * const db = new PrismaClient().$extends(tenancyExtension())
 *
 * Every query on every model is scoped to ctx().tenant at call time —
 * app code just writes `db.project.findMany()`. Operations it cannot scope
 * (raw queries, unknown operations) are refused inside a tenant context.
 *
 * Limits: a foreign-key SCALAR (`data: { projectId }`) is not checked against
 * the tenant — use composite foreign keys `(tenantId, id)` and/or RLS
 * (`rlsPolicySql` + `rls: true`) as the database-level guarantee.
 */
export function tenancyExtension(
  options?: TenancyExtensionOptions & { rls?: false | undefined },
): TenancyExtension
export function tenancyExtension(
  options: TenancyExtensionOptions & { rls: true | RlsExtensionOptions },
): TenancyRlsExtension
export function tenancyExtension(options?: TenancyExtensionOptions): TenancyExtension | TenancyRlsExtension
export function tenancyExtension(
  options: TenancyExtensionOptions = {},
): TenancyExtension | TenancyRlsExtension {
  const setting = rlsSetting(options.rls)
  if (setting === undefined) {
    return { name: 'basalt-tenancy', query: buildQueryHooks(options, undefined, undefined) }
  }
  return (<C>(client: C): C =>
    (client as unknown as RawCapableClient).$extends({
      name: 'basalt-tenancy',
      query: buildQueryHooks(options, client as unknown as RawCapableClient, setting),
    }) as C) as TenancyRlsExtension
}

function buildQueryHooks(
  options: TenancyExtensionOptions,
  /** The client being extended — present only with `rls` on. */
  base: RawCapableClient | undefined,
  /** The RLS setting — present only with `rls` on. */
  rlsSettingName: string | undefined,
) {
  const field = options.tenantField ?? 'tenantId'
  const getTenantId = options.getTenantId ?? defaultTenantId
  // The own-tenant set_config statement is allowed through the raw guard
  // with or without `rls`: it is the documented way to open a transaction
  // for hand-written RLS wiring (and what tenantTransaction() sends).
  const configSetting = rlsSettingName ?? DEFAULT_TENANT_SETTING

  // Raw methods bypass model-level scoping. Refuse them when a tenant is in
  // scope (they would ignore isolation); allow them otherwise (central code).
  const guardRaw = (method: string, args?: unknown) => {
    if (options.onRawInTenant === 'allow') return
    const tenantId = getTenantId()
    if (tenantId === undefined) return
    if (isOwnTenantConfig(method, args, tenantId, configSetting)) return
    throw new RawQueryInTenantContextError(method)
  }

  // With rls: run the operation after set_config, in one batch transaction,
  // so the setting is on the same connection and transaction-local. An
  // operation already inside a transaction (interactive or batch) is left
  // alone — it cannot be nested, and its transaction must set the tenant
  // first (tenantTransaction() does; a batch leads with set_config).
  const run = (
    tenantId: string,
    params: { __internalParams?: unknown },
    pending: unknown,
  ): Promise<unknown> | unknown => {
    if (!base || !rlsSettingName || transactionOf(params) !== undefined) return pending
    return base
      .$transaction([
        base.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(tenantId, rlsSettingName)),
        pending,
      ])
      .then((results) => (results as unknown[])[1])
  }

  return {
    $allModels: {
      $allOperations(params: {
        model?: string
        operation: string
        args: QueryArgs
        query: (args: QueryArgs) => Promise<unknown>
        __internalParams?: unknown
      }): Promise<unknown> {
        const { model, operation, args, query } = params
        try {
          const tenantId = getTenantId()
          if (!tenantId) {
            // Fail closed by default: only an explicit 'bypass' runs unscoped.
            if (options.onMissingTenant !== 'bypass') throw new MissingTenantError()
            return query(args)
          }
          if (RAW_MODEL_OPERATIONS.has(operation)) {
            guardRaw(model ? `${model}.${operation}` : operation)
            return query(args)
          }
          // throws UnscopedOperationError for an operation it cannot scope
          return run(tenantId, params, query(applyTenantScope(operation, args, tenantId, field))) as Promise<unknown>
        } catch (error) {
          return Promise.reject(error)
        }
      },
    },
    // Every client-level operation ($queryRaw, $executeRaw, $queryRawTyped,
    // $runCommandRaw and any future one) bypasses model scoping, so ALL of
    // them are guarded here rather than an allow-list of known raw methods.
    // Model operations also reach this callback; they are scoped above.
    // Not `async`: the query's own (Prisma) promise is returned untouched so
    // it can still take part in a batch $transaction.
    $allOperations({
      model,
      operation,
      args,
      query,
    }: {
      model?: string
      operation: string
      args: unknown
      query: (args: unknown) => Promise<unknown>
    }): Promise<unknown> {
      try {
        if (model === undefined) guardRaw(operation, args)
        return query(args)
      } catch (error) {
        return Promise.reject(error)
      }
    },
  }
}

export interface TenantTransactionOptions {
  /** Tenant to activate. Default: the extension's default source, ctx().tenant.id. */
  tenantId?: string
  /** Postgres setting the RLS policies read. Default: 'app.tenant_id'. */
  setting?: string
  /** Passed through to Prisma's interactive `$transaction` (isolationLevel, maxWait, timeout). */
  transaction?: Record<string, unknown>
}

/**
 * The Prisma interactive-transaction client: the client minus the methods
 * Prisma denies inside a transaction.
 */
export type TenantTransactionClient<C> = Omit<
  C,
  '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'
>

/**
 * Opens an interactive transaction with the RLS tenant already set on ITS
 * connection: `set_config('app.tenant_id', <tenant>, true)` runs first, then
 * `fn(tx)`. Pass the tenant-scoped client (`$extends(tenancyExtension(...))`)
 * — `tx` stays tenant-scoped, and every statement in `fn` is filtered by the
 * RLS policies too.
 *
 *   await tenantTransaction(db, async (tx) => {
 *     const invoice = await tx.invoice.create({ data })
 *     await tx.invoiceLine.createMany({ data: lines(invoice.id) })
 *   })
 *
 * Use `tx` inside `fn`: the outer client is not part of the transaction.
 * Throws `MissingTenantError` with no tenant in scope.
 */
export async function tenantTransaction<C, R>(
  client: C,
  fn: (tx: TenantTransactionClient<C>) => Promise<R>,
  options: TenantTransactionOptions = {},
): Promise<R> {
  const tenantId = options.tenantId ?? defaultTenantId()
  if (!tenantId) throw new MissingTenantError()
  const params = tenantConfigParams(tenantId, options.setting ?? DEFAULT_TENANT_SETTING)
  const db = client as unknown as RawCapableClient
  return (await db.$transaction(async (tx: RawCapableClient) => {
    await tx.$executeRawUnsafe(setTenantConfigSql(), ...params)
    return fn(tx as unknown as TenantTransactionClient<C>)
  }, options.transaction)) as R
}
