import {
  createToken,
  definePlugin,
  ensureMetadata,
  MachizeError,
  tryCtx,
} from '@machize/core'
import { TenantClientPool } from './pool.js'

export {
  tenancyExtension,
  applyTenantScope,
  MissingTenantError,
  type TenancyExtensionOptions,
} from './extension.js'
export { TenantClientPool, type TenantClientPoolOptions } from './pool.js'

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
  /** Eviction callback for the per-tenant pool (e.g. client.$disconnect()). */
  destroy?: (client: TClient, tenantId: string) => void | Promise<void>
  /** Max simultaneously open per-tenant clients. Default: 10 */
  max?: number
}

export function prismaPlugin<TClient = unknown>(options: PrismaPluginOptions<TClient>) {
  return definePlugin({
    name: 'machize:prisma',
    register({ container, hooks }) {
      const pool = options.forTenant
        ? new TenantClientPool<TClient>({
            create: options.forTenant,
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
