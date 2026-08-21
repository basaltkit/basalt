import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import { z } from 'zod'
import { AUDIT, auditPlugin, patternMatches, piiMinimizingRedactor, pseudonymize } from '../src/index.js'

describe('patternMatches', () => {
  it('handles hook (:) and event (.) separators with * and **', () => {
    expect(patternMatches('auth:**', 'auth:login')).toBe(true)
    expect(patternMatches('auth:*', 'auth:login')).toBe(true)
    expect(patternMatches('auth:**', 'billing:subscribed')).toBe(false)
    expect(patternMatches('order.*', 'order.created')).toBe(true)
    expect(patternMatches('**', 'anything:at.all')).toBe(true)
  })
})

const boot = async (options = {}) => {
  const app = await createApp({ plugins: [eventsPlugin(), auditPlugin(options)] }).boot()
  return { app, audit: app.container.get(AUDIT), bus: app.container.get(EVENTS) }
}

describe('auditPlugin', () => {
  it('records matching lifecycle hooks enriched from the context', async () => {
    const { app, audit } = await boot()

    await runWithContext(
      { requestId: 'req-1', user: { id: 'u1' }, tenant: { id: 'acme' } },
      () => app.hooks.emit('auth:login', { user: { id: 'u1', email: 'a@b.c' } }),
    )
    await app.hooks.emit('app:internal', { noise: true }) // not in the allowlist

    const trail = await audit.systemTrail()
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      source: 'hook',
      event: 'auth:login',
      actorId: 'u1',
      tenantId: 'acme',
      requestId: 'req-1',
    })
  })

  it('redacts secret/PII fields from the stored payload by default', async () => {
    const { app, audit } = await boot()
    await runWithContext({ tenant: { id: 'acme' } }, () =>
      app.hooks.emit('auth:login', { user: { id: 'u1' }, password: 'hunter2', apiKey: 'sk_live_x', token: 'abc', nested: { sessionId: 's1' } }),
    )
    const [entry] = await audit.systemTrail()
    const payload = entry!.payload as Record<string, unknown>
    expect(payload['password']).toBe('[redacted]')
    expect(payload['apiKey']).toBe('[redacted]')
    expect(payload['token']).toBe('[redacted]')
    expect((payload['nested'] as Record<string, unknown>)['sessionId']).toBe('[redacted]')
    expect((payload['user'] as Record<string, unknown>)['id']).toBe('u1') // non-secret kept
  })

  it('trail() auto-scopes to the current tenant (no cross-tenant read)', async () => {
    const { app, audit } = await boot()
    await runWithContext({ tenant: { id: 'acme' } }, () => app.hooks.emit('auth:login', { user: { id: 'a' } }))
    await runWithContext({ tenant: { id: 'globex' } }, () => app.hooks.emit('auth:login', { user: { id: 'g' } }))

    // queried inside acme's context → only acme's entries
    const acme = await runWithContext({ tenant: { id: 'acme' } }, () => audit.trail())
    expect(acme.map((e) => e.tenantId)).toEqual(['acme'])
    // a system caller uses the explicit escape hatch to see both
    expect((await audit.systemTrail()).length).toBe(2)
  })

  it('trail() FORCES the context tenant — a caller-supplied tenantId cannot widen scope (PII F2)', async () => {
    const { app, audit } = await boot()
    await runWithContext({ tenant: { id: 'acme' } }, () => app.hooks.emit('auth:login', { user: { id: 'a' } }))
    await runWithContext({ tenant: { id: 'victim' } }, () => app.hooks.emit('auth:login', { user: { id: 'v' } }))

    // Inside acme's context, forwarding a client-controlled `tenantId: 'victim'`
    // must NOT read victim's trail — the context tenant wins.
    const leaked = await runWithContext({ tenant: { id: 'acme' } }, () => audit.trail({ tenantId: 'victim' }))
    expect(leaked.map((e) => e.tenantId)).toEqual(['acme'])
    expect(leaked.some((e) => e.tenantId === 'victim')).toBe(false)
  })

  it('systemTrail() is the explicit escape hatch for unscoped cross-tenant reads (PII F2)', async () => {
    const { app, audit } = await boot()
    await runWithContext({ tenant: { id: 'acme' } }, () => app.hooks.emit('auth:login', { user: { id: 'a' } }))
    await runWithContext({ tenant: { id: 'victim' } }, () => app.hooks.emit('auth:login', { user: { id: 'v' } }))

    // Unscoped read returns every tenant only when deliberately requested.
    expect((await audit.systemTrail()).map((e) => e.tenantId).sort()).toEqual(['acme', 'victim'])
    // and it still honours an explicit single-tenant filter.
    expect((await audit.systemTrail({ tenantId: 'victim' })).map((e) => e.tenantId)).toEqual(['victim'])
  })

  it('trail() refuses a silent broad read with no tenant in context (PII F2)', async () => {
    const { app, audit } = await boot()
    await runWithContext({ tenant: { id: 'acme' } }, () => app.hooks.emit('auth:login', { user: { id: 'a' } }))

    // No tenant context and no explicit tenantId → must not return everything.
    await expect(audit.trail()).rejects.toThrow(/systemTrail/)
    // A normal scoped read (inside the tenant context) still works.
    const scoped = await runWithContext({ tenant: { id: 'acme' } }, () => audit.trail())
    expect(scoped.map((e) => e.tenantId)).toEqual(['acme'])
  })

  it('records domain events from the EventBus', async () => {
    const { app, audit, bus } = await boot()
    const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

    await runWithContext({ tenant: { id: 'acme' } }, () =>
      bus.emit(OrderCreated, { orderId: 'o-1' }),
    )

    const trail = await audit.systemTrail({ event: 'order.**' })
    expect(trail[0]).toMatchObject({
      source: 'event',
      event: 'order.created',
      payload: { orderId: 'o-1' },
      tenantId: 'acme',
    })
    await app.shutdown()
  })

  it('manual records and filtered queries, newest first', async () => {
    const { audit } = await boot()

    await runWithContext({ tenant: { id: 'acme' }, user: { id: 'u1' } }, async () => {
      await audit.record('data.export', { format: 'csv' })
    })
    await runWithContext({ tenant: { id: 'globex' } }, async () => {
      await audit.record('data.export', { format: 'pdf' })
    })
    await audit.record('maintenance.run')

    expect(await audit.trail({ tenantId: 'acme' })).toHaveLength(1)
    expect(await audit.systemTrail({ actorId: 'u1' })).toHaveLength(1)
    const all = await audit.systemTrail({ limit: 2 })
    expect(all.map((entry) => entry.event)).toEqual(['maintenance.run', 'data.export'])
  })

  it('entries are frozen — the trail cannot be tampered with', async () => {
    const { app, audit } = await boot()
    await app.hooks.emit('auth:login', { user: { id: 'u1' } })
    const [entry] = await audit.systemTrail()
    expect(Object.isFrozen(entry)).toBe(true)
    expect(() => {
      ;(entry as { event: string }).event = 'tampered'
    }).toThrow()
  })

  it('custom hook patterns override the defaults', async () => {
    const { app, audit } = await boot({ hooks: ['custom:**'], events: [] })
    await app.hooks.emit('auth:login', { user: { id: 'u1' } })
    await app.hooks.emit('custom:thing', { ok: true })
    const trail = await audit.systemTrail()
    expect(trail.map((entry) => entry.event)).toEqual(['custom:thing'])
  })

  it('opt-in piiMinimizingRedactor pseudonymizes PII while still masking secrets (PII F3)', async () => {
    const { app, audit } = await boot({ redact: piiMinimizingRedactor })
    await runWithContext({ tenant: { id: 'acme' } }, () =>
      app.hooks.emit('auth:login', { user: { id: 'u1', email: 'alice@example.com' }, password: 'hunter2' }),
    )
    const [entry] = await audit.systemTrail()
    const payload = entry!.payload as Record<string, unknown>
    const user = payload['user'] as Record<string, unknown>
    // secrets still masked, PII pseudonymized deterministically, non-PII kept
    expect(payload['password']).toBe('[redacted]')
    expect(user['email']).toBe(pseudonymize('alice@example.com'))
    expect(user['email']).not.toContain('alice@example.com')
    expect(user['id']).toBe('u1')
  })
})
