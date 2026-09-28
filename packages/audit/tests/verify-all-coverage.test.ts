/**
 * Framework audit residuals: `verifyAll()` only visited tenants that have a
 * chain, so a tenant whose only rows are forged seq-less inserts was never
 * checked; and `basalt audit:verify --all=true` (a string flag) verified the
 * system chain only and exited 0. Both reproduced against the previous release.
 */
import { describe, expect, it } from 'vitest'
import { Audit, type AuditQuery, type AuditStore, createAuditVerifyCommand, MemoryAuditStore } from '../src/index.js'

const chained = (store: AuditStore = new MemoryAuditStore()) => new Audit(store, undefined, undefined, { integrity: 'hash-chain' })

async function forgedTenant() {
  const store = new MemoryAuditStore()
  const audit = chained(store)
  await audit.record('system:boot') // integrity is on from here
  await store.append({ id: 'forged', source: 'manual', event: 'user:promoted', tenantId: 'victim', at: Date.now() + 5, payload: {} })
  return { store, audit }
}

describe('verifyAll() visits tenants that have rows but no chain', () => {
  it('a chain-less tenant with a row written after integrity began is reported broken', async () => {
    const { audit } = await forgedTenant()
    const all = await audit.verifyAll()
    const victim = all.chains.find((c) => c.tenantId === 'victim')
    expect(victim).toMatchObject({ ok: false, reason: 'unchained-entry', entryId: 'forged', checked: 0, unchained: 1 })
    expect(all.ok).toBe(false)
  })

  it('legacy rows of a chain-less tenant (written before any chain existed) stay ok; legacyUntil: 0 rejects them', async () => {
    const store = new MemoryAuditStore()
    await store.append({ id: 'old', source: 'manual', event: 'x', tenantId: 'quiet', at: 1, payload: {} })
    const audit = chained(store)
    await audit.record('system:boot')
    const all = await audit.verifyAll()
    expect(all.ok).toBe(true)
    expect(all.chains.find((c) => c.tenantId === 'quiet')).toMatchObject({ ok: true, unchained: 1, checked: 0 })
    expect((await audit.verifyAll({ legacyUntil: 0 })).chains.find((c) => c.tenantId === 'quiet')).toMatchObject({
      ok: false,
      reason: 'unchained-entry',
    })
  })

  it('an explicit legacyUntil after the forged row accepts it as legacy', async () => {
    const { audit } = await forgedTenant()
    expect((await audit.verifyAll({ legacyUntil: Date.now() + 60_000 })).ok).toBe(true)
  })

  it('works through query() for a store without auditTenants()', async () => {
    const { store: inner } = await forgedTenant()
    const store: AuditStore = {
      append: (e) => inner.append(e),
      query: (q: AuditQuery) => inner.query(q),
      chainHead: (t) => inner.chainHead(t),
      readChain: (t, r) => inner.readChain(t, r),
      countUnchained: (t) => inner.countUnchained(t),
      chainTenants: () => inner.chainTenants(),
      readUnchained: (t, r) => inner.readUnchained(t, r),
    }
    const all = await chained(store).verifyAll()
    expect(all.chains.find((c) => c.tenantId === 'victim')).toMatchObject({ ok: false, reason: 'unchained-entry' })
  })
})

describe('audit:verify flag parsing', () => {
  const run = async (flags: Record<string, string | boolean>) => {
    const { audit } = await forgedTenant()
    const lines: string[] = []
    const io = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) }
    const code = await createAuditVerifyCommand(() => audit).handle({ flags, io })
    return { code, lines }
  }

  it.each([true, 'true', '1', 'yes', ''])('--all=%j verifies every chain', async (all) => {
    const { code, lines } = await run({ all })
    expect(code).toBe(1)
    expect(lines.some((l) => l.startsWith('victim:'))).toBe(true)
  })

  it.each(['false', '0', 'no'])('--all=%j means a single chain', async (all) => {
    const { code, lines } = await run({ all })
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
  })

  it('an unrecognised --all value is an error, not a silent single-chain run', async () => {
    await expect(run({ all: 'maybe' })).rejects.toThrow(TypeError)
  })

  it('--tenant without a value is an error, not the system chain', async () => {
    await expect(run({ tenant: true })).rejects.toThrow(TypeError)
    await expect(run({ tenant: '' })).rejects.toThrow(TypeError)
  })

  it('--all cannot be combined with single-chain flags', async () => {
    await expect(run({ all: true, tenant: 'victim' })).rejects.toThrow(TypeError)
    await expect(run({ all: true, from: '2' })).rejects.toThrow(TypeError)
  })
})
