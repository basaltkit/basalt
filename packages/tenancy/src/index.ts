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
  TenantCreateUnsupportedError,
  TenantNotReadyError,
  isTenantReady,
  type Tenant,
  type TenantSource,
  type TenantStatus,
} from './tenant.js'

export {
  MemoryTenantSource,
  TenancyNotResolvedError,
  TenantNotFoundError,
  TenantCreateUnsupportedError,
  TenantNotReadyError,
  isTenantReady,
  type Tenant,
  type TenantSource,
  type TenantStatus,
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
export {
  requireTenant,
  requireTenantId,
  tenantScoped,
  TenantRequiredError,
} from './scoped.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** The tenant of the current request/job, set by tenancy. */
    tenant?: Tenant
  }
  interface BasaltHooks {
    /** Emitted whenever execution enters a tenant context. */
    'tenancy:switched': { tenant: Tenant }
    /**
     * A tenant was created AND provisioned — emitted by `tenancy.create()`
     * after `onProvision` has resolved, so a listener may assume the tenant's
     * storage exists and is usable (send the welcome email, seed demo data,
     * notify the admin panel).
     *
     * It does NOT fire if provisioning threw. That is deliberate: a listener
     * that reacts to a half-built tenant is worse than one that never runs.
     */
    'tenancy:created': { tenant: Tenant }
  }
}

export class Tenancy {
  constructor(
    private readonly source: TenantSource,
    private readonly resolvers: TenantResolver[],
    private readonly hooks?: HookBus,
    private readonly onProvision?: (tenant: Tenant) => void | Promise<void>,
    /** 'deferred' → `create()` returns before provisioning; see `provision()`. */
    private readonly provisionMode: 'inline' | 'deferred' = 'inline',
  ) {}

  /** The tenant of the active context, if any. */
  current(): Tenant | undefined {
    return tryCtx()?.tenant
  }

  async find(id: string): Promise<Tenant | null> {
    return this.source.find(id)
  }

  /**
   * Registers a tenant and brings its storage into existence.
   *
   * Use this rather than `source.create()` directly. The source only persists
   * the record; a tenant whose row exists but whose schema does not is
   * immediately routable by `subdomainResolver`/`domainResolver` and fails on
   * its very first request with a raw database error. Going through here runs
   * `onProvision` before anyone can reach it.
   *
   * `onProvision` runs INSIDE the new tenant's context, like `onMigrate` and
   * `onSeed`, so `ctx().tenant` and any tenant-scoped client resolve correctly.
   * Entering the context opens no connection by itself, so provisioning work on
   * an admin connection (`CREATE SCHEMA`) is still fine.
   *
   * If provisioning throws, the error propagates and `tenancy:created` does not
   * fire — but **the tenant record has already been written**, because the
   * source persisted it first. That half-state is not rolled back: deleting is
   * not something every `TenantSource` can do, and a failed delete on top of a
   * failed provision loses the evidence. Provisioning is expected to be
   * idempotent so that a retry finishes the job.
   */
  async create(tenant: Tenant): Promise<Tenant> {
    // `create` when the source has it, `save` otherwise. The two durable
    // sources (tenancy-prisma, tenancy-sqlite) expose only `save`, an upsert
    // with the same signature — so requiring `create` would have limited this
    // whole flow to MemoryTenantSource, i.e. to tests.
    const persist = this.source.create ?? this.source.save
    if (!persist) throw new TenantCreateUnsupportedError()

    // Nothing to provision means nothing to wait for and nothing to gate on.
    // Stamping a status here would mark the record `provisioning` forever,
    // because nothing would ever clear it.
    if (!this.onProvision) {
      const created = await persist.call(this.source, tenant)
      await this.hooks?.emit('tenancy:created', { tenant: created })
      return created
    }

    const created = await persist.call(this.source, { ...tenant, status: 'provisioning' })
    // Deferred: the record exists and is marked, so the resolver already
    // answers 503 for it. A job calls `provision(id)` to finish the work.
    if (this.provisionMode === 'deferred') return created
    return this.provision(created)
  }

  /**
   * Runs `onProvision` for a tenant and flips its status to `ready` — or
   * `failed`, then rethrows.
   *
   * Public because background provisioning happens in ANOTHER PROCESS. A job
   * handler cannot receive a closure from the process that created the tenant,
   * so the worker re-enters here with the id and the app's own `onProvision`:
   *
   * ```ts
   * defineJob({
   *   name: 'tenant.provision',
   *   handle: ({ id }) => ctx().container.get(TENANCY).provision(id),
   * })
   * ```
   *
   * Idempotent by requirement, not by construction: `onProvision` may run again
   * after a failure, so write it with `CREATE SCHEMA IF NOT EXISTS` and
   * `migrate deploy`.
   */
  async provision(tenantOrId: Tenant | string): Promise<Tenant> {
    const tenant =
      typeof tenantOrId === 'string' ? await this.source.find(tenantOrId) : tenantOrId
    if (!tenant) throw new TenantNotFoundError(tenantOrId as string)
    if (!this.onProvision) return tenant

    try {
      await this.run(tenant, () => this.onProvision!(tenant))
    } catch (error) {
      // Marked, not deleted: the record is the only record that this tenant was
      // attempted at all, and the resolver now answers 503 instead of letting
      // requests hit storage that does not exist.
      await this.writeStatus(tenant, 'failed')
      throw error
    }
    const ready = await this.writeStatus(tenant, 'ready')
    await this.hooks?.emit('tenancy:created', { tenant: ready })
    return ready
  }

  /** Persists a status transition, preferring the upsert when the source has one. */
  private async writeStatus(tenant: Tenant, status: TenantStatus): Promise<Tenant> {
    const write = this.source.save ?? this.source.create
    const next = { ...tenant, status }
    if (!write) return next
    return write.call(this.source, next)
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

/**
 * Whether this request must carry a tenant.
 *
 * Exported for tests; the path is compared without its query string, so
 * `/health` still matches `/health?probe=1`.
 */
export function isTenantRequired(
  required: TenancyPluginOptions['required'],
  url: string | undefined,
  meta?: Record<string, unknown> | undefined,
): boolean {
  // The route's own declaration wins over any app-wide default: `meta.tenant`
  // sits next to the handler, so a central route stays central through a
  // rename, and a reviewer sees the decision without opening the app config.
  const declared = meta?.['tenant']
  if (declared === false) return false
  if (declared === true) return true
  if (!required) return false
  if (required === true) return true
  const path = pathOf(url)
  return !required.except.some((pattern) =>
    typeof pattern === 'string' ? pattern === path : pattern.test(path),
  )
}

/**
 * The pathname, whatever shape the adapter reports.
 *
 * Fastify and Express give a path with its query (`/health?probe=1`); Hono
 * gives an absolute URL (`http://host/health`). Comparing the raw string would
 * quietly match on two adapters and never on the third.
 */
function pathOf(url: string | undefined): string {
  const raw = url ?? ''
  try {
    return new URL(raw).pathname
  } catch {
    return raw.split('?')[0] ?? ''
  }
}

export interface TenancyPluginOptions {
  source: TenantSource
  resolvers: TenantResolver[]
  /**
   * Reject requests without a tenant (404 `TENANCY_NOT_RESOLVED`). Default: false.
   *
   * `true` applies to every route, which is rarely what an app can live with:
   * a health check has no tenant to send, and neither does a landing page or a
   * public pricing endpoint. Pass `{ except }` to exempt those paths — exact
   * strings or regular expressions, matched against the path without its query
   * string.
   *
   * ```ts
   * required: { except: ['/', '/health', /^\/public\//] }
   * ```
   *
   * Exempting a path only lifts the tenant requirement. Auth, subscription and
   * every other guard still apply.
   *
   * A route can also declare this for itself, which overrides whatever is set
   * here — see `meta.tenant` on the route:
   *
   * ```ts
   * route({ method: 'GET', url: '/pricing', meta: { tenant: false }, handler })
   * ```
   */
  required?: boolean | { except: (string | RegExp)[] }
  /**
   * Per-tenant migration hook for `basalt tenant:migrate`. The framework iterates
   * tenants and runs this inside each one's context; you provide the DB-specific
   * work (e.g. `prisma migrate deploy` against the tenant's schema).
   */
  onMigrate?: (tenant: Tenant) => void | Promise<void>
  /** Per-tenant seed hook for `basalt tenant:seed`, run inside each tenant's context. */
  onSeed?: (tenant: Tenant) => void | Promise<void>
  /**
   * Brings a NEW tenant's storage into existence — create the schema or
   * database, then migrate it. Runs inside the new tenant's context, from
   * `tenancy.create()` and from `basalt tenant:create`, before anything can
   * route a request to it.
   *
   * This is what makes self-service signup work: a tenant created from an admin
   * panel has no operator standing by to run `basalt tenant:migrate`, and
   * without provisioning its first request hits storage that does not exist.
   *
   * ```ts
   * tenancyPlugin({
   *   source, resolvers,
   *   async onProvision(tenant) {
   *     const admin = new PrismaClient()
   *     await provisionTenantSchema(admin, tenantSchema(tenant.id))
   *     await migrateTenants({
   *       tenants: [tenant.id],
   *       target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
   *     })
   *   },
   * })
   * ```
   *
   * Make it idempotent (`CREATE SCHEMA IF NOT EXISTS`, `migrate deploy`): if it
   * throws, the tenant record already exists and a retry has to be able to
   * finish the job. Keep it quick, or hand the slow part to a queued job — this
   * runs inline, so an HTTP handler calling `create()` waits for it.
   */
  onProvision?: (tenant: Tenant) => void | Promise<void>
  /**
   * When `onProvision` runs.
   *
   * `'inline'` (default) — `create()` waits for it, so the caller knows the
   * tenant is usable when it returns. Right for a schema and a few migrations.
   *
   * `'deferred'` — `create()` returns as soon as the record is written, marked
   * `provisioning`; the resolver answers **503** for that tenant until someone
   * calls `tenancy.provision(id)`. Use it when provisioning is slow enough to
   * outlive an HTTP request.
   *
   * Deferred does NOT schedule anything by itself, and deliberately so:
   * background work runs in another process, where a closure from this one
   * cannot reach. You dispatch the job and it calls back in:
   *
   * ```ts
   * const ProvisionTenant = defineJob({
   *   name: 'tenant.provision',
   *   handle: ({ id }: { id: string }) => ctx().container.get(TENANCY).provision(id),
   * })
   *
   * app.hooks.on('tenancy:created', …)          // fires when provisioning finishes
   * await tenancy.create({ id })                // returns immediately
   * await queue.dispatch(ProvisionTenant, { id })
   * ```
   *
   * That keeps `@basaltkit/queue` out of this package entirely — the app owns
   * the dispatch, and any scheduler works.
   */
  provision?: 'inline' | 'deferred'
}

export function tenancyPlugin(options: TenancyPluginOptions) {
  return definePlugin({
    name: 'basalt:tenancy',
    register({ container, hooks }) {
      container.singleton(
        TENANCY,
        () =>
          new Tenancy(
            options.source,
            options.resolvers,
            hooks,
            options.onProvision,
            options.provision ?? 'inline',
          ),
      )
      registerTenantCommands(container, options)
      // Marker other plugins read to adopt tenant-safe defaults (e.g.
      // @basaltkit/cache fails closed on a missing tenant scope when this app
      // is multi-tenant). String-keyed metadata — no package coupling.
      ensureMetadata(container).add('tenancy:active', true)

      // Request enricher consumed by the HTTP adapter: resolves the tenant,
      // attaches it to the context and fires the switch hook.
      ensureMetadata(container).add(
        'http:enrichers',
        async ({
          request,
          context,
          route,
        }: {
          request: { headers?: ResolutionRequest['headers']; params?: unknown; url?: string }
          context: { tenant?: Tenant }
          container: unknown
          route?: { meta?: Record<string, unknown> | undefined }
        }) => {
          const tenancy = container.get(TENANCY)
          const tenant = await tenancy.resolve({
            headers: request.headers ?? {},
            params: (request.params ?? {}) as Record<string, string>,
            ...(request.url !== undefined ? { url: request.url } : {}),
          })
          if (!tenant) {
            if (isTenantRequired(options.required, request.url, route?.meta)) {
              throw new TenancyNotResolvedError()
            }
            return
          }
          // A tenant that is still provisioning (or failed) exists but cannot
          // serve. Without this the request would reach a schema that is not
          // there yet and die on a raw database error — the whole reason the
          // status exists.
          if (!isTenantReady(tenant)) {
            throw new TenantNotReadyError(tenant.id, tenant['status'] as TenantStatus)
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
      // Checked here as well as in the service, so the CLI answers with a clean
      // line instead of a stack trace.
      if (!options.source.create && !options.source.save) {
        io.error(new TenantCreateUnsupportedError().message)
        return 1
      }
      const fields: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(flags)) fields[key] = value
      // Through the SERVICE, not the source: that is what runs `onProvision`
      // and emits `tenancy:created`, so this command and an admin panel calling
      // `tenancy.create()` produce an identical tenant.
      const tenant = await tenancy().create({ id, ...fields } as Tenant)
      io.log(
        options.onProvision
          ? `Created and provisioned tenant "${tenant.id}".`
          : `Created tenant "${tenant.id}". No onProvision hook configured — its storage was NOT created.`,
      )
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
  normalizeDomain,
  findByVerifiedDomain,
  DomainTakenError,
  DomainNotFoundError,
  DomainForbiddenError,
  type CustomDomain,
  type DomainStore,
  type DnsVerification,
  type CustomDomainsOptions,
} from './custom-domains.js'
