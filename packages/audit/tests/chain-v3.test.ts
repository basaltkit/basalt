import { describe, expect, it } from 'vitest'
import {
  Audit,
  type AuditEntry,
  type AuditOptions,
  canonicalAuditEntry,
  checkAuditHash,
  computeAuditHashV2,
  computeAuditHashV3,
  isAuditHash,
  MemoryAuditStore,
  parseAuditHash,
} from '../src/index.js'

const KEY = 'k'.repeat(32)
const erasableKeyed: AuditOptions = { integrity: { mode: 'hash-chain', key: KEY, keyId: 'k1', erasable: true } }
const erasablePlain: AuditOptions = { integrity: { mode: 'hash-chain', erasable: true } }

const rowsOf = (store: MemoryAuditStore): AuditEntry[] => (store as unknown as { entries: AuditEntry[] }).entries
const tamper = (store: MemoryAuditStore, id: string, patch: (e: AuditEntry) => AuditEntry) => {
  const rows = rowsOf(store)
  const i = rows.findIndex((e) => e.id === id)
  rows[i] = patch(rows[i]!)
}

describe('v3 hashes (integrity.erasable)', () => {
  it('writes keyed v3 entries with a 256-bit nonce, and they verify', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, undefined, erasableKeyed)
    const a = await audit.record('x', { email: 'a@b.co' })
    const b = await audit.record('y')
    expect(a.hash).toMatch(/^v3:hmac-sha256:k1:[0-9a-f]{64}$/)
    expect(a.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.hash).toBe(computeAuditHashV3(a, { id: 'k1', key: KEY }))
    expect(parseAuditHash(a.hash)).toEqual({ version: 3, alg: 'hmac-sha256', keyId: 'k1', digest: a.hash!.slice(-64) })
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2 })
  })

  it('writes unkeyed v3 entries', async () => {
    const audit = new Audit(new MemoryAuditStore(), undefined, undefined, erasablePlain)
    const a = await audit.record('x')
    expect(a.hash).toMatch(/^v3:sha256:[0-9a-f]{64}$/)
    expect(isAuditHash(a.hash)).toBe(true)
    expect(parseAuditHash(a.hash)).toMatchObject({ version: 3, alg: 'sha256' })
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 1 })
  })

  it('a keyed verifier refuses v3:sha256, and a relabelled key id does not verify', async () => {
    const store = new MemoryAuditStore()
    const a = await new Audit(store, undefined, undefined, erasablePlain).record('x')
    expect(checkAuditHash(a, new Map([['k1', KEY]]))).toBe('hash-mismatch')
    const keyed = await new Audit(new MemoryAuditStore(), undefined, undefined, erasableKeyed).record('x')
    const relabelled = { ...keyed, hash: keyed.hash!.replace(':k1:', ':k2:') }
    expect(checkAuditHash(relabelled, new Map([['k1', KEY], ['k2', KEY]]))).toBe('hash-mismatch')
    expect(checkAuditHash(relabelled, new Map([['k1', KEY]]))).toBe('unknown-key')
  })

  it('the canonical v3 form is v2 plus the nonce', () => {
    const entry: AuditEntry = { id: 'e', source: 'manual', event: 'x', payload: { a: 1 }, at: 1, seq: 1, nonce: 'ab' }
    const v2 = JSON.parse(canonicalAuditEntry(entry, { alg: 'sha256' })) as Record<string, unknown>
    const v3 = JSON.parse(canonicalAuditEntry(entry, { alg: 'sha256', version: 3 })) as Record<string, unknown>
    expect(v3).toEqual({ ...v2, v: 3, nonce: 'ab' })
    expect(JSON.parse(canonicalAuditEntry({ ...entry, nonce: undefined }, { alg: 'sha256', version: 3 }))).toMatchObject({ nonce: null })
  })

  it('with erasable off, entries are v2 byte for byte (no nonce)', async () => {
    const audit = new Audit(new MemoryAuditStore(), undefined, undefined, { integrity: { mode: 'hash-chain', key: KEY, keyId: 'k1', erasable: false } })
    const a = await audit.record('x', { n: 1 })
    expect('nonce' in a).toBe(false)
    expect(a.hash).toBe(computeAuditHashV2(a, { id: 'k1', key: KEY }))
  })

  it('stripping the nonce of an unredacted v3 entry is a hash-mismatch', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, undefined, erasableKeyed)
    const a = await audit.record('x', { email: 'a@b.co' })
    tamper(store, a.id, ({ nonce: _n, ...e }) => e)
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'hash-mismatch', entryId: a.id })
  })

  it('a mixed v2/v3 chain verifies', async () => {
    const store = new MemoryAuditStore()
    await new Audit(store, undefined, undefined, { integrity: { mode: 'hash-chain', key: KEY, keyId: 'k1' } }).record('old')
    const audit = new Audit(store, undefined, undefined, erasableKeyed)
    const v3 = await audit.record('new')
    expect(v3.seq).toBe(2)
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2 })
  })

  it("redacting a v3 entry destroys its nonce: residual 'none'", async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, undefined, erasableKeyed)
    const a = await audit.record('x', { email: 'a@b.co' })
    const result = await audit.redact(a.id, { payload: ['email'], residual: 'none' })
    expect(result.residual).toBe('none')
    expect(result.entry.nonce).toBeUndefined()
    expect((await store.get(a.id))!.nonce).toBeUndefined()
    // The attestation is a v3 entry too.
    expect(result.attestation!.hash).toMatch(/^v3:hmac-sha256:k1:/)
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2, redacted: 1 })
    // Without the nonce the original hash cannot be recomputed, even with the right content.
    expect(checkAuditHash({ ...result.entry, payload: { email: 'a@b.co' } }, new Map([['k1', KEY]]))).toBe('hash-mismatch')
  })

  it('validates the option and refuses a store without get()', () => {
    const inner = new MemoryAuditStore()
    const noGet = {
      append: inner.append.bind(inner),
      query: inner.query.bind(inner),
      chainHead: inner.chainHead.bind(inner),
      readChain: inner.readChain.bind(inner),
      countUnchained: inner.countUnchained.bind(inner),
      chainTenants: inner.chainTenants.bind(inner),
    }
    expect(() => new Audit(noGet, undefined, undefined, erasablePlain)).toThrow(/erasable.*get\(\)/)
    expect(() => new Audit(inner, undefined, undefined, { integrity: { mode: 'hash-chain', erasable: 'yes' as never } })).toThrow(/boolean/)
  })

  it('fails closed on a store that drops the nonce — on the first write and every one after', async () => {
    class LossyStore extends MemoryAuditStore {
      override async append(entry: AuditEntry): Promise<void> {
        const { nonce: _n, ...rest } = entry
        return super.append(rest)
      }
    }
    const audit = new Audit(new LossyStore(), undefined, undefined, erasableKeyed)
    await expect(audit.record('x')).rejects.toThrow(/LossyStore.*nonce/)
    await expect(audit.record('y')).rejects.toThrow(/nonce/)
  })

  it('checks the nonce round-trip once per instance', async () => {
    const store = new MemoryAuditStore()
    let gets = 0
    const get = store.get.bind(store)
    store.get = async (id: string) => {
      gets++
      return get(id)
    }
    const audit = new Audit(store, undefined, undefined, erasableKeyed)
    await audit.record('a')
    await audit.record('b')
    expect(gets).toBe(1)
  })
})
