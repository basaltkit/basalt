// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import { TenantAlreadyExistsError, type Tenant, type TenantSource } from '@basaltkit/tenancy'

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
   * Insert or update a tenant and replace its custom-domain set in one
   * transaction. Claiming a domain already owned by a *different* tenant throws
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
      // Replace this tenant's domain set: drop the old rows, then insert the new
      // ones. A plain INSERT fails if another tenant already owns the domain.
      this.db.prepare('DELETE FROM tenant_domains WHERE tenant_id = ?').run(tenant.id)
      const insert = this.db.prepare('INSERT INTO tenant_domains (domain, tenant_id) VALUES (?, ?)')
      for (const domain of domains) insert.run(domain, tenant.id)
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

  async findByDomain(domain: string): Promise<Tenant | null> {
    const row = this.db
      .prepare('SELECT tenant_id FROM tenant_domains WHERE domain = ?')
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
