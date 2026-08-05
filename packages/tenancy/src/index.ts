import {
  createToken,
  definePlugin,
  ensureMetadata,
  runWithContext,
  tryCtx,
  type HookBus,
} from '@machize/core'
import type { ResolutionRequest, TenantRef, TenantResolver } from './resolvers.js'
import {
  TenancyNotResolvedError,
  TenantNotFoundError,
  type Tenant,
  type TenantSource,
} from './tenant.js'

export {
  MemoryTenantSource,
  TenancyNotResolvedError,
  TenantNotFoundError,
  type Tenant,
  type TenantSource,
} from './tenant.js'
export {
  subdomainResolver,
  domainResolver,
  headerResolver,
  routeResolver,
  type TenantResolver,
  type TenantRef,
  type ResolutionRequest,
} from './resolvers.js'

declare module '@machize/core' {
  interface RequestContext {
    /** The tenant of the current request/job, set by tenancy. */
    tenant?: Tenant
  }
  interface MachizeHooks {
    /** Emitted whenever execution enters a tenant context. */
    'tenancy:switched': { tenant: Tenant }
  }
}

export class Tenancy {
  constructor(
    private readonly source: TenantSource,
    private readonly resolvers: TenantResolver[],
    private readonly hooks?: HookBus,
  ) {}

  /** The tenant of the active context, if any. */
  current(): Tenant | undefined {
    return tryCtx()?.tenant
  }

  async find(id: string): Promise<Tenant | null> {
    return this.source.find(id)
  }

  /** Runs the resolvers in order; the first ref that loads a tenant wins. */
  async resolve(request: ResolutionRequest): Promise<Tenant | null> {
    for (const resolver of this.resolvers) {
      const ref = await resolver(request)
      if (!ref) continue
      const tenant = await this.load(ref)
      if (tenant) return tenant
    }
    return null
  }

  /**
   * Runs `fn` inside the tenant's context (preserving the surrounding
   * context) and emits 'tenancy:switched'.
   */
  async run<T>(tenantOrId: Tenant | string, fn: () => T | Promise<T>): Promise<T> {
    const tenant =
      typeof tenantOrId === 'string' ? await this.source.find(tenantOrId) : tenantOrId
    if (!tenant) throw new TenantNotFoundError(tenantOrId as string)

    return runWithContext({ ...tryCtx(), tenant }, async () => {
      await this.hooks?.emit('tenancy:switched', { tenant })
      return fn()
    })
  }

  /** Runs `fn` once per tenant, with bounded concurrency — bulk maintenance. */
  async forEach(
    fn: (tenant: Tenant) => void | Promise<void>,
    options: { concurrency?: number } = {},
  ): Promise<void> {
    if (!this.source.list) {
      throw new TenantNotFoundError('(list not supported by this TenantSource)')
    }
    const tenants = await this.source.list()
    const concurrency = Math.max(1, options.concurrency ?? 5)
    let index = 0
    const workers = Array.from({ length: Math.min(concurrency, tenants.length) }, async () => {
      while (index < tenants.length) {
        const tenant = tenants[index++] as Tenant
        await this.run(tenant, () => fn(tenant))
      }
    })
    await Promise.all(workers)
  }

  private async load(ref: TenantRef): Promise<Tenant | null> {
    if ('id' in ref) return this.source.find(ref.id)
    return this.source.findByDomain ? this.source.findByDomain(ref.domain) : null
  }
}

export const TENANCY = createToken<Tenancy>('tenancy')

export interface TenancyPluginOptions {
  source: TenantSource
  resolvers: TenantResolver[]
  /** Reject requests without a tenant (404 TENANCY_NOT_RESOLVED). Default: false. */
  required?: boolean
}

export function tenancyPlugin(options: TenancyPluginOptions) {
  return definePlugin({
    name: 'machize:tenancy',
    register({ container, hooks }) {
      container.singleton(TENANCY, () => new Tenancy(options.source, options.resolvers, hooks))

      // Request enricher consumed by the HTTP adapter: resolves the tenant,
      // attaches it to the context and fires the switch hook.
      ensureMetadata(container).add(
        'http:enrichers',
        async ({
          request,
          context,
        }: {
          request: { headers?: ResolutionRequest['headers']; params?: unknown; url?: string }
          context: { tenant?: Tenant }
          container: unknown
        }) => {
          const tenancy = container.get(TENANCY)
          const tenant = await tenancy.resolve({
            headers: request.headers ?? {},
            params: (request.params ?? {}) as Record<string, string>,
            ...(request.url !== undefined ? { url: request.url } : {}),
          })
          if (!tenant) {
            if (options.required) throw new TenancyNotResolvedError()
            return
          }
          context.tenant = tenant
          await hooks.emit('tenancy:switched', { tenant })
        },
      )
    },
  })
}
