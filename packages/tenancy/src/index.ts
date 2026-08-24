import {
  createToken,
  definePlugin,
  ensureMetadata,
  runWithContext,
  tryCtx,
  type Container,
  type HookBus,
} from '@basaltkit/core'
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

declare module '@basaltkit/core' {
  interface RequestContext {
    /** The tenant of the current request/job, set by tenancy. */
    tenant?: Tenant
  }
  interface BasaltHooks {
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
  /**
   * Per-tenant migration hook for `basalt tenant:migrate`. The framework iterates
   * tenants and runs this inside each one's context; you provide the DB-specific
   * work (e.g. `prisma migrate deploy` against the tenant's schema).
   */
  onMigrate?: (tenant: Tenant) => void | Promise<void>
  /** Per-tenant seed hook for `basalt tenant:seed`, run inside each tenant's context. */
  onSeed?: (tenant: Tenant) => void | Promise<void>
}

export function tenancyPlugin(options: TenancyPluginOptions) {
  return definePlugin({
    name: 'basalt:tenancy',
    register({ container, hooks }) {
      container.singleton(TENANCY, () => new Tenancy(options.source, options.resolvers, hooks))
      registerTenantCommands(container, options)

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

type Io = {
  log(m: string): void
  error(m: string): void
  table(rows: Record<string, unknown>[]): void
}
type CmdCtx = { container: Container; io: Io; args: string[]; flags: Record<string, string | boolean> }

/**
 * Registers `tenant:list|create|migrate|seed|run` into the CLI command bucket.
 * Registered structurally (no hard @basaltkit/cli dep). Commands resolve the
 * Tenancy service lazily so they use whatever source the app configured.
 */
function registerTenantCommands(container: Container, options: TenancyPluginOptions): void {
  const tenancy = () => container.get(TENANCY)
  const add = (command: { name: string; description: string; handle: (ctx: CmdCtx) => unknown }) =>
    ensureMetadata(container).add('commands', command)

  add({
    name: 'tenant:list',
    description: 'List all tenants',
    async handle({ io }) {
      if (!options.source.list) {
        io.error('The configured TenantSource does not implement list().')
        return 1
      }
      const tenants = await options.source.list()
      if (tenants.length === 0) {
        io.log('No tenants.')
        return
      }
      io.table(tenants.map((t) => ({ id: t.id, ...pickScalars(t) })))
    },
  })

  add({
    name: 'tenant:create',
    description: 'Create a tenant: tenant:create <id> [--name=… --domain=…]',
    async handle({ io, args, flags }) {
      const id = args[0]
      if (!id) {
        io.error('Usage: basalt tenant:create <id> [--name=… --anyField=…]')
        return 1
      }
      if (!options.source.create) {
        io.error('The configured TenantSource does not implement create().')
        return 1
      }
      const fields: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(flags)) fields[key] = value
      const tenant = await options.source.create({ id, ...fields })
      io.log(`Created tenant "${tenant.id}".`)
    },
  })

  const runHook = async (
    io: Io,
    only: string | undefined,
    hook: ((tenant: Tenant) => void | Promise<void>) | undefined,
    label: string,
  ): Promise<number | void> => {
    if (!hook) {
      io.error(`No ${label} hook configured. Pass tenancyPlugin({ on${label[0]!.toUpperCase()}${label.slice(1)}: … }).`)
      return 1
    }
    if (only) {
      const tenant = await options.source.find(only)
      if (!tenant) {
        io.error(`Tenant "${only}" not found.`)
        return 1
      }
      await tenancy().run(tenant, () => hook(tenant))
      io.log(`Ran ${label} for "${only}".`)
      return
    }
    let count = 0
    await tenancy().forEach(async (tenant) => {
      await hook(tenant)
      count++
    })
    io.log(`Ran ${label} for ${count} tenant(s).`)
  }

  add({
    name: 'tenant:migrate',
    description: 'Run the per-tenant migration hook (all tenants, or --tenant=<id>)',
    handle: ({ io, flags }) =>
      runHook(io, typeof flags['tenant'] === 'string' ? flags['tenant'] : undefined, options.onMigrate, 'migrate'),
  })

  add({
    name: 'tenant:seed',
    description: 'Run the per-tenant seed hook (all tenants, or --tenant=<id>)',
    handle: ({ io, flags }) =>
      runHook(io, typeof flags['tenant'] === 'string' ? flags['tenant'] : undefined, options.onSeed, 'seed'),
  })

  add({
    name: 'tenant:run',
    description: "Run another command inside a tenant's context: tenant:run <id> <command> [args]",
    async handle({ container: c, io, args, flags }) {
      const [id, sub, ...rest] = args
      if (!id || !sub) {
        io.error('Usage: basalt tenant:run <tenantId> <command> [args…]')
        return 1
      }
      const tenant = await options.source.find(id)
      if (!tenant) {
        io.error(`Tenant "${id}" not found.`)
        return 1
      }
      const commands = ensureMetadata(c).get<{ name: string; handle: (ctx: CmdCtx) => unknown }>('commands')
      const target = commands.find((cmd) => cmd.name === sub)
      if (!target) {
        io.error(`Unknown command "${sub}". (tenant:run resolves plugin-registered commands.)`)
        return 1
      }
      return tenancy().run(tenant, () => target.handle({ container: c, io, args: rest, flags }))
    },
  })
}

/** Keeps only primitive tenant fields for the list table (drops objects/arrays). */
function pickScalars(tenant: Tenant): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(tenant)) {
    if (key === 'id') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

export {
  CustomDomains,
  MemoryDomainStore,
  DomainTakenError,
  DomainNotFoundError,
  type CustomDomain,
  type DomainStore,
  type DnsVerification,
  type CustomDomainsOptions,
} from './custom-domains.js'
