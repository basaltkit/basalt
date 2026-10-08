import {
  createToken,
  definePlugin,
  ensureMetadata,
  BasaltError,
  tryCtx,
} from '@basaltkit/core'
import { TenantClientPool, type TenantClientLease } from './pool.js'
import type { ShardRouter } from './sharding.js'
import { schemaUrl, tenantSchema, assertSchemaPerTenantSupported } from './schema.js'
import { assertMigrated, type AssertMigratedOptions } from './assert-migrated.js'

export {
  tenancyExtension,
  applyTenantScope,
  MissingTenantError,
  RawQueryInTenantContextError,
  UnscopedOperationError,
  CrossTenantWriteError,
  tenantTransaction,
  type TenancyExtensionOptions,
  type RlsExtensionOptions,
  type TenancyExtension,
  type TenancyRlsExtension,
  type TenantTransactionOptions,
  type TenantTransactionClient,
} from './extension.js'
export {
  TenantClientPool,
  TenantPoolExhaustedError,
  type TenantClientPoolOptions,
  type TenantClientLease,
} from './pool.js'
export {
  assertMigrated,
  redactCredentials,
  DatabaseNotMigratedError,
  DatabasePlaneMixedError,
  type AssertMigratedOptions,
} from './assert-migrated.js'
export { readReplica, type ReadReplicaOptions } from './replicas.js'
export {
  ShardRouter,
  fnv1aShard,
  type ShardHash,
  type ShardRouterOptions,
} from './sharding.js'
export {
  rlsPolicySql,
  setTenantConfigSql,
  tenantConfigParams,
  DEFAULT_TENANT_SETTING,
  type RlsPolicyOptions,
} from './rls.js'
export {
  rlsSearchFunctionSql,
  RLS_SEARCH_TENANT_COLUMN,
  RLS_SEARCH_ID_COLUMN,
  RLS_SEARCH_SCORE_COLUMN,
  RLS_SEARCH_TOTAL_COLUMN,
  type RlsSearchFunctionSqlOptions,
  type RlsSearchColumn,
  type RlsSearchQueryParser,
} from './rls-search.js'
export {
  crossTenantScanSql,
  crossTenantScan,
  crossTenantSweep,
  CrossTenantScanInTenantError,
  CrossTenantScanShapeError,
  CROSS_TENANT_ID_COLUMN,
  CROSS_TENANT_ROW_COLUMN,
  type CrossTenantScanSqlOptions,
  type CrossTenantScanColumn,
  type CrossTenantScanArgs,
  type CrossTenantScanRow,
  type CrossTenantCursor,
  type CrossTenantPage,
  type CrossTenantSweepOptions,
  type CrossTenantSweepResult,
} from './cross-tenant.js'
export {
  tenantSchema,
  schemaUrl,
  provisionTenantSchema,
  countTenantTables,
  canInspect,
  providerOf,
  assertSchemaPerTenantSupported,
  InvalidTenantSchemaError,
  EmptyTenantSchemaError,
  SchemaPerTenantUnsupportedError,
  type TenantSchemaOptions,
  type SchemaProvisioner,
  type SchemaInspector,
  type DatabaseProvider,
} from './schema.js'
export {
  migrateTenants,
  prismaMigrateArgs,
  prismaMigrator,
  type MigrateTarget,
  type MigrateFn,
  type MigrateTenantsOptions,
  type TenantMigrationResult,
  type PrismaMigratorOptions,
} from './migrate.js'
export {
  type CommandDefinition,
  type CommandContext,
  type CommandIo,
} from './command.js'
export {
  describeDbError,
  type DbErrorDiagnosis,
  type DescribeDbErrorOptions,
} from './describe-db-error.js'
export {
  dbStatusCommand,
  parseMigrateStatus,
  prismaStatusArgs,
  npxPrismaRunner,
  type DbStatusCommandConfig,
  type MigrationState,
  type MigrationStatus,
  type PrismaCliRunner,
  type PrismaStatusTarget,
} from './status-command.js'
export {
  tenantMigrateCommand,
  type TenantMigrateCommandConfig,
} from './migrate-command.js'
export {
  prismaSyncCommand,
  planeConfigTs,
  generateOnlyRootConfigTs,
  type PrismaSyncTarget,
  type PrismaSyncCommandOptions,
  extractSchemaBlocks,
} from './sync-command.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** Database client of the current request/tenant, set by prismaPlugin. */
    db?: unknown
  }
}

export class DbUnavailableError extends BasaltError {
  constructor() {
    super(
      'DB_UNAVAILABLE',
      'No database client in the current context. Are you inside a request or tenancy.run(), ' +
        'with prismaPlugin configured?',
    )
  }
}

/** The database client of the active context: `db<PrismaClient>().project.findMany()`. */
export function db<T = unknown>(): T {
  const client = tryCtx()?.db
  if (client === undefined) throw new DbUnavailableError()
  return client as T
}

/**
 * A client that resolves from the context on every access.
 *
 * The `-prisma` stores take a client when they are built — at boot — and hold
 * it for the life of the process. Under schema-per-tenant the right client is
 * only known per request, so what they must hold is not a client but a way to
 * reach one:
 *
 * ```ts
 * const tenantDb = tenantClient<PrismaClient>()
 * const auth = prismaAuthStores(tenantDb)
 * const perms = prismaAccessStore(tenantDb)
 * ```
 *
 * Every application doing this wrote the same proxy by hand, because the
 * pattern was tolerated — `ensureModel` catches the "not yet resolvable" case
 * explicitly — but never supplied. Writing it wrong does not raise an error: it
 * points every tenant at whatever client was passed instead, which in the usual
 * mistake is the central one. Tenant data, silently, in the wrong schema.
 *
 * Not a substitute for `db()`: inside a request, call `db()`. This is for the
 * handful of places that must be **constructed** before a request exists.
 */
export function tenantClient<T extends object = Record<string, unknown>>(): T {
  return new Proxy({} as T, {
    // `Reflect` and not a bare read so accessor properties on the client see
    // the same receiver they would when read directly. (It does not affect
    // `this` for `client.$transaction()`: a call's `this` is always the object
    // the property was read from, i.e. this proxy, whatever the trap does.)
    get: (_target, prop, receiver) => Reflect.get(db<object>(), prop, receiver),
    // A `get` trap alone answers `'user' in client` with false and
    // `Object.keys(client)` with [] — wrong answers, not errors — to any store
    // that probes the client before using it.
    has: (_target, prop) => Reflect.has(db<object>(), prop),
    // `ownKeys` needs a matching descriptor, or `Object.keys()` drops every
    // key it reports; `configurable: true` keeps the proxy invariant happy on
    // an empty target.
    ownKeys: () => Reflect.ownKeys(db<object>()),
    getOwnPropertyDescriptor: (_target, prop) => ({
      ...Reflect.getOwnPropertyDescriptor(db<object>(), prop),
      configurable: true,
    }),
  })
}

/** `idleMs` of the pool prismaPlugin builds — see PrismaPluginOptions.idleMs. */
const PLUGIN_POOL_IDLE_MS = 1_000

/**
 * How long prismaPlugin holds a client for a caller that never says when it is
 * done (see `heldClient`): the 30s the time-based `get()` used to give.
 */
const LEGACY_HOLD_MS = 30_000

export const DB = createToken<unknown>('db')
export const DB_POOL = createToken<TenantClientPool<unknown>>('db:pool')

export interface PrismaPluginOptions<TClient = unknown> {
  /**
   * Shared-database mode: one client for everyone, typically already
   * $extends(tenancyExtension()) so queries scope themselves via ctx().
   */
  client?: TClient
  /** Database-per-tenant mode: factory creating the client for a tenant id. */
  forTenant?: (tenantId: string) => TClient | Promise<TClient>
  /**
   * Schema-per-tenant mode: one database, one PostgreSQL schema per tenant.
   * Each tenant gets a client whose connection URL carries `?schema=<name>`,
   * so Prisma sets the search_path at connect time (reliable, unlike
   * per-request search_path switching on a shared pool).
   */
  schemaPerTenant?: {
    /** Base connection URL (the `schema` param is set per tenant). */
    url: string
    /** Builds a client from a URL, e.g. `(url) => new PrismaClient({ datasourceUrl: url })`. */
    createClient: (url: string) => TClient | Promise<TClient>
    /** Schema name prefix. Default: 'tenant_'. */
    prefix?: string
  }
  /**
   * Sharding mode: a fixed set of databases, routed by tenant id. Shard clients
   * are long-lived and shared by many tenants (no eviction) — use for scale-out,
   * not database-per-tenant isolation.
   */
  shards?: ShardRouter<TClient>
  /**
   * Low-level escape hatch: resolve the client for a tenant yourself, bypassing
   * the pool. `shards` is sugar over this. Called per request/switch.
   */
  resolveClient?: (tenantId: string) => TClient | Promise<TClient>
  /** Eviction callback for the per-tenant pool (e.g. client.$disconnect()). */
  destroy?: (client: TClient, tenantId: string) => void | Promise<void>
  /** Max simultaneously open per-tenant clients. Default: 10 */
  max?: number
  /**
   * Per-tenant pool: how long (ms) a client stays reserved for its tenant
   * after its last use, before it may be evicted for another tenant — a grace
   * period, not a request budget. HTTP requests and `tenancy.run()` hold their
   * client with a lease for exactly their duration, however long that is, so
   * this only decides how quickly an idle tenant's slot is reused. Default:
   * 1_000 (the standalone `TenantClientPool` keeps 30_000 for its time-based
   * `get()` callers). See `TenantClientPoolOptions.idleMs`.
   */
  idleMs?: number
  /**
   * Per-tenant pool: how long (ms) a request for a new tenant waits for a slot
   * when all `max` clients are in use, before failing with
   * `TenantPoolExhaustedError` (503). Default: 10_000.
   */
  acquireTimeoutMs?: number
  /**
   * Fail the boot unless the shared `client`'s database is migrated: checks
   * that `_prisma_migrations` exists (and, with `{ tables }`, those tables
   * too). Catches booting against the wrong database — e.g. a shell that
   * exported another project's DATABASE_URL — at startup instead of as a
   * P2021 on the first request. The error names the database and host, never
   * the credentials. Needs `client`. Default: off.
   */
  assertMigrated?: boolean | AssertMigratedOptions
}

export function prismaPlugin<TClient = unknown>(options: PrismaPluginOptions<TClient>) {
  return definePlugin({
    name: 'basalt:prisma',
    register({ container, hooks }) {
      // Schema-per-tenant is sugar over the per-tenant pool: build a client
      // whose URL carries the tenant's schema.
      const schemaConfig = options.schemaPerTenant
      // Fail at BOOT, not at the first tenant: the URL is known here, so a
      // MySQL/SQLite connection configured for schema-per-tenant is a
      // configuration error we can name now rather than a CREATE SCHEMA syntax
      // error much later, far from its cause.
      if (schemaConfig) assertSchemaPerTenantSupported(schemaConfig.url)
      const createTenantClient: ((tenantId: string) => TClient | Promise<TClient>) | undefined =
        options.forTenant ??
        (schemaConfig
          ? (tenantId) =>
              schemaConfig.createClient(
                schemaUrl(
                  schemaConfig.url,
                  tenantSchema(tenantId, schemaConfig.prefix ? { prefix: schemaConfig.prefix } : {}),
                ),
              )
          : undefined)

      const pool = createTenantClient
        ? new TenantClientPool<TClient>({
            create: createTenantClient,
            ...(options.destroy ? { destroy: options.destroy } : {}),
            ...(options.max !== undefined ? { max: options.max } : {}),
            // Requests and tenancy.run() lease their client for exactly their
            // duration, so the idle window is only a grace period. With the
            // pool's 30s default, every tenant served in the last 30s kept its
            // slot: the (max+1)th distinct tenant in that window waited, then
            // got a 503 PRISMA_POOL_EXHAUSTED, while nothing was in use.
            idleMs: options.idleMs ?? PLUGIN_POOL_IDLE_MS,
            ...(options.acquireTimeoutMs !== undefined
              ? { acquireTimeoutMs: options.acquireTimeoutMs }
              : {}),
          })
        : undefined

      if (options.client !== undefined) {
        container.singleton(DB, () => options.client as unknown)
      }
      if (pool) {
        container.singleton(DB_POOL, () => pool as TenantClientPool<unknown>)
      }

      const resolveClient =
        options.resolveClient ??
        (options.shards ? (tenantId: string) => options.shards!.for(tenantId) : undefined)

      // A hand-out for callers that never say when they are done: a pipeline
      // without disposers (`@basaltkit/http` < 2.8), a `tenancy:switched`
      // without `via` (`@basaltkit/tenancy` < 3.2, a hand-rolled emit). The
      // client is held for LEGACY_HOLD_MS — the 30s the pool's `get()` gave
      // before leasing existed — then returned on its own, whatever the
      // plugin's (1s) `idleMs`: those callers were sized for 30s.
      const heldClient = async (tenantId: string): Promise<TClient> => {
        const lease = await pool!.acquire(tenantId)
        const timer = setTimeout(() => lease.release(), LEGACY_HOLD_MS)
        ;(timer as { unref?: () => void }).unref?.()
        return lease.client
      }

      const clientFor = async (tenantId: string | undefined): Promise<unknown> => {
        if (resolveClient && tenantId !== undefined) return resolveClient(tenantId)
        if (pool) return tenantId === undefined ? options.client : heldClient(tenantId)
        return options.client
      }

      // The pooled path LEASES: a client in use by a request or a
      // tenancy.run() can never be evicted, and is returned the moment that
      // work ends — so the pool's capacity is the number of tenants active at
      // the same time, not the number seen within `idleMs`. Leases are kept
      // per context object: tenancy.run() spreads the surrounding context into
      // a NEW one, so a nested run gets its own and the outer context — and
      // its `db` — are left untouched.
      const leased = pool !== undefined && resolveClient === undefined
      const leases = new WeakMap<object, Map<string, TenantClientLease<TClient>>>()
      const leaseInto = async (
        slot: Map<string, TenantClientLease<TClient>>,
        tenantId: string,
      ): Promise<TClient> => {
        const held = slot.get(tenantId)
        if (held) return held.client
        const lease = await pool!.acquire(tenantId)
        slot.set(tenantId, lease)
        return lease.client
      }
      const releaseAll = (slot: Map<string, TenantClientLease<TClient>>): void => {
        for (const lease of slot.values()) lease.release()
        slot.clear()
      }
      /**
       * The request's lease slot, created on first use — by whichever of our
       * enricher and the tenancy enricher's 'tenancy:switched' comes first, so
       * registration order never matters and a request holds exactly one
       * lease per tenant. Released by the request's own disposer sink
       * (`ctx().onDispose`, `@basaltkit/http` >= 2.8) once the response ended,
       * even when a later enricher or guard rejects the request.
       */
      const requestSlot = (
        context: object,
        onDispose: (disposer: () => void) => void,
      ): Map<string, TenantClientLease<TClient>> => {
        let slot = leases.get(context)
        if (!slot) {
          const own = new Map<string, TenantClientLease<TClient>>()
          leases.set(context, own)
          // Forgotten on release: a lease taken after the response ended
          // (background work) opens a new slot, which a finished sink
          // releases at once instead of leaking it.
          onDispose(() => {
            releaseAll(own)
            if (leases.get(context) === own) leases.delete(context)
          })
          slot = own
        }
        return slot
      }
      /** The sink of a pipeline that honours disposers, if this context has one. */
      const disposerSink = (context: object) => {
        const sink = (context as { onDispose?: unknown }).onDispose
        return typeof sink === 'function' ? (sink as (disposer: () => void) => void) : undefined
      }

      // HTTP requests: attach the client to the request context.
      ensureMetadata(container).add(
        'http:enrichers',
        async ({ context }: { context: { tenant?: { id: string }; db?: unknown; onDispose?: unknown } }) => {
          const tenantId = context.tenant?.id
          const sink = leased ? disposerSink(context) : undefined
          if (!sink) {
            // Not leased (shared client, sharding, resolveClient), or a
            // pipeline that would drop our disposer: lease nothing we cannot
            // give back.
            const client = await clientFor(tenantId)
            if (client !== undefined) context.db = client
            return undefined
          }
          const slot = requestSlot(context, sink)
          if (tenantId === undefined) {
            if (options.client !== undefined) context.db = options.client
          } else {
            context.db = await leaseInto(slot, tenantId)
          }
          return undefined
        },
      )

      // tenancy.run() / workers / the tenancy request enricher: attach when
      // execution enters a tenant.
      hooks.on('tenancy:switched', async (payload) => {
        const { tenant, via } = payload as { tenant: { id: string }; via?: 'run' | 'http' }
        const context = tryCtx()
        if (!context) return
        if (leased) {
          let slot = leases.get(context)
          if (!slot && via === 'run') {
            // Released on 'tenancy:exited', which run() always emits.
            slot = new Map()
            leases.set(context, slot)
          }
          // An HTTP request (the tenancy enricher, or a switch from a handler):
          // lease now, so an enricher between tenancy and us already sees
          // ctx().db, and hand the release to the request.
          const sink = slot ? undefined : disposerSink(context)
          if (sink) slot = requestSlot(context, sink)
          if (slot) {
            context.db = await leaseInto(slot, tenant.id)
            return
          }
          // Nobody will say when this context ends (older tenancy, older
          // http, a hand-rolled emit): the time-based hand-out below.
        }
        const client = await clientFor(tenant.id)
        // tenancy.run() copies the surrounding context, so `db` may still be
        // the OUTER tenant's client. With no client for this tenant, drop it:
        // db() then fails closed instead of writing into the other database.
        if (client !== undefined) context.db = client
        else delete context.db
      })

      hooks.on('tenancy:exited', () => {
        const context = tryCtx()
        const slot = context ? leases.get(context) : undefined
        if (!slot) return
        releaseAll(slot)
        leases.delete(context!)
      })
    },
    async boot() {
      if (!options.assertMigrated) return
      if (options.client === undefined) {
        throw new BasaltError(
          'PRISMA_CONFIG',
          'prismaPlugin: assertMigrated needs `client` (the shared/central database client) to check.',
        )
      }
      await assertMigrated(
        options.client as Parameters<typeof assertMigrated>[0],
        options.assertMigrated === true ? {} : options.assertMigrated,
      )
    },
    async shutdown({ container }) {
      if (container.has(DB_POOL)) await container.get(DB_POOL).destroyAll()
      if (options.shards) {
        await Promise.all(
          options.shards
            .all()
            .map((c) => (c as { $disconnect?: () => Promise<void> }).$disconnect?.()),
        )
      }
      const client = container.has(DB) ? (container.get(DB) as { $disconnect?: () => Promise<void> }) : undefined
      await client?.$disconnect?.()
    },
  })
}
