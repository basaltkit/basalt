import { describe, expect, it } from 'vitest'
import { ColumnLengthError, type PrismaTenancyClient, prismaTenantSource } from '../src/index.js'

function recording(): { client: PrismaTenancyClient; writes: string[] } {
  const writes: string[] = []
  const w = (op: string) => async () => {
    writes.push(op)
    return { count: 0 } as never
  }
  const delegates = {
    tenant: { findUnique: async () => null, findMany: async () => [], create: w('tenant.create'), upsert: w('tenant.upsert'), deleteMany: w('tenant.deleteMany') },
    tenantDomain: { findUnique: async () => null, findMany: async () => [], deleteMany: w('domain.deleteMany'), createMany: w('domain.createMany') },
  }
  return { writes, client: { ...delegates, $transaction: (fn) => fn(delegates) } as PrismaTenancyClient }
}

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it("'mysql' accepts a 253-char DNS name (VARCHAR(255)) and refuses a longer one before any write", async () => {
    const { client, writes } = recording()
    const source = prismaTenantSource(client, { columnLimits: 'mysql' })
    const label = (n: number) => 'a'.repeat(n)
    const fqdn253 = `${label(63)}.${label(63)}.${label(63)}.${label(61)}`
    await source.create({ id: 'acme', domains: [fqdn253] })
    // nothing to drop for a new tenant: only the missing domain is inserted
    expect(writes).toEqual(['tenant.create', 'domain.createMany'])
    await expect(source.save({ id: 'acme', domains: [`${fqdn253}.xyz`] })).rejects.toMatchObject({
      column: 'TenantDomain.domain',
      limit: 255,
    })
    await expect(source.create({ id: 't'.repeat(192) })).rejects.toBeInstanceOf(ColumnLengthError)
    expect(writes).toHaveLength(2)
  })
})
