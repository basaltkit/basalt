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
   * Persists and returns the new tenant, failing with `TenantAlreadyExistsError`
   * if the id is already taken — never overwriting it.
   *
   * Implement it as an insert the store itself refuses on a duplicate (a primary
   * key violation), not as a read followed by a write: `tenancy.create()` checks
   * with `find()` first, but two concurrent creates of the same id both pass that
   * check, and only the store can pick exactly one winner.
   * `MemoryTenantSource`, `@basaltkit/tenancy-prisma` and
   * `@basaltkit/tenancy-sqlite` all implement it that way.
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
   * Upsert — inserts a new tenant or replaces an existing record wholesale.
   *
   * This is the write for an INTENTIONAL update, and the one status transitions
   * go through (`provisioning` → `ready`). `tenancy.create()` prefers `create`
   * and falls back to `save` only for a source that has nothing else; it checks
   * with `find()` before writing either way, so a save-only source still refuses
   * an existing id — just without the store-level guarantee against a
   * concurrent create of the same id.
   */
  save?(tenant: Tenant): Promise<Tenant>
}

/**
 * The canonical tenant-id grammar: 1–63 characters of lower-case ASCII
 * letters, digits, `-` and `_`, starting with a letter or digit. Slugs, UUIDs
 * and cuids all fit.
 *
 * The id is not an opaque label: every tenant-scoped package builds a
 * namespace out of it — `tenant:<id>:<key>` in the cache, `tenants/<id>/<path>`
 * in storage, a channel map key in realtime, a schema or database name in the
 * tenancy drivers. An id carrying one of those delimiters (`:`, `/`, `..`,
 * whitespace, control characters) could alias another tenant's namespace, and
 * mixed case collides on case-insensitive filesystems and DNS. So ids are held
 * to one grammar at the point they are created.
 */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

/**
 * Ids the default grammar refuses although they match the pattern: `global`
 * is the sentinel scope other packages use for platform-wide data (e.g. the
 * legacy permissions global scope), so a tenant must not be able to take it.
 */
export const RESERVED_TENANT_IDS: readonly string[] = Object.freeze(['global'])

/**
 * Whether `id` matches {@link TENANT_ID_PATTERN} and is not one of
 * {@link RESERVED_TENANT_IDS}. The default `validateTenantId`.
 */
export function isValidTenantId(id: unknown): id is string {
  return typeof id === 'string' && TENANT_ID_PATTERN.test(id) && !RESERVED_TENANT_IDS.includes(id)
}

/**
 * A tenant id that does not match the configured grammar (by default
 * {@link TENANT_ID_PATTERN}). 400: the id came from the caller, and a
 * different id is the fix.
 */
export class InvalidTenantIdError extends BasaltError {
  readonly status = 400
  constructor(id: unknown) {
    const shown = typeof id === 'string' ? JSON.stringify(id.slice(0, 80)) : typeof id
    super(
      'TENANT_ID_INVALID',
      `Invalid tenant id ${shown}. Tenant ids must be 1-63 characters of a-z, 0-9, "-" or "_", ` +
        'starting with a letter or digit, and not a reserved id such as "global".',
    )
  }
}

/** Throws {@link InvalidTenantIdError} unless `validate(id)` accepts it. */
export function assertValidTenantId(
  id: unknown,
  validate: (id: string) => boolean = isValidTenantId,
): asserts id is string {
  if (typeof id !== 'string' || !validate(id)) throw new InvalidTenantIdError(id)
}

/** In-memory source — tests, dev and small single-node setups. */
export class MemoryTenantSource implements TenantSource {
  private readonly tenants = new Map<string, Tenant>()
  private readonly validateTenantId: (id: string) => boolean

  /**
   * `validateTenantId` — the id grammar `create()`/`save()` enforce. Default
   * {@link isValidTenantId}; pass the same function you give `tenancyPlugin`
   * if you widen or narrow it there.
   */
  constructor(options: { validateTenantId?: (id: string) => boolean } = {}) {
    this.validateTenantId = options.validateTenantId ?? isValidTenantId
  }

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

  /**
   * Refuses an id that is already present. The check and the write happen in
   * one synchronous step, so concurrent creates of the same id cannot both
   * succeed — the same guarantee the durable sources get from a primary key.
   */
  async create(tenant: Tenant): Promise<Tenant> {
    assertValidTenantId(tenant.id, this.validateTenantId)
    if (this.tenants.has(tenant.id)) {
      throw new TenantAlreadyExistsError(tenant.id, this.tenants.get(tenant.id)!['status'] as TenantStatus | undefined)
    }
    this.tenants.set(tenant.id, tenant)
    return tenant
  }

  /**
   * Upsert. Present so status transitions work here too — `tenancy.create()`
   * writes `provisioning`, then `ready`, and needs a second write for that.
   */
  async save(tenant: Tenant): Promise<Tenant> {
    assertValidTenantId(tenant.id, this.validateTenantId)
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
        'save(). MemoryTenantSource, @basaltkit/tenancy-prisma and @basaltkit/tenancy-sqlite ' +
        'have both. A read-only source (e.g. one backed by a static config file) has neither and ' +
        'cannot create tenants.',
    )
  }
}

/**
 * `tenancy.create()` (or `basalt tenant:create`, or a source's `create()`) for an
 * id that already exists. 409: the request conflicts with a record that is
 * there, and repeating it will not change that.
 *
 * Refused rather than overwritten. Creating over an existing tenant used to go
 * through the durable sources' upsert, which replaced the whole record — the
 * owner, the plan, a `suspended` status — and then ran `onProvision` again on
 * storage that already held a customer's data. A signup form that submits twice
 * must not be able to do that.
 *
 * `status` is the existing record's, when the caller knows it. A `failed` or
 * `provisioning` tenant is the one case where "create it again" is a reasonable
 * instinct, so the message names the method that actually finishes the job.
 */
export class TenantAlreadyExistsError extends BasaltError {
  readonly status = 409
  constructor(id: string, existingStatus?: TenantStatus) {
    super(
      'TENANT_ALREADY_EXISTS',
      existingStatus === 'failed' || existingStatus === 'provisioning'
        ? `Tenant "${id}" already exists with status "${existingStatus}". Call tenancy.provision("${id}") ` +
            'to finish or retry its provisioning instead of creating it again.'
        : `Tenant "${id}" already exists. create() never overwrites a tenant; use the source's save() ` +
            'for an intentional update.',
    )
  }
}
