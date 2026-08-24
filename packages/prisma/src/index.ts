import {
  createToken,
  definePlugin,
  ensureMetadata,
  BasaltError,
  tryCtx,
} from '@basaltkit/core'
import { TenantClientPool } from './pool.js'
import type { ShardRouter } from './sharding.js'
import { schemaUrl, tenantSchema } from './schema.js'

export {
  tenancyExtension,
  applyTenantScope,
  MissingTenantError,
  RawQueryInTenantContextError,
  type TenancyExtensionOptions,
} from './extension.js'
export { TenantClientPool, type TenantClientPoolOptions } from './pool.js'
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
  tenantSchema,
  schemaUrl,
  provisionTenantSchema,
  InvalidTenantSchemaError,
  type TenantSchemaOptions,
  type SchemaProvisioner,
} from './schema.js'
export {
  migrateTenants,
  prismaMigrator,
  type MigrateTarget,
  type MigrateFn,
  type MigrateTenantsOptions,
  type TenantMigrationResult,
  type PrismaMigratorOptions,
} from './migrate.js'
export {
  tenantMigrateCommand,
  type TenantMigrateCommandConfig,
} from './migrate-command.js'
export {
  prismaSyncCommand,
  extractSchemaBlocks,
  type PrismaSyncCommandOptions,
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
}

export function prismaPlugin<TClient = unknown>(options: PrismaPluginOptions<TClient>) {
  return definePlugin({
    name: 'basalt:prisma',
    register({ container, hooks }) {
      // Schema-per-tenant is sugar over the per-tenant pool: build a client
      // whose URL carries the tenant's schema.
      const schemaConfig = options.schemaPerTenant
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

      const clientFor = async (tenantId: string | undefined): Promise<unknown> => {
        if (resolveClient && tenantId !== undefined) return resolveClient(tenantId)
        if (pool) return tenantId === undefined ? options.client : pool.get(tenantId)
        return options.client
      }

      // HTTP requests: attach the client to the request context.
      ensureMetadata(container).add(
        'http:enrichers',
        async ({ context }: { context: { tenant?: { id: string }; db?: unknown } }) => {
          const client = await clientFor(context.tenant?.id)
          if (client !== undefined) context.db = client
        },
      )

      // tenancy.run() / workers: attach when execution enters a tenant.
      hooks.on('tenancy:switched', async (payload) => {
        const { tenant } = payload as { tenant: { id: string } }
        const context = tryCtx()
        if (!context) return
        const client = await clientFor(tenant.id)
        if (client !== undefined) context.db = client
      })
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
