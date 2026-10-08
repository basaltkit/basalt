// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import {
  DomainTakenError,
  TenantAlreadyExistsError,
  type CustomDomain,
  type DomainStore,
  type Tenant,
  type TenantSource,
} from '@basaltkit/tenancy'

/**
 * Durable, SQLite-backed implementation of the `@basaltkit/tenancy` `TenantSource`,
 * on Node's built-in `node:sqlite`. Zero external dependencies. The single-node
 * reference backend; the production (Postgres/MySQL) counterpart is
 * `@basaltkit/tenancy-prisma`.
 *
 * The tenant is an open record (`{ id, ...anything }`), so it's stored as a JSON
 * blob keyed by `id`. Custom domains (`tenant.domains: string[]`) are mirrored
 * into a normalized, indexed `tenant_domains` table so `findByDomain` is a keyed
 * lookup rather than a scan.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

export function openTenancyDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location)
  migrate(db)
  return db
}

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  // Wait up to 5s for a competing writer's lock instead of throwing
  // 'database is locked' immediately — smooths over dev reloads / concurrency.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_domains (
      domain    TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant ON tenant_domains (tenant_id);
  `)
  // Custom-domain verification columns (SqliteDomainStore), added in place so
  // a database created by an older version migrates on open. A row with a NULL
  // token mirrors `tenant.domains`; a row with a token is a CustomDomains claim.
  const columns = new Set(
    (db.prepare('PRAGMA table_info(tenant_domains)').all() as unknown as { name: string }[]).map((c) => c.name),
  )
  const add = (name: string, definition: string) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE tenant_domains ADD COLUMN ${name} ${definition}`)
  }
  add('verification_token', 'TEXT')
  add('verified', 'INTEGER NOT NULL DEFAULT 1')
  add('created_at', 'INTEGER NOT NULL DEFAULT 0')
  add('verified_at', 'INTEGER')
}

/** The custom domains a tenant claims — a `string[]` under `tenant.domains`. */
const domainsOf = (tenant: Tenant): string[] => {
  const value = (tenant as { domains?: unknown }).domains
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : []
}

/**
 * Whether a `node:sqlite` error is a primary-key or unique violation.
 * Matched on the extended result code, not on the message text, which is
 * SQLite's to reword: 1555 is SQLITE_CONSTRAINT_PRIMARYKEY, 2067
 * SQLITE_CONSTRAINT_UNIQUE (a database migrated with a unique index instead).
 */
const isUniqueViolation = (error: unknown): boolean => {
  const errcode = (error as { errcode?: unknown } | null)?.errcode
  return errcode === 1555 || errcode === 2067
}

export class SqliteTenantSource implements TenantSource {
  constructor(readonly db: DatabaseSync) {}

  /**
   * Insert or update a tenant and bring its domain set in line with
   * `tenant.domains`, in one transaction. Only mirror rows are touched: a
   * domain claimed through `CustomDomains` + {@link SqliteDomainStore} survives
   * every save, so re-provisioning or a status change keeps a verified custom
   * domain and its proof. Claiming a domain already owned by a *different* tenant throws
   * (domains are globally unique — routing must be unambiguous); the whole save
   * rolls back so the tenant record and its domains never drift apart.
   *
   * An upsert replaces the whole record. That is right for an intentional
   * update and for status transitions; it is wrong for creating a tenant, which
   * is what `create` is for.
   */
  async save(tenant: Tenant): Promise<Tenant> {
    this.write(
      tenant,
      'INSERT INTO tenants (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    )
    return tenant
  }

  /**
   * Insert a NEW tenant and its custom-domain set, in one transaction; an
   * existing id throws `TenantAlreadyExistsError` and leaves that tenant
   * untouched.
   *
   * A plain INSERT, not a lookup followed by a write: the primary key refuses
   * the duplicate, and `BEGIN IMMEDIATE` serialises writers across processes
   * sharing the file, so of two concurrent creates of the same id exactly one
   * wins. This is what `tenancy.create()` calls.
   */
  async create(tenant: Tenant): Promise<Tenant> {
    this.write(tenant, 'INSERT INTO tenants (id, data) VALUES (?, ?)', true)
    return tenant
  }

  /**
   * The tenant row plus its domain set, all or nothing. `refuseExisting` maps a
   * key violation on the TENANT insert — and only there, since a domain claimed
   * by another tenant violates a key too — to `TenantAlreadyExistsError`.
   */
  private write(tenant: Tenant, insertTenant: string, refuseExisting = false): void {
    const domains = domainsOf(tenant)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      try {
        this.db.prepare(insertTenant).run(tenant.id, JSON.stringify(tenant))
      } catch (error) {
        if (refuseExisting && isUniqueViolation(error)) throw new TenantAlreadyExistsError(tenant.id)
        throw error
      }
      // Diff this tenant's mirror rows against the set: drop the ones no longer
      // listed (claim rows, which carry a token, are never dropped), insert the
      // missing ones. A plain INSERT fails if another tenant already owns the
      // domain; a domain the tenant already holds (mirror or claim) is kept.
      this.db
        .prepare(
          'DELETE FROM tenant_domains WHERE tenant_id = ? AND verification_token IS NULL ' +
            'AND domain NOT IN (SELECT value FROM json_each(?))',
        )
        .run(tenant.id, JSON.stringify(domains))
      const owner = this.db.prepare('SELECT tenant_id FROM tenant_domains WHERE domain = ?')
      const insert = this.db.prepare('INSERT INTO tenant_domains (domain, tenant_id, created_at) VALUES (?, ?, ?)')
      const now = Date.now()
      for (const domain of domains) {
        const row = owner.get(domain) as { tenant_id: string } | undefined
        if (row?.tenant_id === tenant.id) continue
        insert.run(domain, tenant.id, now)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async find(id: string): Promise<Tenant | null> {
    const row = this.db.prepare('SELECT data FROM tenants WHERE id = ?').get(id) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as Tenant) : null
  }

  /**
   * The tenant a domain belongs to. Fail-closed for custom domains: a claim
   * row resolves only once verified, so a domain another tenant merely claimed
   * never routes a request.
   */
  async findByDomain(domain: string): Promise<Tenant | null> {
    const row = this.db
      .prepare(
        'SELECT tenant_id FROM tenant_domains WHERE domain = ? AND (verification_token IS NULL OR verified = 1)',
      )
      .get(domain) as { tenant_id: string } | undefined
    return row ? this.find(row.tenant_id) : null
  }

  async list(): Promise<Tenant[]> {
    const rows = this.db.prepare('SELECT data FROM tenants ORDER BY id').all() as unknown as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Tenant)
  }

  /**
   * Removes a tenant and its domains — the `TenantSource.delete` the contract
   * asks for, and what `tenancy.destroy()` calls. Without it, `destroy` refuses.
   */
  async delete(id: string): Promise<void> {
    await this.remove(id)
  }

  /** Delete a tenant and its domains. Returns whether a tenant was removed. */
  async remove(id: string): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM tenant_domains WHERE tenant_id = ?').run(id)
      const info = this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id)
      this.db.exec('COMMIT')
      return info.changes > 0
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

interface DomainRow {
  domain: string
  tenant_id: string
  verification_token: string
  verified: number
  created_at: number
  verified_at: number | null
}

const CLAIM_COLUMNS = 'domain, tenant_id, verification_token, verified, created_at, verified_at'

function toRecord(row: DomainRow): CustomDomain {
  return {
    domain: row.domain,
    tenantId: row.tenant_id,
    verified: row.verified === 1,
    verificationToken: row.verification_token,
    createdAt: Number(row.created_at),
    ...(row.verified_at !== null ? { verifiedAt: Number(row.verified_at) } : {}),
  }
}

const claimValues = (r: CustomDomain) =>
  [r.domain, r.tenantId, r.verificationToken, r.verified ? 1 : 0, r.createdAt, r.verifiedAt ?? null] as const

/**
 * Durable `DomainStore` for `CustomDomains`, on the same `tenant_domains` table
 * `SqliteTenantSource` reads — a verified custom domain resolves through the
 * source's `findByDomain` with no extra wiring.
 *
 * Rows with a verification token are this store's (claims); rows without one
 * mirror `tenant.domains` and belong to the source — invisible here, and never
 * deleted or rewritten by this store. The domain is the primary key, so
 * `add()` of a domain already present, of either kind, throws
 * `DomainTakenError` (409 through `CustomDomains.add()`).
 */
export class SqliteDomainStore implements DomainStore {
  constructor(readonly db: DatabaseSync) {}

  async add(record: CustomDomain): Promise<void> {
    try {
      this.db
        .prepare(`INSERT INTO tenant_domains (${CLAIM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(...claimValues(record))
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainTakenError(record.domain)
      throw error
    }
  }

  async get(domain: string): Promise<CustomDomain | null> {
    const row = this.db
      .prepare(`SELECT ${CLAIM_COLUMNS} FROM tenant_domains WHERE domain = ? AND verification_token IS NOT NULL`)
      .get(domain) as DomainRow | undefined
    return row ? toRecord(row) : null
  }

  async forTenant(tenantId: string): Promise<CustomDomain[]> {
    const rows = this.db
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM tenant_domains WHERE tenant_id = ? AND verification_token IS NOT NULL ORDER BY domain`,
      )
      .all(tenantId) as unknown as DomainRow[]
    return rows.map(toRecord)
  }

  async markVerified(domain: string, at: number): Promise<void> {
    this.db
      .prepare('UPDATE tenant_domains SET verified = 1, verified_at = ? WHERE domain = ? AND verification_token IS NOT NULL')
      .run(at, domain)
  }

  async markUnverified(domain: string): Promise<void> {
    this.db
      .prepare(
        'UPDATE tenant_domains SET verified = 0, verified_at = NULL WHERE domain = ? AND verification_token IS NOT NULL',
      )
      .run(domain)
  }

  async remove(domain: string): Promise<void> {
    this.db.prepare('DELETE FROM tenant_domains WHERE domain = ? AND verification_token IS NOT NULL').run(domain)
  }

  /** One conditional UPDATE: of two callers racing on the same claim, exactly one matches. */
  async replace(expected: CustomDomain, next: CustomDomain): Promise<boolean> {
    try {
      const info = this.db
        .prepare(
          'UPDATE tenant_domains SET domain = ?, tenant_id = ?, verification_token = ?, verified = ?, ' +
            'created_at = ?, verified_at = ? ' +
            'WHERE domain = ? AND tenant_id = ? AND verification_token = ? AND verified = ?',
        )
        .run(
          ...claimValues(next),
          expected.domain,
          expected.tenantId,
          expected.verificationToken,
          expected.verified ? 1 : 0,
        )
      return Number(info.changes) === 1
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  }

  async listVerified(): Promise<CustomDomain[]> {
    const rows = this.db
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM tenant_domains WHERE verified = 1 AND verification_token IS NOT NULL ORDER BY domain`,
      )
      .all() as unknown as DomainRow[]
    return rows.map(toRecord)
  }
}

/**
 * A durable domain store for `CustomDomains`, on the same database as the
 * tenant source (pass `source.db`), or on its own file:
 *
 * ```ts
 * const tenants = sqliteTenantSource('./data/tenants.db')
 * const customDomains = new CustomDomains({ store: sqliteDomainStore(tenants.db) })
 * ```
 */
export function sqliteDomainStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteDomainStore {
  const db = typeof dbOrLocation === 'string' ? openTenancyDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return new SqliteDomainStore(db)
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the tenant source wired
 * to it, ready to drop straight into `tenancyPlugin`:
 *
 * ```ts
 * const tenants = sqliteTenantSource('./data/tenants.db')
 * await tenants.create({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
 * tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'localhost' })] })
 * ```
 *
 * The raw handle is exposed as `source.db` for advanced use.
 */
export function sqliteTenantSource(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteTenantSource {
  const db = typeof dbOrLocation === 'string' ? openTenancyDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return new SqliteTenantSource(db)
}
