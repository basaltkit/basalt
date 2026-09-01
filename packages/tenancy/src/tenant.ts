import { BasaltError } from '@basaltkit/core'

/** The tenant record. Apps extend it with whatever they store per tenant. */
export interface Tenant {
  id: string
  [key: string]: unknown
}

/** Where tenants are loaded from — the app's database in production. */
export interface TenantSource {
  find(id: string): Promise<Tenant | null>
  /** Required by the domain resolver (custom domains). */
  findByDomain?(domain: string): Promise<Tenant | null>
  /** Required by tenancy.forEach() and `basalt tenant:list`. */
  list?(): Promise<Tenant[]>
  /** Required by `basalt tenant:create`. Persists and returns the new tenant. */
  create?(tenant: Tenant): Promise<Tenant>
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

/** `tenancy.create()` (or `basalt tenant:create`) on a source that cannot persist. */
export class TenantCreateUnsupportedError extends BasaltError {
  constructor() {
    super(
      'TENANT_CREATE_UNSUPPORTED',
      'The configured TenantSource does not implement create(). MemoryTenantSource and the ' +
        'Prisma/SQLite sources do; a read-only source (e.g. one backed by a static config) cannot.',
    )
  }
}
