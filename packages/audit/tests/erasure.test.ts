import { createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import {
  AUDIT,
  Audit,
  AUDIT_ERASED,
  AUDIT_REDACTED_EVENT,
  AuditChainConflictError,
  AuditEntryNotFoundError,
  AuditRedactionConflictError,
  AuditRedactionRefusedError,
  auditPlugin,
  auditRedactionState,
  type AuditEntry,
  type AuditOptions,
  type AuditRedactionWrite,
  type AuditStore,
  computeAuditHashV2,
  createAuditVerifyCommand,
  MemoryAuditStore,
} from '../src/index.js'

const KEY = 'k'.repeat(32)
const keyed: AuditOptions = { integrity: { mode: 'hash-chain', key: KEY, keyId: 'k1' } }
const plain: AuditOptions = { integrity: 'hash-chain' }

/** Reaches into the memory store's rows so a test can play the attacker. */
const rowsOf = (store: MemoryAuditStore): AuditEntry[] => (store as unknown as { entries: AuditEntry[] }).entries
const rowIndex = (store: MemoryAuditStore, id: string) => rowsOf(store).findIndex((e) => e.id === id)
const tamper = (store: MemoryAuditStore, id: string, patch: (e: AuditEntry) => AuditEntry) => {
  const i = rowIndex(store, id)
  rowsOf(store)[i] = patch(rowsOf(store)[i]!)
}

const make = (options: AuditOptions = keyed, store = new MemoryAuditStore(), tenancy = false) => ({
  store,
  audit: new Audit(store, undefined, () => tenancy, options),
})

const inTenant = <T>(tenantId: string, fn: () => T, userId?: string): T =>
  runWithContext({ tenant: { id: tenantId }, ...(userId ? { user: { id: userId } } : {}) }, fn)

const customer = { orderId: 'o-1', customer: { email: 'ana@example.com', name: 'Ana' }, items: [{ sku: 'a', note: 'gift for Ana' }, { sku: 'b', note: 'x' }] }

describe('Audit.redact — erasing', () => {
  it('erases a top-level and a nested path, keeps the hash, and verify stays green through the attestation', async () => {
    const { store, audit } = make()
    const entry = await audit.record('order.placed', customer)
    await audit.record('after', { n: 1 })
    const result = await audit.redact(entry.id, { payload: ['customer.email', 'items[].note'], reasonRef: 'DSR-1' })

    expect(result.changed).toBe(true)
    expect(result.residual).toBe('keyed')
    expect(result.entry.hash).toBe(entry.hash)
    expect(result.entry.payload).toEqual({
      orderId: 'o-1',
      customer: { email: AUDIT_ERASED, name: 'Ana' },
      items: [{ sku: 'a', note: AUDIT_ERASED }, { sku: 'b', note: AUDIT_ERASED }],
    })
    expect(result.entry.redaction).toEqual({
      attestationId: result.attestation!.id,
      payload: ['customer.email', 'items[].note'],
      ip: false,
      userAgent: false,
    })
    const att = result.attestation!
    expect(att).toMatchObject({ event: AUDIT_REDACTED_EVENT, source: 'manual', seq: 3, tenantId: undefined })
    expect(att.payload).toEqual({
      entryId: entry.id,
      seq: 1,
      hash: entry.hash,
      erased: { payload: ['customer.email', 'items[].note'], ip: false, userAgent: false },
      state: auditRedactionState(result.entry),
      reasonRef: 'DSR-1',
    })
    expect(JSON.stringify(rowsOf(store))).not.toContain('ana@example.com')
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 3, redacted: 1 })
  })

  it("erases the whole payload with 'all', and ip / userAgent", async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, undefined, { ...keyed, requestContext: () => ({ ip: '203.0.113.9', userAgent: 'curl/8' }) })
    const entry = await audit.record('login', { email: 'ana@example.com' })
    expect(entry.ip).toBe('203.0.113.9')
    const result = await audit.redact(entry.id, { payload: 'all', ip: true, userAgent: true })
    expect(result.entry.payload).toBe(AUDIT_ERASED)
    expect(result.entry.ip).toBeUndefined()
    expect(result.entry.userAgent).toBeUndefined()
    expect(result.entry.redaction).toMatchObject({ payload: 'all', ip: true, userAgent: true })
    expect(await audit.verify()).toMatchObject({ ok: true, redacted: 1 })
  })

  it('re-redaction merges into one cumulative marker and moves it to the newer attestation', async () => {
    const { audit } = make()
    const entry = await audit.record('order.placed', customer)
    const first = await audit.redact(entry.id, { payload: ['customer.email'] })
    const second = await audit.redact(entry.id, { payload: ['customer.name'], ip: true })
    expect(second.changed).toBe(true)
    expect(second.entry.redaction).toEqual({
      attestationId: second.attestation!.id,
      payload: ['customer.email', 'customer.name'],
      ip: true,
      userAgent: false,
    })
    expect(second.attestation!.id).not.toBe(first.attestation!.id)
    const third = await audit.redact(entry.id, { payload: 'all' })
    expect(third.entry.redaction?.payload).toBe('all')
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 4, redacted: 1 })
  })

  it('is idempotent: a request that changes nothing writes nothing', async () => {
    const { store, audit } = make()
    const entry = await audit.record('order.placed', customer)
    await audit.redact(entry.id, { payload: ['customer.email'] })
    const before = rowsOf(store).length
    const again = await audit.redact(entry.id, { payload: ['customer.email', 'does.not.exist'], ip: true })
    expect(again).toMatchObject({ changed: false, attestation: undefined })
    expect(rowsOf(store)).toHaveLength(before)
  })

  it('verifies a redacted legacy v1 row under a keyed verifier', async () => {
    const { store, audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    // Rewrite the first entry as a v1 HMAC row (as written before key ids existed).
    const { createHmac } = await import('node:crypto')
    const { canonicalAuditEntry } = await import('../src/chain.js')
    const v1 = createHmac('sha256', KEY).update(`${entry.prevHash}\n${canonicalAuditEntry(entry)}`).digest('hex')
    tamper(store, entry.id, (e) => ({ ...e, hash: v1 }))
    const result = await audit.redact(entry.id, { payload: ['email'] })
    expect(result.residual).toBe('keyed')
    expect(await audit.verify()).toMatchObject({ ok: true, redacted: 1 })
  })

  it("an unkeyed chain needs residual: 'public'", async () => {
    const { audit } = make(plain)
    const entry = await audit.record('x', { email: 'a@b.co' })
    const refused = await audit.redact(entry.id, { payload: ['email'] }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(AuditRedactionRefusedError)
    expect((refused as AuditRedactionRefusedError).reason).toBe('residual')
    expect((refused as AuditRedactionRefusedError).code).toBe('AUDIT_REDACTION_REFUSED')
    const ok = await audit.redact(entry.id, { payload: ['email'], residual: 'public' })
    expect(ok.residual).toBe('public')
    expect(await audit.verify()).toMatchObject({ ok: true, redacted: 1 })
  })

  it("residual: 'none' refuses a keyed entry", async () => {
    const { audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    await expect(audit.redact(entry.id, { payload: ['email'], residual: 'none' })).rejects.toMatchObject({ reason: 'residual' })
  })

  it("redacts unchained entries under integrity 'none' (the attestation is a plain entry)", async () => {
    const { store, audit } = make({})
    const entry = await audit.record('x', { email: 'a@b.co' })
    const result = await audit.redact(entry.id, { payload: ['email'], residual: 'none' })
    expect(result.residual).toBe('none')
    expect(result.attestation).toMatchObject({ event: AUDIT_REDACTED_EVENT })
    expect(result.attestation!.seq).toBeUndefined()
    expect(result.attestation!.hash).toBeUndefined()
    // Re-redacting checks the existing (unchained) attestation first.
    const again = await audit.redact(entry.id, { ip: true })
    expect(again.changed).toBe(false)
    expect(rowsOf(store)).toHaveLength(2)
  })

  it('verifies a redacted head row, and windows that leave the attestation outside', async () => {
    const { audit } = make()
    await audit.record('a', { n: 1 })
    const target = await audit.record('b', { email: 'a@b.co' })
    const { attestation } = await audit.redact(target.id, { payload: ['email'] })
    expect(await audit.verify({ from: 2, to: 2 })).toMatchObject({ ok: true, checked: 1, redacted: 1 })
    expect(await audit.verify({ from: 2 })).toMatchObject({ ok: true, checked: 2, redacted: 1, head: { seq: 3, hash: attestation!.hash } })
    // The redacted row was the head when it was redacted: an anchor taken before still holds.
    expect(await audit.verify({ expectedHead: { seq: 2, hash: target.hash! } })).toMatchObject({ ok: true })
  })

  it('a system-path redaction of a tenant row puts the attestation in THAT tenant chain', async () => {
    const { audit } = make(keyed, new MemoryAuditStore(), true)
    const entry = await inTenant('acme', () => audit.record('x', { email: 'a@b.co' }))
    const { attestation } = await audit.systemRedact(entry.id, { payload: ['email'], actorId: 'dpo-1' })
    expect(attestation).toMatchObject({ tenantId: 'acme', seq: 2, actorId: 'dpo-1' })
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 2, redacted: 1 })
    expect(await audit.verifyAll()).toMatchObject({ ok: true })
  })

  it('the attestation bypasses fieldPolicies and a mask-everything redactor', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, () => '[masked]', undefined, {
      ...keyed,
      fieldPolicies: { [AUDIT_REDACTED_EVENT]: { omit: ['hash', 'state'] } },
    })
    // record() masks everything — rewrite the payload as an app with a lenient redactor would have stored it.
    const entry = await audit.record('x', { email: 'a@b.co' })
    expect(entry.payload).toBe('[masked]')
    const { attestation } = await audit.redact(entry.id, { payload: 'all' })
    expect(attestation!.payload).toMatchObject({ hash: entry.hash, state: expect.stringMatching(/^sha256:/) })
    expect(await audit.verify()).toMatchObject({ ok: true, redacted: 1 })
  })

  it('records the eraser and the request fields of the context on the attestation', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, () => true, { ...keyed, requestContext: () => ({ ip: '198.51.100.1' }) })
    const entry = await inTenant('acme', () => audit.record('x', { email: 'a@b.co' }), 'u1')
    const { attestation } = await runWithContext({ tenant: { id: 'acme' }, user: { id: 'dpo' }, requestId: 'r-9' }, () =>
      audit.redact(entry.id, { payload: ['email'] }),
    )
    expect(attestation).toMatchObject({ actorId: 'dpo', requestId: 'r-9', ip: '198.51.100.1', tenantId: 'acme' })
  })
})

describe('Audit.redact — scope', () => {
  it('inside a tenant context, another tenant id is not found (no existence oracle)', async () => {
    const { audit } = make(keyed, new MemoryAuditStore(), true)
    const other = await inTenant('globex', () => audit.record('x', { email: 'a@b.co' }))
    const system = await audit.record('sys', { email: 'a@b.co' })
    for (const id of [other.id, system.id, 'missing']) {
      const error = await inTenant('acme', () => audit.redact(id, { payload: ['email'], tenantId: 'globex' })).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AuditEntryNotFoundError)
      expect(error).toMatchObject({ code: 'AUDIT_ENTRY_NOT_FOUND', status: 404 })
    }
  })

  it('without a context, tenantId pins the tenant', async () => {
    const { audit } = make(keyed, new MemoryAuditStore(), true)
    const entry = await inTenant('acme', () => audit.record('x', { email: 'a@b.co' }))
    await expect(audit.redact(entry.id, { payload: ['email'], tenantId: 'globex' })).rejects.toBeInstanceOf(AuditEntryNotFoundError)
    expect((await audit.redact(entry.id, { payload: ['email'], tenantId: 'acme' })).changed).toBe(true)
  })

  it('refuses the silent system-wide scope when tenancy is active', async () => {
    const { audit } = make(keyed, new MemoryAuditStore(), true)
    const entry = await inTenant('acme', () => audit.record('x', { email: 'a@b.co' }))
    await expect(audit.redact(entry.id, { payload: ['email'] })).rejects.toThrow(/systemRedact/)
  })

  it('allows the unscoped call in a single-tenant app', async () => {
    const { audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    expect((await audit.redact(entry.id, { payload: ['email'] })).changed).toBe(true)
  })

  it('systemRedact honours a pinned tenantId', async () => {
    const { audit } = make(keyed, new MemoryAuditStore(), true)
    const entry = await inTenant('acme', () => audit.record('x', { email: 'a@b.co' }))
    await expect(audit.systemRedact(entry.id, { payload: ['email'], tenantId: 'globex' })).rejects.toBeInstanceOf(AuditEntryNotFoundError)
  })

  it('a request.actorId that differs from the context user throws', async () => {
    const { audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    await expect(
      runWithContext({ user: { id: 'u1' } }, () => audit.redact(entry.id, { payload: ['email'], actorId: 'u2' })),
    ).rejects.toThrow(/actorId cannot differ/)
  })
})

describe('Audit.redact — refusals and validation', () => {
  it('refuses a tampered entry (anti-laundering)', async () => {
    const { store, audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co', amount: 10 })
    tamper(store, entry.id, (e) => ({ ...e, payload: { email: 'a@b.co', amount: 1_000_000 } }))
    await expect(audit.redact(entry.id, { payload: ['email'] })).rejects.toMatchObject({ reason: 'unverified' })
  })

  it('refuses a redacted entry whose attestation no longer matches', async () => {
    const { store, audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co', amount: 10 })
    await audit.redact(entry.id, { payload: ['email'] })
    tamper(store, entry.id, (e) => ({ ...e, payload: { email: AUDIT_ERASED, amount: 99 } }))
    await expect(audit.redact(entry.id, { ip: true })).rejects.toMatchObject({ reason: 'unverified' })
  })

  it('refuses a chained entry on an Audit without integrity', async () => {
    const store = new MemoryAuditStore()
    const entry = await new Audit(store, undefined, undefined, keyed).record('x', { email: 'a@b.co' })
    await expect(new Audit(store).redact(entry.id, { payload: ['email'] })).rejects.toMatchObject({ reason: 'unverified' })
  })

  it('refuses an entry signed under a key this Audit does not hold', async () => {
    const store = new MemoryAuditStore()
    const entry = await new Audit(store, undefined, undefined, keyed).record('x', { email: 'a@b.co' })
    const other = new Audit(store, undefined, undefined, { integrity: { mode: 'hash-chain', key: 'z'.repeat(32), keyId: 'k2' } })
    await expect(other.redact(entry.id, { payload: ['email'] })).rejects.toMatchObject({ reason: 'unverified' })
  })

  it('refuses to redact an attestation', async () => {
    const { audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    const { attestation } = await audit.redact(entry.id, { payload: ['email'] })
    await expect(audit.redact(attestation!.id, { payload: 'all' })).rejects.toMatchObject({ reason: 'unverified' })
  })

  it("refuses a store without get/redact ('unsupported-store')", async () => {
    const inner = new MemoryAuditStore()
    const minimal: AuditStore = { append: (e) => inner.append(e), query: (q) => inner.query(q) }
    const audit = new Audit(minimal)
    const entry = await audit.record('x', { email: 'a@b.co' })
    await expect(audit.redact(entry.id, { payload: ['email'] })).rejects.toMatchObject({ reason: 'unsupported-store' })
  })

  it('validates the request', async () => {
    const { audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    const bad: Array<[unknown, unknown, RegExp]> = [
      ['', { payload: ['email'] }, /entryId/],
      [{ not: 'x' }, { payload: ['email'] }, /entryId/],
      [entry.id, null, /request must be an object/],
      [entry.id, {}, /nothing to erase/],
      [entry.id, { ip: false }, /nothing to erase/],
      [entry.id, { payloads: ['email'] }, /unknown option "payloads"/],
      [entry.id, { payload: [] }, /1-64 paths/],
      [entry.id, { payload: 'email' }, /1-64 paths/],
      [entry.id, { payload: Array.from({ length: 65 }, (_, i) => `f${i}`) }, /1-64 paths/],
      [entry.id, { payload: ['a.__proto__'] }, /prototype key/],
      [entry.id, { payload: ['a..b'] }, /empty segment/],
      [entry.id, { payload: ['email'], ip: 'yes' }, /ip must be a boolean/],
      [entry.id, { payload: ['email'], reasonRef: 'x'.repeat(129) }, /reasonRef/],
      [entry.id, { payload: ['email'], reasonRef: 'line\nbreak' }, /reasonRef/],
      [entry.id, { payload: ['email'], residual: 'everyone' }, /residual/],
      [entry.id, { payload: ['email'], tenantId: { not: 'x' } }, /tenantId/],
      [entry.id, { payload: ['email'], actorId: '' }, /actorId/],
    ]
    for (const [id, request, message] of bad) {
      await expect(audit.redact(id as string, request as never)).rejects.toThrow(message)
    }
  })
})

describe('Audit.record — reserved event', () => {
  it('refuses audit:redacted', async () => {
    const { audit } = make()
    await expect(audit.record(AUDIT_REDACTED_EVENT, {})).rejects.toBeInstanceOf(TypeError)
  })

  it('a captured audit:redacted event cannot vouch for a forged redaction (source is not manual)', async () => {
    const { store, audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    // The attacker rewrites the row, then gets the app to emit an `audit:redacted` domain
    // event (legitimately signed, but captured as source 'event') that matches it.
    const forged: AuditEntry = { ...entry, payload: { email: AUDIT_ERASED }, redaction: { attestationId: 'pending', payload: ['email'], ip: false, userAgent: false } }
    const claim = {
      entryId: entry.id,
      seq: entry.seq,
      hash: entry.hash,
      erased: { payload: ['email'], ip: false, userAgent: false },
      state: auditRedactionState(forged),
    }
    await audit.capture('event', AUDIT_REDACTED_EVENT, claim)
    const captured = rowsOf(store).at(-1)!
    tamper(store, entry.id, () => ({ ...forged, redaction: { ...forged.redaction!, attestationId: captured.id } }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', entryId: entry.id })
  })
})

describe('verify — tamper matrix on a redacted entry', () => {
  const setup = async () => {
    const { store, audit } = make()
    const entry = await audit.record('order.placed', customer)
    await audit.record('next', { n: 1 })
    const result = await audit.redact(entry.id, { payload: ['customer.email'] })
    expect(await audit.verify()).toMatchObject({ ok: true })
    return { store, audit, entry, result }
  }

  it('restoring the original content → redaction-mismatch', async () => {
    const { store, audit, entry } = await setup()
    tamper(store, entry.id, (e) => ({ ...e, payload: customer }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', entryId: entry.id })
  })

  it('substituting another value at an erased path → redaction-mismatch', async () => {
    const { store, audit, entry } = await setup()
    tamper(store, entry.id, (e) => ({ ...e, payload: { ...customer, customer: { email: 'eve@example.com', name: 'Ana' } } }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch' })
  })

  it('substituting a value with a recomputed state is still caught (erased fields must hold the marker)', async () => {
    const { store, audit, entry, result } = await setup()
    // Even if the attacker could make the state digest match, an erased path holding a value fails.
    const swapped = { ...result.entry, payload: { ...customer, customer: { email: 'eve@example.com', name: 'Ana' } } }
    tamper(store, entry.id, () => swapped)
    tamper(store, result.attestation!.id, (a) => ({ ...a, payload: { ...(a.payload as object), state: auditRedactionState(swapped) } }))
    const verdict = await audit.verify()
    expect(verdict.ok).toBe(false)
  })

  it('editing a header field of a redacted row → redaction-mismatch', async () => {
    const { store, audit, entry } = await setup()
    tamper(store, entry.id, (e) => ({ ...e, actorId: 'someone-else' }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch' })
  })

  it('dropping the marker → hash-mismatch', async () => {
    const { store, audit, entry } = await setup()
    tamper(store, entry.id, ({ redaction: _r, ...e }) => e)
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'hash-mismatch', entryId: entry.id })
  })

  it('repointing the marker to another attestation → redaction-mismatch', async () => {
    const { store, audit, entry } = await setup()
    const other = await audit.record('other', { email: 'x@y.z' })
    const { attestation } = await audit.redact(other.id, { payload: ['email'] })
    tamper(store, entry.id, (e) => ({ ...e, redaction: { ...e.redaction!, attestationId: attestation!.id } }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', entryId: entry.id })
  })

  it('repointing the marker to an ordinary entry → redaction-mismatch', async () => {
    const { store, audit, entry } = await setup()
    const next = rowsOf(store).find((e) => e.event === 'next')!
    tamper(store, entry.id, (e) => ({ ...e, redaction: { ...e.redaction!, attestationId: next.id } }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch' })
  })

  it('a malformed marker → redaction-mismatch', async () => {
    const { store, audit, entry } = await setup()
    tamper(store, entry.id, (e) => ({ ...e, redaction: { attestationId: 1 } as never }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', detail: 'malformed redaction marker' })
  })

  it('editing the erased set of the marker → redaction-mismatch', async () => {
    const { store, audit, entry } = await setup()
    tamper(store, entry.id, (e) => ({ ...e, redaction: { ...e.redaction!, ip: true } }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch' })
  })

  it('editing attestation.payload.state → hash-mismatch on the attestation', async () => {
    const { store, audit, result } = await setup()
    tamper(store, result.attestation!.id, (a) => ({ ...a, payload: { ...(a.payload as object), state: 'sha256:00' } }))
    const verdict = await audit.verify()
    expect(verdict.ok).toBe(false)
    // The redacted entry (seq 1) is checked first and points at the edited attestation.
    expect(verdict.reason).toBe('redaction-mismatch')
    expect(await audit.verify({ from: 3 })).toMatchObject({ ok: false, reason: 'hash-mismatch', entryId: result.attestation!.id })
  })

  it('deleting the attestation → redaction-mismatch (and a sequence gap after it)', async () => {
    const { store, audit, result } = await setup()
    await audit.record('later')
    rowsOf(store).splice(rowIndex(store, result.attestation!.id), 1)
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', detail: 'attestation not found' })
    expect(await audit.verify({ from: 2 })).toMatchObject({ ok: false, reason: 'sequence-gap', firstBrokenAt: 3 })
  })

  it('restoring the whole original row (content + marker dropped, e.g. from a backup) → redaction-mismatch on the attestation', async () => {
    const { store, audit, entry, result } = await setup()
    // The original row still matches its original hash: only the attestation
    // that vouches for an erasure of it can reveal the un-erasure.
    tamper(store, entry.id, () => entry)
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', entryId: result.attestation!.id })
  })

  it('rolling a re-redacted row back to an older attested state → redaction-mismatch', async () => {
    const { store, audit, entry, result: first } = await setup()
    const older = rowsOf(store)[rowIndex(store, entry.id)]!
    await audit.redact(entry.id, { payload: ['customer.name'] })
    expect(await audit.verify()).toMatchObject({ ok: true, redacted: 1 })
    // Restore the row as it was after the FIRST redaction (name back, marker on the first attestation).
    tamper(store, entry.id, () => older)
    expect(older.redaction?.attestationId).toBe(first.attestation!.id)
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch' })
  })

  it('an attestation whose entry is gone, or whose newer marker is not a later attestation → redaction-mismatch', async () => {
    const { store, audit, entry, result } = await setup()
    const seq = result.attestation!.seq!
    const saved = rowsOf(store)[rowIndex(store, entry.id)]!
    rowsOf(store).splice(rowIndex(store, entry.id), 1)
    expect(await audit.verify({ from: seq })).toMatchObject({
      ok: false,
      reason: 'redaction-mismatch',
      entryId: result.attestation!.id,
      detail: 'the entry this attestation vouches for is missing',
    })
    rowsOf(store).unshift(saved)
    const next = rowsOf(store).find((e) => e.event === 'next')!
    tamper(store, entry.id, (e) => ({ ...e, redaction: { ...e.redaction!, attestationId: next.id } }))
    expect(await audit.verify({ from: seq })).toMatchObject({ ok: false, reason: 'redaction-mismatch', entryId: result.attestation!.id })
  })

  it('an attestation of another tenant, or not after the entry, is refused', async () => {
    const { store, audit, entry, result } = await setup()
    tamper(store, result.attestation!.id, (a) => ({ ...a, tenantId: 'acme' }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', detail: 'attestation of another tenant' })
    tamper(store, result.attestation!.id, (a) => ({ ...a, tenantId: undefined, seq: 1 }))
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch' })
    tamper(store, result.attestation!.id, (a) => ({ ...a, seq: 3, payload: { ...(a.payload as object), entryId: 'x' } }))
    expect(await audit.verify()).toMatchObject({ ok: false, detail: 'the attestation vouches for another entry' })
    tamper(store, result.attestation!.id, (a) => ({ ...a, payload: null }))
    expect(await audit.verify()).toMatchObject({ ok: false, detail: 'attestation payload malformed' })
    expect(entry.id).toBeDefined()
  })

  it('a store without get() holding a redacted row fails closed, naming the method', async () => {
    const { store, audit, entry } = await setup()
    const noGet: AuditStore = {
      append: (e) => store.append(e),
      query: (q) => store.query(q),
      chainHead: (t) => store.chainHead(t),
      readChain: (t, r) => store.readChain(t, r),
      countUnchained: (t) => store.countUnchained(t),
      chainTenants: () => store.chainTenants(),
    }
    const verdict = await new Audit(noGet, undefined, undefined, keyed).verify()
    expect(verdict).toMatchObject({ ok: false, reason: 'redaction-mismatch', entryId: entry.id })
    expect(verdict.detail).toMatch(/get\(\)/)
  })
})

describe('Audit.redact — concurrency', () => {
  it('two concurrent redactions of one row both apply, merged into the final marker', async () => {
    const store = new MemoryAuditStore()
    const a = new Audit(store, undefined, undefined, keyed)
    const b = new Audit(store, undefined, undefined, keyed)
    const entry = await a.record('order.placed', customer)
    const [r1, r2] = await Promise.all([
      a.redact(entry.id, { payload: ['customer.email'] }),
      b.redact(entry.id, { payload: ['customer.name'] }),
    ])
    expect(r1.changed && r2.changed).toBe(true)
    const stored = await store.get(entry.id)
    expect(stored!.redaction!.payload).toEqual(['customer.email', 'customer.name'])
    expect(stored!.payload).toMatchObject({ customer: { email: AUDIT_ERASED, name: AUDIT_ERASED } })
    expect(await a.verify()).toMatchObject({ ok: true, checked: 3, redacted: 1 })
  })

  it('retries a seq taken by a concurrent append', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, undefined, keyed)
    const writer = new Audit(store, undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    const redact = store.redact.bind(store)
    let raced = false
    store.redact = async (write: AuditRedactionWrite) => {
      if (!raced) {
        raced = true
        await writer.record('racer') // takes the seq the attestation was linked to
      }
      return redact(write)
    }
    const result = await audit.redact(entry.id, { payload: ['email'] })
    expect(raced).toBe(true)
    expect(result.attestation!.seq).toBe(3)
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 3, redacted: 1 })
  })

  it('gives up after repeated redaction conflicts', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    let calls = 0
    store.redact = async () => {
      calls++
      throw new AuditRedactionConflictError(entry.id)
    }
    await expect(audit.redact(entry.id, { payload: ['email'] })).rejects.toBeInstanceOf(AuditRedactionConflictError)
    expect(calls).toBe(3)
  })

  it('surfaces other store errors without retrying', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    store.redact = async () => {
      throw new Error('disk full')
    }
    await expect(audit.redact(entry.id, { payload: ['email'] })).rejects.toThrow('disk full')
  })
})

describe('MemoryAuditStore.redact', () => {
  it('is atomic: an expect mismatch or a taken seq writes nothing', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store, undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    const snapshot = JSON.stringify(rowsOf(store))
    const att: AuditEntry = { id: 'att', source: 'manual', event: AUDIT_REDACTED_EVENT, payload: {}, at: 1, seq: 1, prevHash: '0', hash: 'h' }
    const write = (expect: AuditRedactionWrite['expect'], attestation = att): AuditRedactionWrite => ({
      id: entry.id,
      expect,
      payload: { email: AUDIT_ERASED },
      ip: undefined,
      userAgent: undefined,
      redaction: { attestationId: 'att', payload: ['email'], ip: false, userAgent: false },
      attestation,
    })
    await expect(store.redact(write({ hash: 'other', redactedBy: undefined }))).rejects.toBeInstanceOf(AuditRedactionConflictError)
    await expect(store.redact({ ...write({ hash: entry.hash, redactedBy: undefined }), id: 'missing' })).rejects.toBeInstanceOf(AuditRedactionConflictError)
    await expect(store.redact(write({ hash: entry.hash, redactedBy: 'x' }))).rejects.toBeInstanceOf(AuditRedactionConflictError)
    await expect(store.redact(write({ hash: entry.hash, redactedBy: undefined }))).rejects.toBeInstanceOf(AuditChainConflictError)
    expect(JSON.stringify(rowsOf(store))).toBe(snapshot)
    expect(computeAuditHashV2(entry, { id: 'k1', key: KEY })).toBe(entry.hash)
  })

  it('keeps stored rows frozen', async () => {
    const { store, audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    await audit.redact(entry.id, { payload: ['email'] })
    const row = (await store.get(entry.id))!
    expect(Object.isFrozen(row)).toBe(true)
    expect(Object.isFrozen(row.payload)).toBe(true)
    expect(Object.isFrozen(row.redaction)).toBe(true)
  })
})

describe('audit:verify CLI', () => {
  it('reports the redacted count', async () => {
    const { audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    await audit.redact(entry.id, { payload: ['email'] })
    const out: string[] = []
    const code = await createAuditVerifyCommand(() => audit).handle({ flags: {}, io: { log: (m) => out.push(m), error: (m) => out.push(m) } })
    expect(code).toBe(0)
    expect(out[0]).toMatch(/ok — 2 entries verified, head #2 .*, 1 redacted/)
  })

  it('prints the detail of a redaction-mismatch', async () => {
    const { store, audit } = make()
    const entry = await audit.record('x', { email: 'a@b.co' })
    await audit.redact(entry.id, { payload: ['email'] })
    tamper(store, entry.id, (e) => ({ ...e, payload: { email: 'a@b.co' } }))
    const out: string[] = []
    const code = await createAuditVerifyCommand(() => audit).handle({ flags: {}, io: { log: (m) => out.push(m), error: (m) => out.push(m) } })
    expect(code).toBe(1)
    expect(out[0]).toMatch(/redaction-mismatch: /)
  })
})

describe('auditPlugin', () => {
  it('exposes redact on the AUDIT token, scoped by the tenancy marker', async () => {
    const marker = definePlugin({
      name: 'fake-tenancy-marker',
      register({ container }) {
        ensureMetadata(container).add('tenancy:active', true)
      },
    })
    const app = await createApp({ plugins: [marker, auditPlugin({ integrity: keyed.integrity!, events: [] })] }).boot()
    const audit = app.container.get(AUDIT)
    const entry = await inTenant('acme', () => audit.record('x', { email: 'a@b.co' }))
    await expect(audit.redact(entry.id, { payload: ['email'] })).rejects.toThrow(/systemRedact/)
    expect((await inTenant('acme', () => audit.redact(entry.id, { payload: ['email'] }))).changed).toBe(true)
  })
})
