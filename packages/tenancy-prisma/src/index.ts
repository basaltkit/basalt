import type { Tenant, TenantSource } from '@machize/tenancy'

/**
 * Prisma-backed implementation of the `@machize/tenancy` `TenantSource` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` whose schema includes the `Tenant` and `TenantDomain` models
 * (see the bundled `prisma/schema.prisma`); the source only touches those
 * delegates. The production counterpart to `@machize/tenancy-sqlite`.
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
   */
  async save(tenant: Tenant): Promise<Tenant> {
    const domains = domainsOf(tenant)
    // Pre-flight the conflict so a rejected save writes nothing.
    for (const domain of domains) {
      const owner = await this.client.tenantDomain.findUnique({ where: { domain } })
      if (owner && owner.tenantId !== tenant.id) {
        throw new Error(
          `@machize/tenancy-prisma: domain "${domain}" is already owned by tenant "${owner.tenantId}".`,
        )
      }
    }
    await this.client.tenant.upsert({
      where: { id: tenant.id },
      create: { id: tenant.id, data: tenant as object },
      update: { data: tenant as object },
    })
    // Replace this tenant's domain set.
    await this.client.tenantDomain.deleteMany({ where: { tenantId: tenant.id } })
    if (domains.length > 0) {
      await this.client.tenantDomain.createMany({
        data: domains.map((domain) => ({ domain, tenantId: tenant.id })),
      })
    }
    return tenant
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

  /** Delete a tenant; its domains cascade (schema `onDelete: Cascade`). */
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
        `schema.prisma (run \`mach prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

/**
 * Wire the tenant source to your Prisma client, ready for `tenancyPlugin`:
 *
 * ```ts
 * const tenants = prismaTenantSource(prisma)
 * await tenants.save({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
 * tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'localhost' })] })
 * ```
 */
export function prismaTenantSource(client: PrismaTenancyClient): PrismaTenantSource {
  ensureModel(client, 'tenant', '@machize/tenancy-prisma')
  return new PrismaTenantSource(client)
}
