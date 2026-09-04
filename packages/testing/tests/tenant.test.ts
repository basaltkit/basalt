import { describe, expect, it } from 'vitest'
import { withTenant, type TenantLifecycle } from '../src/index.js'

/** A Tenancy stand-in that records the order it was called in. */
function fakeTenancy(): TenantLifecycle & { calls: string[]; existing: Set<string> } {
  const existing = new Set<string>()
  const calls: string[] = []
  return {
    calls,
    existing,
    async find(id) {
      return existing.has(id) ? { id } : null
    },
    async create(tenant) {
      calls.push(`create:${tenant.id}`)
      existing.add(tenant.id)
      return tenant
    },
    async destroy(id) {
      calls.push(`destroy:${id}`)
      existing.delete(id)
    },
    async run(id, fn) {
      calls.push(`run:${id}`)
      return fn()
    },
  }
}

describe('F-29 · withTenant', () => {
  it('creates, runs inside the tenant, and destroys', async () => {
    const t = fakeTenancy()
    const result = await withTenant(t, 'acme', () => 'done')

    expect(result).toBe('done')
    expect(t.calls).toEqual(['create:acme', 'run:acme', 'destroy:acme'])
    expect(t.existing.has('acme')).toBe(false)
  })

  it('destroys the tenant even when the test fails', async () => {
    // The case that matters. A failing test that leaves its tenant behind makes
    // the *next* run fail for a different reason.
    const t = fakeTenancy()
    await expect(withTenant(t, 'acme', () => Promise.reject(new Error('assertion')))).rejects.toThrow(
      'assertion',
    )
    expect(t.calls).toEqual(['create:acme', 'run:acme', 'destroy:acme'])
    expect(t.existing.has('acme')).toBe(false)
  })

  it('removes a leftover tenant before creating its own', async () => {
    // A previous run may have died between writing the record and provisioning
    // the schema. Without this, provisioning is a no-op and every assertion
    // below passes green against the previous run's data.
    const t = fakeTenancy()
    t.existing.add('acme')

    await withTenant(t, 'acme', () => undefined)

    expect(t.calls).toEqual(['destroy:acme', 'create:acme', 'run:acme', 'destroy:acme'])
  })

  it('passes extra fields to the tenant record', async () => {
    const t = fakeTenancy()
    const created: Array<Record<string, unknown>> = []
    const original = t.create
    t.create = async (tenant) => {
      created.push(tenant)
      return original(tenant)
    }

    await withTenant(t, 'acme', () => undefined, { fields: { name: 'Acme LDA', plan: 'pro' } })
    expect(created[0]).toEqual({ id: 'acme', name: 'Acme LDA', plan: 'pro' })
  })

  it('leaves the tenant standing when asked to', async () => {
    const t = fakeTenancy()
    await withTenant(t, 'acme', () => undefined, { cleanup: false })
    expect(t.calls).toEqual(['create:acme', 'run:acme'])
    expect(t.existing.has('acme')).toBe(true)
  })
})
