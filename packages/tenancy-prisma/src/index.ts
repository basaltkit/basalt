import { TenantAlreadyExistsError, type Tenant, type TenantSource } from '@basaltkit/tenancy'
import {
  assertColumnLengths,
  type ColumnLimits,
  MYSQL_VARCHAR_DEFAULT as V,
  resolveColumnLimits,
} from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/tenancy-prisma'

export type TenancyColumnLimits = ColumnLimits<{ Tenant: 'id'; TenantDomain: 'domain' | 'tenantId' }>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects. `domain` is VARCHAR(255): a DNS name reaches 253.
 */
export const tenancyMysqlColumnLimits: TenancyColumnLimits = {
  Tenant: { id: V },
  TenantDomain: { domain: 255, tenantId: V },
}

export interface PrismaTenantSourceOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a tenant id or domain longer than its
   * column instead of letting the database truncate it — on MySQL outside
   * strict mode two long domains cut to the same prefix collide, and a cut
   * domain resolves nobody. `'mysql'` uses the limits of the bundled
   * `schema.mysql.prisma`; pass an object for a schema of your own. Default:
   * unchecked (PostgreSQL and SQLite store any length).
   */
  columnLimits?: 'mysql' | TenancyColumnLimits
}

/**
 * Prisma-backed implementation of the `@basaltkit/tenancy` `TenantSource` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` whose schema includes the `Tenant` and `TenantDomain` models
 * (see the bundled `prisma/schema.prisma`); the source only touches those
 * delegates. The production counterpart to `@basaltkit/tenancy-sqlite`.
 *
 * The tenant is an open record (`{ id, ...anything }`), stored in a `Json`
 * column. Custom domains (`tenant.domains: string[]`) live in a normalized,
 * indexed `TenantDomain` table so `findByDomain` is a keyed lookup.
 */

// Prisma-return row shapes.
interface PTenant {
  id: string
  data: unknown
}
interface PTenantDomain {
  domain: string
  tenantId: string
}

/**
 * The minimal Prisma delegate surface the source calls — a real `PrismaClient`
 * with the `Tenant`/`TenantDomain` models is assignable, so pass it directly.
 * Method arguments are typed `any` on purpose (Prisma's generated method
 * generics can't be reproduced by a hand-written interface); return types stay
 * precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaTenancyClient extends PrismaTenancyDelegates {
  /**
   * Prisma's interactive transaction. `save`/`create` write the tenant and its
   * domain set inside one, so a failure part-way leaves nothing half-written.
   */
  $transaction<R>(fn: (tx: PrismaTenancyDelegates) => Promise<R>, options?: any): Promise<R>
}

/** The model delegates the source uses — also what a transaction client offers. */
export interface PrismaTenancyDelegates {
  tenant: {
    findUnique(a: any): Promise<PTenant | null>
    findMany(a: any): Promise<PTenant[]>
    create(a: any): Promise<PTenant>
    upsert(a: any): Promise<PTenant>
    deleteMany(a: any): Promise<{ count: number }>
  }
  tenantDomain: {
    findUnique(a: any): Promise<PTenantDomain | null>
    deleteMany(a: any): Promise<{ count: number }>
    createMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The custom domains a tenant claims — a `string[]` under `tenant.domains`, each once. */
const domainsOf = (tenant: Tenant): string[] => {
  const value = (tenant as { domains?: unknown }).domains
  return Array.isArray(value) ? [...new Set(value.filter((d): d is string => typeof d === 'string'))] : []
}

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'P2002'

/** A domain in the set was claimed by another tenant after the pre-flight read. */
const domainTakenError = (tenantId: string, domains: string[], cause: unknown): Error =>
  new Error(
    `@basaltkit/tenancy-prisma: one of the domains of tenant "${tenantId}" (${domains.join(', ')}) ` +
      'was claimed by another tenant meanwhile; nothing was written.',
    { cause },
  )

export class PrismaTenantSource implements TenantSource {
  private readonly limits: TenancyColumnLimits | undefined

  constructor(
    private readonly client: PrismaTenancyClient,
    options: PrismaTenantSourceOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, tenancyMysqlColumnLimits)
  }

  /** Before any write, so a refused tenant leaves nothing behind. */
  private checkLengths(tenant: Tenant, domains: string[]): void {
    assertColumnLengths(PKG, this.limits, 'Tenant', { id: tenant.id })
    for (const domain of domains) assertColumnLengths(PKG, this.limits, 'TenantDomain', { domain, tenantId: tenant.id })
  }

  /**
   * Insert or update a tenant and replace its custom-domain set. Domains are
   * globally unique — a domain already owned by a *different* tenant is
   * rejected, and nothing is written.
   *
   * The record and its domain set are written in ONE transaction: a failure
   * part-way (a domain another tenant claimed in the meantime, a lost
   * connection) rolls the whole save back instead of leaving the tenant
   * rewritten with its domains deleted. The tenant row is written first, so
   * two concurrent saves of the same tenant serialise on its row lock.
   *
   * An upsert replaces the whole record. That is right for an intentional
   * update and for status transitions; it is wrong for creating a tenant, which
   * is what `create` is for.
   */
  async save(tenant: Tenant): Promise<Tenant> {
    const domains = domainsOf(tenant)
    this.checkLengths(tenant, domains)
    await this.client.$transaction(async (tx) => {
      await tx.tenant.upsert({
        where: { id: tenant.id },
        create: { id: tenant.id, data: tenant as object },
        update: { data: tenant as object },
      })
      await this.writeDomains(tx, tenant.id, domains)
    })
    return tenant
  }

  /**
   * Insert a NEW tenant and its custom-domain set; an existing id throws
   * `TenantAlreadyExistsError` and leaves that tenant untouched.
   *
   * A plain `create`, not a find-then-upsert: the primary key is what refuses
   * the duplicate, so of two concurrent creates of the same id exactly one
   * wins — which no read in application code can guarantee. This is what
   * `tenancy.create()` calls.
   *
   * Same transaction as `save`: a domain conflict leaves no tenant behind.
   */
  async create(tenant: Tenant): Promise<Tenant> {
    const domains = domainsOf(tenant)
    this.checkLengths(tenant, domains)
    await this.client.$transaction(async (tx) => {
      try {
        await tx.tenant.create({ data: { id: tenant.id, data: tenant as object } })
      } catch (error) {
        // P2002 is Prisma's unique-constraint violation. Only the tenant insert
        // is inside this try, so the constraint can only be the tenant's id.
        if (isUniqueViolation(error)) throw new TenantAlreadyExistsError(tenant.id)
        throw error
      }
      await this.writeDomains(tx, tenant.id, domains)
    })
    return tenant
  }

  /**
   * Refuses any domain owned by a different tenant, then replaces the tenant's
   * domain set — inside the caller's transaction, so a refusal rolls back the
   * tenant write too.
   */
  private async writeDomains(tx: PrismaTenancyDelegates, tenantId: string, domains: string[]): Promise<void> {
    for (const domain of domains) {
      const owner = await tx.tenantDomain.findUnique({ where: { domain } })
      if (owner && owner.tenantId !== tenantId) {
        throw new Error(
          `@basaltkit/tenancy-prisma: domain "${domain}" is already owned by tenant "${owner.tenantId}".`,
        )
      }
    }
    await tx.tenantDomain.deleteMany({ where: { tenantId } })
    if (domains.length === 0) return
    try {
      await tx.tenantDomain.createMany({ data: domains.map((domain) => ({ domain, tenantId })) })
    } catch (error) {
      // The pre-flight saw the domains free; another tenant took one since.
      if (isUniqueViolation(error)) throw domainTakenError(tenantId, domains, error)
      throw error
    }
  }

  async find(id: string): Promise<Tenant | null> {
    const r = await this.client.tenant.findUnique({ where: { id } })
    return r ? (r.data as Tenant) : null
  }

  async findByDomain(domain: string): Promise<Tenant | null> {
    const d = await this.client.tenantDomain.findUnique({ where: { domain } })
    return d ? this.find(d.tenantId) : null
  }

  async list(): Promise<Tenant[]> {
    const rows = await this.client.tenant.findMany({ orderBy: { id: 'asc' } })
    return rows.map((r) => r.data as Tenant)
  }

  /**
   * Removes a tenant; its domains cascade (schema `onDelete: Cascade`).
   *
   * This is the `TenantSource.delete` the contract asks for, and what
   * `tenancy.destroy()` calls. Without it, `destroy` refuses — which is the
   * right answer, and not one you want to meet in production.
   */
  async delete(id: string): Promise<void> {
    await this.client.tenant.deleteMany({ where: { id } })
  }

  /** The older name, kept so existing callers keep working. */
  async remove(id: string): Promise<boolean> {
    const { count } = await this.client.tenant.deleteMany({ where: { id } })
    return count > 0
  }
}

// Fail fast with an actionable message when the Prisma client lacks the models
// this package needs (the alternative is a cryptic "reading 'upsert' of undefined").
function ensureModel(client: unknown, delegate: string, pkg: string): void {
  let value: unknown
  try {
    value = (client as Record<string, unknown>)[delegate]
  } catch {
    return // lazy/proxy client (e.g. database-per-tenant) — validated at first use
  }
  if (value == null) {
    throw new Error(
      `${pkg}: the Prisma client has no \`${delegate}\` model. Add its models to your ` +
        `schema.prisma (run \`basalt prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

/**
 * Wire the tenant source to your Prisma client, ready for `tenancyPlugin`:
 *
 * ```ts
 * const tenants = prismaTenantSource(prisma) // on MySQL: prismaTenantSource(prisma, { columnLimits: 'mysql' })
 * await tenants.create({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
 * tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'localhost' })] })
 * ```
 */
export function prismaTenantSource(
  client: PrismaTenancyClient,
  options: PrismaTenantSourceOptions = {},
): PrismaTenantSource {
  ensureModel(client, 'tenant', PKG)
  return new PrismaTenantSource(client, options)
}
