import {
  createToken,
  definePlugin,
  ensureMetadata,
  MachizeError,
  tryCtx,
} from '@machize/core'
import { TenantClientPool } from './pool.js'
import { schemaUrl, tenantSchema } from './schema.js'

export {
  tenancyExtension,
  applyTenantScope,
  MissingTenantError,
  type TenancyExtensionOptions,
} from './extension.js'
export { TenantClientPool, type TenantClientPoolOptions } from './pool.js'
export {
  tenantSchema,
  schemaUrl,
  provisionTenantSchema,
  InvalidTenantSchemaError,
  type TenantSchemaOptions,
  type SchemaProvisioner,
} from './schema.js'

declare module '@machize/core' {
  interface RequestContext {
    /** Database client of the current request/tenant, set by prismaPlugin. */
    db?: unknown
  }
}

export class DbUnavailableError extends MachizeError {
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
  /** Eviction callback for the per-tenant pool (e.g. client.$disconnect()). */
  destroy?: (client: TClient, tenantId: string) => void | Promise<void>
  /** Max simultaneously open per-tenant clients. Default: 10 */
  max?: number
}

export function prismaPlugin<TClient = unknown>(options: PrismaPluginOptions<TClient>) {
  return definePlugin({
    name: 'machize:prisma',
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

      const clientFor = async (tenantId: string | undefined): Promise<unknown> => {
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
      const client = container.has(DB) ? (container.get(DB) as { $disconnect?: () => Promise<void> }) : undefined
      await client?.$disconnect?.()
    },
  })
}
