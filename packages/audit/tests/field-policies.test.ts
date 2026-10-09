import { createApp } from '@basaltkit/core'
import { describe, expect, it, vi } from 'vitest'
import {
  AUDIT,
  Audit,
  auditPlugin,
  createPiiMinimizingRedactor,
  MemoryAuditStore,
  pseudonymize,
  type AuditFieldPolicies,
  type AuditOptions,
} from '../src/index.js'

const KEY = 'k'.repeat(32)
const OTHER_KEY = 'o'.repeat(32)

const policies: AuditFieldPolicies = {
  'customer.created': { omit: ['notes', 'address.street'], pseudonymize: ['email', 'fullName'] },
  'order.placed': { omit: ['items[].comment'], pseudonymize: ['items.buyer.phone', 'contacts'] },
}

const make = (options: AuditOptions = {}, redact?: ConstructorParameters<typeof Audit>[1]) => {
  const store = new MemoryAuditStore()
  return {
    store,
    audit: new Audit(store, redact, undefined, { integrity: 'hash-chain', fieldPolicies: policies, fieldPolicyKey: KEY, ...options }),
  }
}

describe('fieldPolicies — per-event personal data', () => {
  it('omits and pseudonymizes before the entry is stored and hashed; verify() passes', async () => {
    const { store, audit } = make()
    const payload = {
      id: 'c1',
      email: 'ana@example.com',
      fullName: 'Ana Silva',
      notes: 'allergic to peanuts',
      address: { street: 'Rua 1', city: 'Luanda' },
    }
    const entry = await audit.record('customer.created', payload)
    expect(entry.payload).toEqual({
      id: 'c1',
      email: pseudonymize('ana@example.com', KEY),
      fullName: pseudonymize('Ana Silva', KEY),
      address: { city: 'Luanda' },
    })
    const [stored] = await store.query({})
    expect(JSON.stringify(stored)).not.toMatch(/peanuts|Rua 1|Ana Silva|ana@example\.com/)
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 1 })
    // The caller's object is never mutated.
    expect(payload.notes).toBe('allergic to peanuts')
    expect(payload.address.street).toBe('Rua 1')
  })

  it('walks arrays (with or without the [] marker) and pseudonymizes every scalar under a field', async () => {
    const { audit } = make()
    const entry = await audit.record('order.placed', {
      items: [
        { sku: 'a', comment: 'leave at door', buyer: { phone: 912345678 } },
        { sku: 'b', comment: 'gift' },
      ],
      contacts: ['x@example.com', { phone: '+244 912 345 678' }],
    })
    expect(entry.payload).toEqual({
      items: [{ sku: 'a', buyer: { phone: pseudonymize('912345678', KEY) } }, { sku: 'b' }],
      contacts: [pseudonymize('x@example.com', KEY), { phone: pseudonymize('+244 912 345 678', KEY) }],
    })
  })

  it('pseudonyms are deterministic under one key, differ across keys, and match the PII redactor under the same key', async () => {
    const a = await make().audit.record('customer.created', { email: 'ana@example.com' })
    const b = await make().audit.record('customer.created', { email: 'ana@example.com' })
    const c = await make({ fieldPolicyKey: OTHER_KEY }).audit.record('customer.created', { email: 'ana@example.com' })
    expect(a.payload).toEqual(b.payload)
    expect(c.payload).not.toEqual(a.payload)
    const redacted = createPiiMinimizingRedactor({ key: KEY })({ email: 'ana@example.com' }, 'x') as { email: string }
    expect((a.payload as { email: string }).email).toBe(redacted.email)
  })

  it('runs before the configured redactor', async () => {
    const seen: unknown[] = []
    const { audit } = make({}, (payload) => {
      seen.push(payload)
      return payload
    })
    await audit.record('customer.created', { notes: 'secret note', email: 'ana@example.com' })
    expect(seen[0]).toEqual({ email: pseudonymize('ana@example.com', KEY) })
  })

  it('leaves events without a policy (and non-object payloads) unchanged', async () => {
    const { audit } = make()
    expect((await audit.record('other.event', { notes: 'kept', email: 'kept' })).payload).toEqual({ notes: 'kept', email: 'kept' })
    expect((await audit.record('customer.created', 'plain')).payload).toBe('plain')
    expect((await audit.record('customer.created')).payload).toBeUndefined()
  })

  it('applies to hooks captured by the plugin', async () => {
    const app = await createApp({
      plugins: [auditPlugin({ events: [], hooks: ['auth:**'], fieldPolicies: { 'auth:login': { omit: ['user.email'] } }, fieldPolicyKey: KEY })],
    }).boot()
    await app.hooks.emit('auth:login', { user: { id: 'u1', email: 'ana@example.com' } })
    const [entry] = await app.container.get(AUDIT).systemTrail()
    expect(entry!.payload).toEqual({ user: { id: 'u1' } })
  })

  it('a path listed in both omit and pseudonymize is omitted', async () => {
    const { audit } = make({ fieldPolicies: { e: { omit: ['email'], pseudonymize: ['email'] } } })
    expect((await audit.record('e', { email: 'a@b.co', id: 1 })).payload).toEqual({ id: 1 })
  })

  it('rejects invalid policies at configuration time', () => {
    const bad: unknown[] = [
      [],
      { e: null },
      { e: { omitt: ['x'] } },
      { e: { omit: 'x' } },
      { e: { omit: [''] } },
      { e: { omit: ['a..b'] } },
      { e: { omit: [42] } },
      { e: { pseudonymize: ['__proto__.x'] } },
      { e: { omit: ['user.constructor'] } },
      { e: { omit: ['a.b.c.d.e.f.g.h.i'] } },
      { e: { omit: ['x'.repeat(300)] } },
      { '': { omit: ['x'] } },
    ]
    for (const fieldPolicies of bad) {
      expect(() => new Audit(new MemoryAuditStore(), undefined, undefined, { fieldPolicies: fieldPolicies as AuditFieldPolicies })).toThrow(TypeError)
      expect(() => auditPlugin({ fieldPolicies: fieldPolicies as AuditFieldPolicies })).toThrow(TypeError)
    }
    expect(() => new Audit(new MemoryAuditStore(), undefined, undefined, { fieldPolicies: {}, fieldPolicyKey: 'short' })).toThrow(TypeError)
  })

  it('without a key, pseudonymizes under a per-process key and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const audit = new Audit(new MemoryAuditStore(), undefined, undefined, { fieldPolicies: { e: { pseudonymize: ['email'] } } })
      new Audit(new MemoryAuditStore(), undefined, undefined, { fieldPolicies: { e: { pseudonymize: ['email'] } } })
      const entry = await audit.record('e', { email: 'a@b.co' })
      expect((entry.payload as { email: string }).email).toMatch(/^pii_[0-9a-f]{32}$/)
      expect(warn.mock.calls.filter(([m]) => String(m).includes('fieldPolicies'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('drops a branch nested deeper than the walk bound instead of letting it through', async () => {
    let nested: unknown = { email: 'deep@example.com' }
    for (let i = 0; i < 100; i++) nested = [nested]
    // A pass-through redactor: only the field policy stands between the payload and the store.
    const audit = new Audit(new MemoryAuditStore(), (p) => p, undefined, { fieldPolicies: { e: { omit: ['email'] } }, fieldPolicyKey: KEY })
    const deep = await audit.record('e', nested)
    expect(JSON.stringify(deep.payload)).not.toContain('deep@example.com')
    expect(JSON.stringify(deep.payload)).toContain('[truncated]')
    // Shallow array nesting is walked normally.
    await expect(audit.record('e', [[{ email: 'x', id: 1 }]])).resolves.toMatchObject({ payload: [[{ id: 1 }]] })
  })
})
