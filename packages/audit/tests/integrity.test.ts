import { createApp, ensureMetadata, runWithContext } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import {
  AUDIT,
  Audit,
  AUDIT_CHAIN_GENESIS,
  AuditChainConflictError,
  auditPlugin,
  type AuditEntry,
  type AuditStore,
  canonicalAuditEntry,
  computeAuditHash,
  MemoryAuditStore,
} from '../src/index.js'

/** Reaches into the memory store's rows so a test can play the attacker. */
const rowsOf = (store: MemoryAuditStore): AuditEntry[] => (store as unknown as { entries: AuditEntry[] }).entries

const chained = (store: AuditStore = new MemoryAuditStore()) => new Audit(store, undefined, undefined, { integrity: 'hash-chain' })

const inTenant = <T>(tenantId: string, fn: () => T): T => runWithContext({ tenant: { id: tenantId } }, fn)

describe('hash chain — append', () => {
  it('links each entry to the previous one with seq, prevHash and a SHA-256 hash', async () => {
    const audit = chained()
    const a = await audit.record('doc.created', { id: 1 })
    const b = await audit.record('doc.updated', { id: 1, title: 'x' })

    expect(a.seq).toBe(1)
    expect(a.prevHash).toBe(AUDIT_CHAIN_GENESIS)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.seq).toBe(2)
    expect(b.prevHash).toBe(a.hash)
    expect(b.hash).toBe(computeAuditHash(b))
  })

  it('does not chain entries when integrity is off (default)', async () => {
    const entry = await new Audit(new MemoryAuditStore()).record('x')
    expect(entry.seq).toBeUndefined()
    expect(entry.hash).toBeUndefined()
  })

  it('canonical serialization is independent of payload key order', () => {
    const base = { id: 'e', source: 'manual', event: 'x', at: 1, seq: 1, prevHash: AUDIT_CHAIN_GENESIS } as const
    expect(canonicalAuditEntry({ ...base, payload: { a: 1, b: { c: 2, d: 3 } } })).toBe(
      canonicalAuditEntry({ ...base, payload: { b: { d: 3, c: 2 }, a: 1 } }),
    )
  })

  it('keeps one independent chain per tenant plus one for system entries', async () => {
    const audit = chained()
    const a1 = await inTenant('acme', () => audit.record('x'))
    const g1 = await inTenant('globex', () => audit.record('x'))
    const s1 = await audit.record('system.x')
    const a2 = await inTenant('acme', () => audit.record('y'))

    expect([a1.seq, g1.seq, s1.seq, a2.seq]).toEqual([1, 1, 1, 2])
    expect(a2.prevHash).toBe(a1.hash)
    expect(g1.prevHash).toBe(AUDIT_CHAIN_GENESIS)

    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 2 })
    expect(await audit.verify({ tenantId: 'globex' })).toMatchObject({ ok: true, checked: 1 })
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 1 }) // system chain
  })

  it('tampering with one tenant does not affect another tenant chain', async () => {
    const store = new MemoryAuditStore()
    const audit = chained(store)
    await inTenant('acme', () => audit.record('x', { n: 1 }))
    await inTenant('globex', () => audit.record('x', { n: 1 }))
    const rows = rowsOf(store)
    rows[0] = { ...rows[0]!, payload: { n: 999 } }

    expect((await audit.verify({ tenantId: 'acme' })).ok).toBe(false)
    expect((await audit.verify({ tenantId: 'globex' })).ok).toBe(true)
  })

  it('parallel appends keep a single valid chain (in-process mutex)', async () => {
    const audit = chained()
    const entries = await Promise.all(Array.from({ length: 50 }, (_, i) => inTenant('acme', () => audit.record('n', { i }))))
    expect(entries.map((e) => e.seq).sort((x, y) => x! - y!)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 50 })
  })

  it('two Audit instances on one store (two replicas) retry on conflict instead of forking', async () => {
    const store = new MemoryAuditStore()
    const replicaA = chained(store)
    const replicaB = chained(store)
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => inTenant('acme', () => (i % 2 ? replicaA : replicaB).record('n', { i }))),
    )
    expect(await replicaA.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 40 })
  })

  it('the memory store rejects a duplicate (chain, seq) with AuditChainConflictError', async () => {
    const store = new MemoryAuditStore()
    const entry = await chained(store).record('x')
    await expect(store.append({ ...entry, id: 'other' })).rejects.toBeInstanceOf(AuditChainConflictError)
  })

  it('refuses hash-chain integrity on a store that cannot read chains', () => {
    const bare: AuditStore = { append: async () => {}, query: async () => [] }
    expect(() => chained(bare)).toThrow(/hash-chain/)
  })

  it('supports an HMAC key so a DB writer without the key cannot recompute hashes', async () => {
    const key = 'k'.repeat(32)
    const audit = new Audit(new MemoryAuditStore(), undefined, undefined, { integrity: { mode: 'hash-chain', key } })
    const entry = await audit.record('x')
    expect(entry.hash).toBe(computeAuditHash(entry, key))
    expect(entry.hash).not.toBe(computeAuditHash(entry))
    expect((await audit.verify()).ok).toBe(true)
    expect(() => new Audit(new MemoryAuditStore(), undefined, undefined, { integrity: { mode: 'hash-chain', key: 'short' } })).toThrow(
      /128 bits/,
    )
  })
})

describe('hash chain — verify detects tampering', () => {
  const seeded = async (count = 5) => {
    const store = new MemoryAuditStore()
    const audit = chained(store)
    for (let i = 1; i <= count; i++) await inTenant('acme', () => audit.record('doc.edit', { i }))
    return { store, audit, rows: rowsOf(store) }
  }

  it('reports an intact chain', async () => {
    const { audit } = await seeded()
    const result = await audit.verify({ tenantId: 'acme' })
    expect(result).toMatchObject({ ok: true, checked: 5, unchained: 0 })
    expect(result.head?.seq).toBe(5)
  })

  it('detects an edited payload', async () => {
    const { audit, rows } = await seeded()
    rows[2] = { ...rows[2]!, payload: { i: 42 } }
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 3, reason: 'hash-mismatch', checked: 2 })
  })

  it('detects an edited actor / timestamp', async () => {
    const { audit, rows } = await seeded()
    rows[1] = { ...rows[1]!, actorId: 'mallory' }
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 2 })
  })

  it('detects a deleted row', async () => {
    const { audit, rows } = await seeded()
    rows.splice(2, 1)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 3, reason: 'sequence-gap' })
  })

  it('detects reordered rows (seq swapped)', async () => {
    const { audit, rows } = await seeded()
    const [second, third] = [rows[1]!, rows[2]!]
    rows[1] = { ...third, seq: 2 }
    rows[2] = { ...second, seq: 3 }
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 2 })
  })

  it('detects a forged row inserted mid-chain', async () => {
    const { audit, rows } = await seeded()
    // The forger computes a self-consistent hash but cannot also rewrite the
    // successor's prevHash without re-hashing every later entry.
    const forged = { ...rows[1]!, id: 'forged', seq: 3, payload: { i: 'forged' }, prevHash: rows[1]!.hash! }
    const withHash = { ...forged, hash: computeAuditHash(forged) }
    rows.splice(2, 0, withHash)
    for (let i = 3; i < rows.length; i++) rows[i] = { ...rows[i]!, seq: rows[i]!.seq! + 1 }
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 4, reason: 'prev-hash-mismatch' })
  })

  it('detects a forged duplicate seq', async () => {
    const { audit, rows } = await seeded()
    rows.splice(2, 0, { ...rows[1]!, id: 'dup' })
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 3 })
  })

  it('verifies a sub-range anchored on the predecessor', async () => {
    const { audit, rows } = await seeded(8)
    expect(await audit.verify({ tenantId: 'acme', from: 4, to: 6 })).toMatchObject({ ok: true, checked: 3 })
    rows[7] = { ...rows[7]!, payload: 'x' } // outside the window
    expect((await audit.verify({ tenantId: 'acme', from: 4, to: 6 })).ok).toBe(true)
    expect(await audit.verify({ tenantId: 'acme', from: 5 })).toMatchObject({ ok: false, firstBrokenAt: 8 })
    await expect(audit.verify({ tenantId: 'acme', from: 0 })).rejects.toThrow(TypeError)
  })

  it('forces the context tenant (a caller cannot verify another tenant chain)', async () => {
    const { audit, rows } = await seeded()
    rows[0] = { ...rows[0]!, payload: 'tampered' }
    const result = await inTenant('globex', () => audit.verify({ tenantId: 'acme' }))
    expect(result).toMatchObject({ tenantId: 'globex', ok: true, checked: 0 })
  })

  it('reports rows written before integrity was enabled as unchained, not broken', async () => {
    const store = new MemoryAuditStore()
    await inTenant('acme', () => new Audit(store).record('legacy.1'))
    await inTenant('acme', () => new Audit(store).record('legacy.2'))
    const audit = chained(store)
    await inTenant('acme', () => audit.record('new.1'))
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 1, unchained: 2 })
  })

  it('verifyAll() checks every chain and flags the broken one', async () => {
    const store = new MemoryAuditStore()
    const audit = chained(store)
    await inTenant('acme', () => audit.record('x'))
    await inTenant('globex', () => audit.record('x'))
    await audit.record('sys')
    const rows = rowsOf(store)
    rows[1] = { ...rows[1]!, event: 'tampered' }
    const all = await audit.verifyAll()
    expect(all.ok).toBe(false)
    expect(all.chains.map((c) => [c.tenantId, c.ok])).toEqual([
      [undefined, true],
      ['acme', true],
      ['globex', false],
    ])
  })
})

describe('auditPlugin — integrity + audit:verify command', () => {
  const commandsOf = (app: { container: Parameters<typeof ensureMetadata>[0] }) =>
    ensureMetadata(app.container).get<{ name: string; handle(ctx: unknown): Promise<number | void> }>('commands')

  const io = () => {
    const out: string[] = []
    return { out, io: { log: (m: string) => out.push(m), error: (m: string) => out.push(`ERR ${m}`), table: () => {}, confirm: async () => false } }
  }

  it('wires integrity through the plugin and registers audit:verify', async () => {
    const store = new MemoryAuditStore()
    const app = await createApp({ plugins: [auditPlugin({ store, integrity: 'hash-chain', events: [] })] }).boot()
    const audit = app.container.get(AUDIT)
    await inTenant('acme', () => audit.record('x'))
    expect((await audit.verify({ tenantId: 'acme' })).ok).toBe(true)

    const command = commandsOf(app).find((c) => c.name === 'audit:verify')
    expect(command).toBeDefined()
    const ok = io()
    expect(await command!.handle({ args: [], flags: { tenant: 'acme' }, io: ok.io })).toBe(0)
    expect(ok.out.join('\n')).toMatch(/ok/i)

    rowsOf(store)[0] = { ...rowsOf(store)[0]!, payload: 'tampered' }
    const bad = io()
    expect(await command!.handle({ args: [], flags: { all: true }, io: bad.io })).toBe(1)
    expect(bad.out.join('\n')).toMatch(/acme.*hash-mismatch/)
  })

  it('does not register audit:verify when integrity is off', async () => {
    const app = await createApp({ plugins: [auditPlugin({ events: [] })] }).boot()
    expect(commandsOf(app).some((c) => c.name === 'audit:verify')).toBe(false)
  })
})

describe('hash chain — edge cases', () => {
  it('validates the integrity option and the verify range', async () => {
    expect(() => new Audit(new MemoryAuditStore(), undefined, undefined, { integrity: { mode: 'merkle' as 'hash-chain' } })).toThrow(/Unknown/)
    expect(() => new Audit(new MemoryAuditStore(), undefined, undefined, { integrity: { mode: 'hash-chain', key: 42 as unknown as string } })).toThrow(
      /string or a Uint8Array/,
    )
    const audit = chained()
    await expect(audit.verify({ from: 3, to: 2 })).rejects.toThrow(/`to`/)
    await expect(new Audit({ append: async () => {}, query: async () => [] }).verify()).rejects.toThrow(/hash-chain methods/)
  })

  it('reports a missing predecessor when a window starts after a deleted anchor', async () => {
    const store = new MemoryAuditStore()
    const audit = chained(store)
    for (let i = 0; i < 4; i++) await audit.record('x', { i })
    rowsOf(store).splice(1, 1) // delete seq 2
    expect(await audit.verify({ from: 3 })).toMatchObject({ ok: false, firstBrokenAt: 3, reason: 'missing-predecessor' })
  })

  it('gives up after repeated conflicts, and rethrows non-conflict store errors', async () => {
    const conflicting = Object.assign(new MemoryAuditStore(), {
      append: async (entry: AuditEntry) => {
        throw new AuditChainConflictError(entry.tenantId, entry.seq)
      },
    })
    await expect(chained(conflicting).record('x')).rejects.toBeInstanceOf(AuditChainConflictError)
    const failing = Object.assign(new MemoryAuditStore(), {
      append: async () => {
        throw new Error('disk full')
      },
    })
    await expect(chained(failing).record('x')).rejects.toThrow('disk full')
  })

  it('a redactor that drops the request fields wins', async () => {
    const audit = new Audit(new MemoryAuditStore(), (p) => (typeof p === 'object' && p !== null && 'ip' in p ? undefined : p), undefined, {
      requestContext: () => ({ ip: '203.0.113.9', userAgent: 'curl/8' }),
    })
    const entry = await audit.record('x', { k: 1 })
    expect(entry.ip).toBeUndefined()
    expect(entry.userAgent).toBeUndefined()
    expect(entry.payload).toEqual({ k: 1 })
  })

  it('hashes JSON-normalized payloads (undefined members, dates) as persisted', () => {
    const base = { id: 'e', source: 'manual', event: 'x', at: 1 } as const
    const when = new Date(0)
    expect(canonicalAuditEntry({ ...base, payload: { a: undefined, d: when } })).toBe(
      canonicalAuditEntry({ ...base, payload: { d: when.toISOString() } }),
    )
    expect(canonicalAuditEntry({ ...base, payload: undefined })).toBe(canonicalAuditEntry({ ...base, payload: null }))
    expect(canonicalAuditEntry({ ...base, payload: () => 1 })).toBe(canonicalAuditEntry({ ...base, payload: null }))
  })

  it('audit:verify accepts --from/--to and rejects a malformed value', async () => {
    const store = new MemoryAuditStore()
    const app = await createApp({ plugins: [auditPlugin({ store, integrity: 'hash-chain', events: [] })] }).boot()
    for (let i = 0; i < 3; i++) await app.container.get(AUDIT).record('x')
    const command = ensureMetadata(app.container)
      .get<{ name: string; handle(ctx: unknown): Promise<number> }>('commands')
      .find((c) => c.name === 'audit:verify')!
    const out: string[] = []
    const io = { log: (m: string) => out.push(m), error: (m: string) => out.push(m) }
    expect(await command.handle({ flags: { from: '2', to: '3' }, io })).toBe(0)
    expect(out[0]).toMatch(/\(system\): ok — 2 entries verified, head #3/)
    await expect(command.handle({ flags: { from: 'abc' }, io })).rejects.toThrow(/--from/)
  })
})
