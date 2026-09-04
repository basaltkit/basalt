import { BasaltError } from '@basaltkit/core'

/** The tenant record. Apps extend it with whatever they store per tenant. */
export interface Tenant {
  id: string
  [key: string]: unknown
}

/** Where tenants are loaded from — the app's database in production. */
/**
 * Where a tenant is in its lifecycle.
 *
 * A record with **no** status is treated as `ready`. Every tenant that existed
 * before provisioning was introduced has no status, and they must keep serving
 * traffic — a stricter default would 503 an entire production estate on upgrade.
 */
export type TenantStatus = 'provisioning' | 'ready' | 'failed' | 'deleting'

/** True unless the tenant is explicitly mid-provisioning, failed or being removed. */
export function isTenantReady(tenant: Tenant): boolean {
  const status = tenant['status'] as TenantStatus | undefined
  return status === undefined || status === 'ready'
}

export interface TenantSource {
  find(id: string): Promise<Tenant | null>
  /** Required by the domain resolver (custom domains). */
  findByDomain?(domain: string): Promise<Tenant | null>
  /** Required by tenancy.forEach() and `basalt tenant:list`. */
  list?(): Promise<Tenant[]>
  /**
   * Persists and returns the new tenant, failing if it already exists.
   * `MemoryTenantSource` implements this.
   */
  create?(tenant: Tenant): Promise<Tenant>
  /**
   * Removes the record. Optional, because not every source can: a read-only
   * directory or a config file has nothing to delete from.
   *
   * `tenancy.destroy()` refuses rather than reporting a success it did not
   * perform — a tenant that looks removed and still resolves is worse than one
   * that never left.
   */
  delete?(id: string): Promise<void>
  /**
   * Upsert — what the durable sources (`@basaltkit/tenancy-prisma`,
   * `@basaltkit/tenancy-sqlite`) implement instead of `create`.
   *
   * `tenancy.create()` accepts either: it prefers `create` when a source has
   * it, and falls back to `save`. Without that, the whole provisioning flow
   * would work only with the in-memory source — which is to say, only in tests.
   */
  save?(tenant: Tenant): Promise<Tenant>
}

/** In-memory source — tests, dev and small single-node setups. */
export class MemoryTenantSource implements TenantSource {
  private readonly tenants = new Map<string, Tenant>()

  add(tenant: Tenant): this {
    this.tenants.set(tenant.id, tenant)
    return this
  }

  async find(id: string): Promise<Tenant | null> {
    return this.tenants.get(id) ?? null
  }

  async findByDomain(domain: string): Promise<Tenant | null> {
    for (const tenant of this.tenants.values()) {
      const domains = tenant['domains'] as string[] | undefined
      if (domains?.includes(domain)) return tenant
    }
    return null
  }

  async list(): Promise<Tenant[]> {
    return [...this.tenants.values()]
  }

  async create(tenant: Tenant): Promise<Tenant> {
    this.tenants.set(tenant.id, tenant)
    return tenant
  }

  /**
   * Upsert. Present so status transitions work here too — `tenancy.create()`
   * writes `provisioning`, then `ready`, and needs a second write for that.
   */
  async save(tenant: Tenant): Promise<Tenant> {
    this.tenants.set(tenant.id, tenant)
    return tenant
  }

  async delete(id: string): Promise<void> {
    this.tenants.delete(id)
  }
}

/** Request could not be mapped to a tenant. Maps to HTTP 404 in the adapter. */
export class TenancyNotResolvedError extends BasaltError {
  readonly status = 404
  constructor() {
    super(
      'TENANCY_NOT_RESOLVED',
      'No tenant could be resolved for this request. Check the configured resolvers.',
    )
  }
}

export class TenantNotFoundError extends BasaltError {
  constructor(id: string) {
    super('TENANT_NOT_FOUND', `Tenant "${id}" does not exist in the tenant source.`)
  }
}

/**
 * The request resolved to a tenant whose storage is not ready yet. 503 rather
 * than 404: the tenant exists, it is simply not serving — and 503 is the status
 * a client may retry.
 */
export class TenantNotReadyError extends BasaltError {
  readonly status = 503
  constructor(id: string, status: TenantStatus) {
    super(
      'TENANT_NOT_READY',
      status === 'failed'
        ? `Tenant "${id}" failed to provision and is not serving requests. Re-run provisioning once the cause is fixed.`
        : status === 'deleting'
          ? `Tenant "${id}" is being removed and is no longer serving requests.`
          : `Tenant "${id}" is still being provisioned. Retry shortly.`,
    )
  }
}

/** `tenancy.destroy()` (or `basalt tenant:destroy`) on a source that cannot remove. */
export class TenantDeleteUnsupportedError extends BasaltError {
  constructor() {
    super(
      'TENANT_DELETE_UNSUPPORTED',
      'The configured TenantSource does not implement delete(), so the tenant record cannot be ' +
        'removed. Refused rather than reported as done: a tenant that looks deleted and still ' +
        'resolves is worse than one that never left.',
    )
  }
}

/** `tenancy.create()` (or `basalt tenant:create`) on a source that cannot persist. */
export class TenantCreateUnsupportedError extends BasaltError {
  constructor() {
    super(
      'TENANT_CREATE_UNSUPPORTED',
      'The configured TenantSource can persist neither way: it implements neither create() nor ' +
        'save(). MemoryTenantSource has create(); @basaltkit/tenancy-prisma and ' +
        '@basaltkit/tenancy-sqlite have save(). A read-only source (e.g. one backed by a static ' +
        'config file) has neither and cannot create tenants.',
    )
  }
}
