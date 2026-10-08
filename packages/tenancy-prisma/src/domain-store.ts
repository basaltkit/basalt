import { DomainTakenError, type CustomDomain, type DomainStore } from '@basaltkit/tenancy'

/**
 * A `tenant_domains` row as Prisma returns it. The verification columns are
 * optional in the type because a database not yet migrated to them returns
 * rows without them — which every reader here treats as a mirror row.
 */
export interface PTenantDomainRow {
  domain: string
  tenantId: string
  verificationToken?: string | null
  verified?: boolean
  createdAt?: Date | string | number
  verifiedAt?: Date | string | number | null
}

/**
 * The `tenantDomain` delegate surface {@link PrismaDomainStore} calls — a real
 * `PrismaClient` whose schema has the bundled `TenantDomain` model is
 * assignable. Arguments are `any` for the same reason as `PrismaTenancyClient`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaDomainStoreClient {
  tenantDomain: {
    create(a: any): Promise<PTenantDomainRow>
    findUnique(a: any): Promise<PTenantDomainRow | null>
    findMany(a: any): Promise<PTenantDomainRow[]>
    updateMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Rows that belong to CustomDomains: they carry a verification token. */
const CLAIM = { verificationToken: { not: null } } as const

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'P2002'

const toMs = (value: Date | string | number): number =>
  value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)

/** A claim row as a `CustomDomain`; `null` for a mirror row, which is not the store's. */
function toRecord(row: PTenantDomainRow): CustomDomain | null {
  if (row.verificationToken === null || row.verificationToken === undefined) return null
  return {
    domain: row.domain,
    tenantId: row.tenantId,
    verified: row.verified === true,
    verificationToken: row.verificationToken,
    createdAt: row.createdAt === undefined ? 0 : toMs(row.createdAt),
    ...(row.verifiedAt !== null && row.verifiedAt !== undefined ? { verifiedAt: toMs(row.verifiedAt) } : {}),
  }
}

/** The columns a claim writes, every one explicit (the schema defaults are for mirror rows). */
function toData(record: CustomDomain) {
  return {
    domain: record.domain,
    tenantId: record.tenantId,
    verificationToken: record.verificationToken,
    verified: record.verified,
    createdAt: new Date(record.createdAt),
    verifiedAt: record.verifiedAt === undefined ? null : new Date(record.verifiedAt),
  }
}

/**
 * Durable `DomainStore` for `CustomDomains`, on the same `tenant_domains` table
 * `PrismaTenantSource` reads — so a verified custom domain resolves through the
 * source's `findByDomain` with no extra wiring.
 *
 * The table holds two kinds of row, told apart by `verificationToken`:
 *
 * - **mirror rows** (token `NULL`) — `tenant.domains`, written by
 *   `PrismaTenantSource.save()`/`create()`. Invisible to this store.
 * - **claim rows** (token set) — written here. The source never deletes them,
 *   so re-provisioning a tenant or changing its status keeps a verified domain
 *   and its proof; and its `findByDomain` ignores a claim until it is verified.
 *
 * The domain is the primary key, so one domain is one row whichever kind it
 * is: `add()` of a domain already mirrored or claimed throws `DomainTakenError`
 * (409 through `CustomDomains.add()`), translated from Prisma's `P2002` here.
 *
 * Needs the verification columns of the bundled schema (`verificationToken`,
 * `verified`, `createdAt`, `verifiedAt`) — an additive migration.
 */
export class PrismaDomainStore implements DomainStore {
  constructor(private readonly client: PrismaDomainStoreClient) {}

  async add(record: CustomDomain): Promise<void> {
    try {
      await this.client.tenantDomain.create({ data: toData(record) })
    } catch (error) {
      if (isUniqueViolation(error)) throw new DomainTakenError(record.domain)
      throw error
    }
  }

  async get(domain: string): Promise<CustomDomain | null> {
    const row = await this.client.tenantDomain.findUnique({ where: { domain } })
    return row ? toRecord(row) : null
  }

  async forTenant(tenantId: string): Promise<CustomDomain[]> {
    const rows = await this.client.tenantDomain.findMany({ where: { tenantId, ...CLAIM }, orderBy: { domain: 'asc' } })
    return rows.map(toRecord).filter((r): r is CustomDomain => r !== null)
  }

  async markVerified(domain: string, at: number): Promise<void> {
    await this.client.tenantDomain.updateMany({
      where: { domain, ...CLAIM },
      data: { verified: true, verifiedAt: new Date(at) },
    })
  }

  async markUnverified(domain: string): Promise<void> {
    await this.client.tenantDomain.updateMany({
      where: { domain, ...CLAIM },
      data: { verified: false, verifiedAt: null },
    })
  }

  async remove(domain: string): Promise<void> {
    await this.client.tenantDomain.deleteMany({ where: { domain, ...CLAIM } })
  }

  /**
   * One conditional `UPDATE … WHERE` on the expected tenant, token and
   * verified flag: of two callers racing on the same claim, the database lets
   * exactly one match, and the other gets `false`.
   */
  async replace(expected: CustomDomain, next: CustomDomain): Promise<boolean> {
    try {
      const { count } = await this.client.tenantDomain.updateMany({
        where: {
          domain: expected.domain,
          tenantId: expected.tenantId,
          verificationToken: expected.verificationToken,
          verified: expected.verified,
        },
        data: toData(next),
      })
      return count === 1
    } catch (error) {
      // `next` names a domain someone else holds: the swap did not happen.
      if (isUniqueViolation(error)) return false
      throw error
    }
  }

  async listVerified(): Promise<CustomDomain[]> {
    const rows = await this.client.tenantDomain.findMany({ where: { verified: true, ...CLAIM }, orderBy: { domain: 'asc' } })
    return rows.map(toRecord).filter((r): r is CustomDomain => r !== null)
  }
}

/**
 * Wire a durable domain store to your Prisma client, for `CustomDomains`:
 *
 * ```ts
 * const customDomains = new CustomDomains({ store: prismaDomainStore(prisma), reservedDomains: ['example.com'] })
 * ```
 */
export function prismaDomainStore(client: PrismaDomainStoreClient): PrismaDomainStore {
  let delegate: unknown
  try {
    delegate = (client as unknown as Record<string, unknown>)['tenantDomain']
  } catch {
    delegate = true // lazy/proxy client — validated at first use
  }
  if (delegate == null) {
    throw new Error(
      '@basaltkit/tenancy-prisma: the Prisma client has no `tenantDomain` model. Add the `TenantDomain` model ' +
        "(copy it from '@basaltkit/tenancy-prisma/schema.prisma'), migrate, then `prisma generate`.",
    )
  }
  return new PrismaDomainStore(client)
}
