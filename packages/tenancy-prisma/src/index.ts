import { TenantAlreadyExistsError, type Tenant, type TenantSource } from '@basaltkit/tenancy'

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
export interface PrismaTenancyClient {
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

/** The custom domains a tenant claims — a `string[]` under `tenant.domains`. */
const domainsOf = (tenant: Tenant): string[] => {
  const value = (tenant as { domains?: unknown }).domains
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : []
}

export class PrismaTenantSource implements TenantSource {
  constructor(private readonly client: PrismaTenancyClient) {}

  /**
   * Insert or update a tenant and replace its custom-domain set. Domains are
   * globally unique — a domain already owned by a *different* tenant is rejected
   * up front (before any write), so routing stays unambiguous.
   *
   * An upsert replaces the whole record. That is right for an intentional
   * update and for status transitions; it is wrong for creating a tenant, which
   * is what `create` is for.
   */
  async save(tenant: Tenant): Promise<Tenant> {
    const domains = await this.claimableDomains(tenant)
    await this.client.tenant.upsert({
      where: { id: tenant.id },
      create: { id: tenant.id, data: tenant as object },
      update: { data: tenant as object },
    })
    await this.replaceDomains(tenant.id, domains)
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
   * Domains are pre-flighted exactly as in `save`, before the insert, so a
   * domain conflict writes nothing either.
   */
  async create(tenant: Tenant): Promise<Tenant> {
    const domains = await this.claimableDomains(tenant)
    try {
      await this.client.tenant.create({ data: { id: tenant.id, data: tenant as object } })
    } catch (error) {
      // P2002 is Prisma's unique-constraint violation. Only the tenant insert
      // is inside this try, so the constraint can only be the tenant's id.
      if ((error as { code?: unknown } | null)?.code === 'P2002') {
        throw new TenantAlreadyExistsError(tenant.id)
      }
      throw error
    }
    await this.replaceDomains(tenant.id, domains)
    return tenant
  }

  /** The tenant's domains, after refusing any owned by a different tenant — before any write. */
  private async claimableDomains(tenant: Tenant): Promise<string[]> {
    const domains = domainsOf(tenant)
    for (const domain of domains) {
      const owner = await this.client.tenantDomain.findUnique({ where: { domain } })
      if (owner && owner.tenantId !== tenant.id) {
        throw new Error(
          `@basaltkit/tenancy-prisma: domain "${domain}" is already owned by tenant "${owner.tenantId}".`,
        )
      }
    }
    return domains
  }

  /** Replace this tenant's domain set. */
  private async replaceDomains(tenantId: string, domains: string[]): Promise<void> {
    await this.client.tenantDomain.deleteMany({ where: { tenantId } })
    if (domains.length > 0) {
      await this.client.tenantDomain.createMany({
        data: domains.map((domain) => ({ domain, tenantId })),
      })
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
 * const tenants = prismaTenantSource(prisma)
 * await tenants.create({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
 * tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'localhost' })] })
 * ```
 */
export function prismaTenantSource(client: PrismaTenancyClient): PrismaTenantSource {
  ensureModel(client, 'tenant', '@basaltkit/tenancy-prisma')
  return new PrismaTenantSource(client)
}
