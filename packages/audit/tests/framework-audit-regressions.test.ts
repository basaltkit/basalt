/**
 * Regression tests for the framework audit findings FA-016..FA-020 and FA-H17
 * (each started life as a repro asserting the defective behaviour).
 */
import { runWithContext } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import {
  Audit,
  type AuditEntry,
  type AuditQuery,
  type AuditStore,
  createAuditVerifyCommand,
  isSensitiveKey,
  MemoryAuditStore,
  redactSensitive,
  redactSensitiveAndPii,
} from '../src/index.js'

const chained = (store: AuditStore = new MemoryAuditStore()) => new Audit(store, undefined, undefined, { integrity: 'hash-chain' })
const inTenant = <T>(tenantId: string, fn: () => T): T => runWithContext({ tenant: { id: tenantId } } as never, fn)

describe('FA-016 — rows outside the chain are not accepted silently', () => {
  it('a forged unchained row written after the chain began fails verify() and is listed in `unverified`', async () => {
    const store = new MemoryAuditStore()
    const audit = chained(store)
    await audit.record('user:login', { a: 1 })
    await store.append({ id: 'forged', source: 'manual', event: 'user:promoted', at: Date.now() + 1, payload: { role: 'admin' } })
    const v = await audit.verify()
    expect(v).toMatchObject({ ok: false, reason: 'unchained-entry', entryId: 'forged', unchained: 1, checked: 1 })
    expect(v.unverified).toEqual(['forged'])
  })

  it('legacy rows (before the chain began) stay ok, but `legacyUntil: 0` rejects them', async () => {
    const store = new MemoryAuditStore()
    await inTenant('acme', () => new Audit(store).record('legacy'))
    const audit = chained(store)
    await new Promise((r) => setTimeout(r, 2))
    await inTenant('acme', () => audit.record('new'))
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, unchained: 1, unverified: [] })
    expect(await audit.verify({ tenantId: 'acme', legacyUntil: 0 })).toMatchObject({ ok: false, reason: 'unchained-entry' })
  })

  it('trail({ chainedOnly: true }) leaves out rows outside the chain', async () => {
    const store = new MemoryAuditStore()
    const audit = chained(store)
    await audit.record('x')
    await store.append({ id: 'forged', source: 'manual', event: 'y', at: Date.now() + 1, payload: {} })
    expect((await audit.trail()).map((e) => e.id)).toContain('forged')
    expect((await audit.trail({ chainedOnly: true })).map((e) => e.id)).not.toContain('forged')
  })

  it('chainedOnly is enforced even when a custom store ignores the filter', async () => {
    const inner = new MemoryAuditStore()
    const store: AuditStore = { append: (e) => inner.append(e), query: (q: AuditQuery) => inner.query({ ...q, chainedOnly: false }) }
    await store.append({ id: 'plain', source: 'manual', event: 'y', at: 1, payload: {} })
    expect(await new Audit(store).trail({ chainedOnly: true })).toEqual([])
  })

  it('a store without readUnchained is checked through query()', async () => {
    const inner = new MemoryAuditStore()
    const store: AuditStore = {
      append: (e) => inner.append(e),
      query: (q) => inner.query(q),
      chainHead: (t) => inner.chainHead(t),
      readChain: (t, r) => inner.readChain(t, r),
      countUnchained: (t) => inner.countUnchained(t),
      chainTenants: () => inner.chainTenants(),
    }
    const audit = chained(store)
    await audit.record('x')
    await store.append({ id: 'forged', source: 'manual', event: 'y', at: Date.now() + 1, payload: {} })
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'unchained-entry', unverified: ['forged'] })
  })
})

describe('FA-H17 — verify() against an external anchor detects truncation', () => {
  it('reports `truncated` when the anchored tail is gone and `head-mismatch` on a different hash', async () => {
    const store = new MemoryAuditStore()
    const audit = chained(store)
    for (let i = 0; i < 3; i++) await audit.record(`e${i}`)
    const { head } = await audit.verify()
    expect(await audit.verify({ expectedHead: head! })).toMatchObject({ ok: true, checked: 3 })
    expect(await audit.verify({ expectedHead: { seq: 3, hash: 'f'.repeat(64) } })).toMatchObject({ ok: false, reason: 'head-mismatch', firstBrokenAt: 3 })
    // Drop the tail — no gap is left behind.
    ;(store as unknown as { entries: AuditEntry[] }).entries.pop()
    expect((await audit.verify()).ok).toBe(true)
    expect(await audit.verify({ expectedHead: head! })).toMatchObject({ ok: false, reason: 'truncated', firstBrokenAt: 3 })
  })

  it('verifyAll({ expectedHeads }) reports a chain deleted wholesale', async () => {
    const store = new MemoryAuditStore()
    const audit = chained(store)
    await inTenant('acme', () => audit.record('x'))
    const head = (await audit.verify({ tenantId: 'acme' })).head!
    ;(store as unknown as { entries: AuditEntry[] }).entries.length = 0
    const all = await audit.verifyAll({ expectedHeads: { 't:acme': head } })
    expect(all.ok).toBe(false)
    expect(all.chains.find((c) => c.tenantId === 'acme')).toMatchObject({ ok: false, reason: 'truncated' })
    await expect(audit.verifyAll({ expectedHeads: { acme: head } })).rejects.toThrow(TypeError)
  })

  it('validates expectedHead', async () => {
    const audit = chained()
    await expect(audit.verify({ expectedHead: { seq: 0, hash: 'x' } })).rejects.toThrow(TypeError)
    await expect(audit.verify({ from: 2, to: 3, expectedHead: { seq: 5, hash: 'x' } })).rejects.toThrow(TypeError)
  })

  it('the CLI accepts --expected-head and --legacy-until', async () => {
    const audit = chained()
    await audit.record('x')
    const { head } = await audit.verify()
    const lines: string[] = []
    const io = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) }
    const cmd = createAuditVerifyCommand(() => audit)
    expect(await cmd.handle({ flags: { 'expected-head': `${head!.seq}:${head!.hash}`, 'legacy-until': '0' }, io })).toBe(0)
    expect(await cmd.handle({ flags: { 'expected-head': `2:${head!.hash}` }, io })).toBe(1)
    expect(lines.at(-1)).toContain('truncated')
  })
})

describe('FA-017 — returned entries are deeply frozen', () => {
  it('mutating record().payload neither changes history nor breaks the chain', async () => {
    const audit = chained()
    const e = await audit.record('x', { a: 1, nested: { b: 2 } })
    expect(Object.isFrozen(e.payload)).toBe(true)
    expect(() => {
      ;(e.payload as { a: number }).a = 2
    }).toThrow(TypeError)
    const [stored] = await audit.trail()
    expect(() => {
      ;(stored!.payload as { nested: { b: number } }).nested.b = 3
    }).toThrow(TypeError)
    expect((await audit.trail())[0]!.payload).toEqual({ a: 1, nested: { b: 2 } })
    expect((await audit.verify()).ok).toBe(true)
  })

  it('never freezes the caller\'s own object (the payload is copied first)', async () => {
    const payload = { a: { b: 1 } }
    await new Audit(new MemoryAuditStore(), (p) => p).record('x', payload)
    expect(Object.isFrozen(payload)).toBe(false)
    expect(Object.isFrozen(payload.a)).toBe(false)
  })
})

describe('FA-018 — redaction gaps', () => {
  const KEY = 'k'.repeat(16)

  it('international phone-shaped values are pseudonymised', () => {
    const out = redactSensitiveAndPii({ contact: '+351 912 345 678', to: '+15551234567', alt: '+1 (555) 123-4567', email: 'a@b.co' }, 0, { key: KEY }) as Record<string, string>
    for (const field of ['contact', 'to', 'alt', 'email']) expect(out[field]).toMatch(/^pii_[0-9a-f]{32}$/)
  })

  it('plain numbers, dates and short signed values are not mistaken for phones', () => {
    const input = { order: '123456789012', date: '2026-09-28', amount: '+42', version: '+1.2.3', id: 'ab+12345678' }
    expect(redactSensitiveAndPii(input, 0, { key: KEY })).toEqual(input)
  })

  it('pwd / privateKey / jwt / auth / accessKey are masked; compass / sessionCount / bypass / author are not', () => {
    const out = redactSensitive({
      pwd: 'p', privateKey: 'k', private_key: 'k', jwt: 'j', auth: 'Basic x', accessKey: 'a', client_secret: 's', dsn: 'dsn-value',
      connectionString: 'c', 'X-Api-Key': 'x', sessionId: 's', session: 's',
      compass: 'north', sessionCount: 3, bypass: 'no', author: 'maria', authorId: 'u1',
    }) as Record<string, unknown>
    for (const k of ['pwd', 'privateKey', 'private_key', 'jwt', 'auth', 'accessKey', 'client_secret', 'dsn', 'connectionString', 'X-Api-Key', 'sessionId', 'session']) {
      expect(out[k], k).toBe('[redacted]')
    }
    expect(out).toMatchObject({ compass: 'north', sessionCount: 3, bypass: 'no', author: 'maria', authorId: 'u1' })
  })

  it('keeps the historical matches (password, token, apiKey, secret, cookie, otp, mfa)', () => {
    for (const k of ['password', 'passwordHash', 'accessToken', 'refresh_token', 'apiKey', 'api-key', 'clientSecret', 'cookie', 'otpCode', 'mfaSecret', 'authorization', 'credentials', 'passport']) {
      expect(isSensitiveKey(k), k).toBe(true)
    }
  })

  it('a "__proto__" key stays visible as an own, masked property instead of vanishing', () => {
    for (const redact of [(v: unknown) => redactSensitive(v), (v: unknown) => redactSensitiveAndPii(v, 0, { key: KEY })]) {
      const r = redact(JSON.parse('{"__proto__":{"role":"admin"},"constructor":{"x":1},"x":1}')) as Record<string, unknown>
      expect(JSON.stringify(r)).toBe('{"__proto__":"[redacted]","constructor":"[redacted]","x":1}')
      expect((r as { role?: string }).role).toBeUndefined()
      expect(Object.getPrototypeOf(r)).toBe(Object.prototype)
    }
  })

  it('a "__proto__" key under a PII key is masked too', () => {
    const r = redactSensitiveAndPii(JSON.parse('{"email":{"__proto__":{"role":"admin"}}}'), 0, { key: KEY }) as { email: Record<string, unknown> }
    expect(JSON.stringify(r)).toBe('{"email":{"__proto__":"[redacted]"}}')
  })
})

describe('FA-019 — verifyAll() is tenant-scoped like verify()', () => {
  it('inside tenant "a" it reports only tenant "a"', async () => {
    const audit = new Audit(new MemoryAuditStore(), undefined, () => true, { integrity: 'hash-chain' })
    await inTenant('a', () => audit.record('x'))
    await inTenant('b', () => audit.record('y'))
    const scoped = await inTenant('a', () => audit.verifyAll())
    expect(scoped.chains.map((c) => c.tenantId)).toEqual(['a'])
    const all = await audit.verifyAll()
    expect(all.chains.map((c) => c.tenantId)).toEqual([undefined, 'a', 'b'])
  })

  it('a hand-built Audit with tenancyActive () => true refuses an unscoped trail()', async () => {
    const audit = new Audit(new MemoryAuditStore(), undefined, () => true)
    await expect(audit.trail()).rejects.toThrow(/tenant/)
  })
})

describe('FA-020 — query filters must be strings', () => {
  it('trail()/systemTrail() and the memory store reject operator objects and bad types', async () => {
    const store = new MemoryAuditStore()
    const audit = new Audit(store)
    for (const bad of [{ tenantId: { not: 'zzz' } }, { actorId: ['a'] }, { event: 1 }, { since: '0' }, { limit: '5' }, { chainedOnly: 'yes' }]) {
      await expect(audit.trail(bad as never), JSON.stringify(bad)).rejects.toThrow(TypeError)
      await expect(audit.systemTrail(bad as never)).rejects.toThrow(TypeError)
      await expect(store.query(bad as never)).rejects.toThrow(TypeError)
    }
    await expect(audit.verify({ tenantId: { not: 'x' } } as never)).rejects.toThrow(TypeError)
  })
})
