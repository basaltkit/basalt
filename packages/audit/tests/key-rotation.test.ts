import { runWithContext } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import {
  Audit,
  AUDIT_CHAIN_GENESIS,
  AUDIT_SCAN_PAGE,
  type AuditEntry,
  type AuditIntegrity,
  auditKeyId,
  canonicalAuditEntry,
  checkAuditHash,
  computeAuditHash,
  computeAuditHashV2,
  createAuditVerifyCommand,
  MemoryAuditStore,
  parseAuditHash,
} from '../src/index.js'

/**
 * The v1 hash named neither its algorithm nor its key, so rotating the HMAC key
 * made every entry the old key signed fail verification — an audit trail whose
 * history breaks on a routine key rotation. v2 hashes record both (and digest
 * both), and the verifier holds a ring of keys picked by id.
 */

const rowsOf = (store: MemoryAuditStore): AuditEntry[] => (store as unknown as { entries: AuditEntry[] }).entries
const inTenant = <T>(tenantId: string, fn: () => T): T => runWithContext({ tenant: { id: tenantId } }, fn)
const audit = (store: MemoryAuditStore, integrity: AuditIntegrity) => new Audit(store, undefined, undefined, { integrity })

const KEY_A = 'a'.repeat(32)
const KEY_B = 'b'.repeat(32)

describe('hash chain v2 — algorithm and key id in every new entry', () => {
  it('records the algorithm and the key id in the hash, and digests both', async () => {
    const store = new MemoryAuditStore()
    const entry = await audit(store, { mode: 'hash-chain', key: KEY_A, keyId: '2026-09' }).record('x')

    expect(entry.hash).toMatch(/^v2:hmac-sha256:2026-09:[0-9a-f]{64}$/)
    expect(parseAuditHash(entry.hash)).toMatchObject({ version: 2, alg: 'hmac-sha256', keyId: '2026-09' })
    // The key id is authenticated, not just a label next to the digest.
    expect(canonicalAuditEntry(entry, { alg: 'hmac-sha256', keyId: '2026-09' })).not.toBe(
      canonicalAuditEntry(entry, { alg: 'hmac-sha256', keyId: 'other' }),
    )
  })

  it('defaults the key id to a fingerprint of the key, stable across instances', async () => {
    const a = await audit(new MemoryAuditStore(), { mode: 'hash-chain', key: KEY_A }).record('x')
    expect(parseAuditHash(a.hash)).toMatchObject({ keyId: auditKeyId(KEY_A) })
    expect(auditKeyId(KEY_A)).toBe(auditKeyId(KEY_A))
    expect(auditKeyId(KEY_A)).not.toBe(auditKeyId(KEY_B))
    expect(auditKeyId(KEY_A)).not.toContain(KEY_A.slice(0, 8))
  })

  it('writes an unkeyed chain as v2 sha256', async () => {
    const entry = await audit(new MemoryAuditStore(), 'hash-chain').record('x')
    expect(entry.hash).toBe(computeAuditHashV2(entry))
    expect(entry.hash).toMatch(/^v2:sha256:[0-9a-f]{64}$/)
  })
})

describe('hash chain v2 — key rotation keeps history verifiable', () => {
  const rotate = async () => {
    const store = new MemoryAuditStore()
    const before = audit(store, { mode: 'hash-chain', key: KEY_A, keyId: 'a' })
    for (let i = 0; i < 3; i++) await inTenant('acme', () => before.record('doc.edit', { i }))
    const after = audit(store, { mode: 'hash-chain', key: KEY_B, keyId: 'b', verifyKeys: [{ id: 'a', key: KEY_A }] })
    for (let i = 3; i < 6; i++) await inTenant('acme', () => after.record('doc.edit', { i }))
    return { store, after }
  }

  it('verifies entries signed by the retired key and by the new one', async () => {
    const { store, after } = await rotate()
    expect(rowsOf(store).map((e) => parseAuditHash(e.hash)).map((p) => (p as { keyId: string }).keyId)).toEqual([
      'a', 'a', 'a', 'b', 'b', 'b',
    ])
    expect(await after.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 6 })
  })

  it('names the missing key when the retired one is not configured', async () => {
    const { store } = await rotate()
    const withoutOld = audit(store, { mode: 'hash-chain', key: KEY_B, keyId: 'b' })
    expect(await withoutOld.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 1, reason: 'unknown-key' })
  })

  it('a bare retired key gets its default id — the one it recorded without an explicit keyId', async () => {
    const store = new MemoryAuditStore()
    await audit(store, { mode: 'hash-chain', key: KEY_A }).record('x')
    const rotated = audit(store, { mode: 'hash-chain', key: KEY_B, verifyKeys: [KEY_A] })
    await rotated.record('y')
    expect(await rotated.verify()).toMatchObject({ ok: true, checked: 2 })
  })

  it('still detects tampering under the retired key', async () => {
    const { store, after } = await rotate()
    const rows = rowsOf(store)
    rows[1] = { ...rows[1]!, payload: { i: 'edited' } }
    expect(await after.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 2, reason: 'hash-mismatch' })
  })

  it('relabelling an entry to another key id breaks it', async () => {
    const { store, after } = await rotate()
    const rows = rowsOf(store)
    const digest = (rows[0]!.hash as string).split(':').at(-1)!
    rows[0] = { ...rows[0]!, hash: `v2:hmac-sha256:b:${digest}` }
    expect(await after.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 1, reason: 'hash-mismatch' })
  })

  it('refuses an unkeyed v2 entry in a keyed chain (no downgrade to plain SHA-256)', async () => {
    const store = new MemoryAuditStore()
    const keyed = audit(store, { mode: 'hash-chain', key: KEY_A })
    await keyed.record('x')
    // A writer without the key appends a self-consistent plain SHA-256 entry.
    const head = rowsOf(store)[0]!
    const linked = { ...head, id: 'forged', seq: 2, prevHash: head.hash!, event: 'forged' }
    await store.append({ ...linked, hash: computeAuditHashV2(linked) })
    expect(await keyed.verify()).toMatchObject({ ok: false, firstBrokenAt: 2, reason: 'hash-mismatch' })
  })

  it('an unkeyed verifier reports a keyed entry as unknown-key', async () => {
    const store = new MemoryAuditStore()
    await audit(store, { mode: 'hash-chain', key: KEY_A }).record('x')
    expect(await audit(store, 'hash-chain').verify()).toMatchObject({ ok: false, reason: 'unknown-key' })
  })
})

describe('hash chain v2 — legacy (v1) entries keep verifying', () => {
  /** Writes `count` v1 entries the way the previous release did. */
  const seedV1 = async (store: MemoryAuditStore, count: number, key?: string) => {
    let prevHash = AUDIT_CHAIN_GENESIS
    for (let seq = 1; seq <= count; seq++) {
      const linked: AuditEntry = { id: `v1-${seq}`, source: 'manual', event: 'old', payload: { seq }, at: seq, seq, prevHash }
      const hash = computeAuditHash(linked, key)
      await store.append({ ...linked, hash })
      prevHash = hash
    }
  }

  it('a keyed chain that mixes v1 and v2 entries verifies, before and after a rotation', async () => {
    const store = new MemoryAuditStore()
    await seedV1(store, 3, KEY_A)
    const same = audit(store, { mode: 'hash-chain', key: KEY_A })
    await same.record('new')
    expect(rowsOf(store)[3]!.prevHash).toBe(rowsOf(store)[2]!.hash)
    expect(await same.verify()).toMatchObject({ ok: true, checked: 4 })

    // v1 recorded no key id, so after a rotation it is tried under every key held.
    const rotated = audit(store, { mode: 'hash-chain', key: KEY_B, keyId: 'b', verifyKeys: [KEY_A] })
    await rotated.record('newer')
    expect(await rotated.verify()).toMatchObject({ ok: true, checked: 5 })
  })

  it('an unkeyed v1 chain verifies under an unkeyed Audit', async () => {
    const store = new MemoryAuditStore()
    await seedV1(store, 2)
    const plain = audit(store, 'hash-chain')
    await plain.record('new')
    expect(await plain.verify()).toMatchObject({ ok: true, checked: 3 })
  })

  it('a v1 entry under a key the verifier does not hold fails', async () => {
    const store = new MemoryAuditStore()
    await seedV1(store, 1, KEY_A)
    expect(await audit(store, { mode: 'hash-chain', key: KEY_B }).verify()).toMatchObject({ ok: false, reason: 'hash-mismatch' })
  })

  it('checkAuditHash rejects anything that is neither format', () => {
    const entry: AuditEntry = { id: 'x', source: 'manual', event: 'x', payload: null, at: 1, seq: 1, prevHash: AUDIT_CHAIN_GENESIS, hash: 'v3:whatever' }
    expect(checkAuditHash(entry, new Map())).toBe('hash-mismatch')
    expect(parseAuditHash('v2:hmac-sha256:bad id:' + '0'.repeat(64))).toBeUndefined()
  })
})

describe('hash chain v2 — key configuration is validated up front', () => {
  const build = (integrity: AuditIntegrity) => () => audit(new MemoryAuditStore(), integrity)

  it('refuses a key id outside the grammar', () => {
    expect(build({ mode: 'hash-chain', key: KEY_A, keyId: 'has:colon' })).toThrow(/key id/)
    expect(build({ mode: 'hash-chain', key: KEY_A, keyId: 'x'.repeat(65) })).toThrow(/key id/)
  })

  it('refuses two different keys under one id', () => {
    expect(build({ mode: 'hash-chain', key: KEY_A, keyId: 'k', verifyKeys: [{ id: 'k', key: KEY_B }] })).toThrow(/two different keys/)
  })

  it('refuses keyId or verifyKeys without a signing key', () => {
    expect(build({ mode: 'hash-chain', keyId: 'k' })).toThrow(/needs a `key`/)
    expect(build({ mode: 'hash-chain', verifyKeys: [KEY_A] })).toThrow(/needs a `key`/)
  })

  it('refuses a short retired key', () => {
    expect(build({ mode: 'hash-chain', key: KEY_A, verifyKeys: ['short'] })).toThrow(/128 bits/)
  })
})

describe('audit:verify --expected-head with a v2 head', () => {
  it('accepts the head a previous run printed', async () => {
    const store = new MemoryAuditStore()
    const keyed = audit(store, { mode: 'hash-chain', key: KEY_A, keyId: 'a' })
    await keyed.record('x')
    const { head } = await keyed.verify()
    const command = createAuditVerifyCommand(() => keyed)
    const logs: string[] = []
    const io = { log: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) }

    expect(await command.handle({ flags: { 'expected-head': `${head!.seq}:${head!.hash}` }, io })).toBe(0)
    expect(await command.handle({ flags: { 'expected-head': `1:${'0'.repeat(64)}` }, io })).toBe(1)
    await expect(command.handle({ flags: { 'expected-head': '1:not-a-hash' }, io })).rejects.toThrow(/expected-head/)
  })
})

describe('verify — duplicate seq at the page boundary', () => {
  /**
   * A custom store without the `(chain, seq)` unique index can hold two rows
   * with one seq. Inside a page verify caught it; at the last seq of a page the
   * second row fell between the pages (the next one started at seq + 1) and
   * verify stayed green.
   */
  const seeded = async (count: number) => {
    const store = new MemoryAuditStore()
    const chained = audit(store, 'hash-chain')
    for (let i = 1; i <= count; i++) await chained.record('e', { i })
    return { store, chained, rows: rowsOf(store) }
  }

  it('detects a duplicate of the last entry of a page, read after it', async () => {
    const { chained, rows } = await seeded(AUDIT_SCAN_PAGE + 5)
    const last = rows[AUDIT_SCAN_PAGE - 1]!
    expect(last.seq).toBe(AUDIT_SCAN_PAGE)
    rows.splice(AUDIT_SCAN_PAGE, 0, { ...last, id: 'dup' })
    expect(await chained.verify()).toMatchObject({
      ok: false,
      reason: 'sequence-duplicate',
      firstBrokenAt: AUDIT_SCAN_PAGE + 1,
      entryId: 'dup',
    })
  })

  it('detects an exact replay of that row (same id, same hash)', async () => {
    const { chained, rows } = await seeded(AUDIT_SCAN_PAGE + 5)
    const last = rows[AUDIT_SCAN_PAGE - 1]!
    rows.splice(AUDIT_SCAN_PAGE, 0, { ...last })
    expect(await chained.verify()).toMatchObject({ ok: false, reason: 'sequence-duplicate', firstBrokenAt: AUDIT_SCAN_PAGE + 1 })
  })

  it('a chain of exactly two pages still verifies (the overlap is not a duplicate)', async () => {
    const { chained } = await seeded(AUDIT_SCAN_PAGE * 2)
    expect(await chained.verify()).toMatchObject({ ok: true, checked: AUDIT_SCAN_PAGE * 2 })
    expect(await chained.verify({ from: 3, to: AUDIT_SCAN_PAGE + 10 })).toMatchObject({ ok: true, checked: AUDIT_SCAN_PAGE + 8 })
  })
})
