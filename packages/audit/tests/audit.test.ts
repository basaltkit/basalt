import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import { z } from 'zod'
import { AUDIT, auditPlugin, patternMatches } from '../src/index.js'

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

    const trail = await audit.trail()
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
    const [entry] = await audit.trail()
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
    // a system caller with no tenant context still sees both
    expect((await audit.trail()).length).toBe(2)
  })

  it('records domain events from the EventBus', async () => {
    const { app, audit, bus } = await boot()
    const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

    await runWithContext({ tenant: { id: 'acme' } }, () =>
      bus.emit(OrderCreated, { orderId: 'o-1' }),
    )

    const trail = await audit.trail({ event: 'order.**' })
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
    expect(await audit.trail({ actorId: 'u1' })).toHaveLength(1)
    const all = await audit.trail({ limit: 2 })
    expect(all.map((entry) => entry.event)).toEqual(['maintenance.run', 'data.export'])
  })

  it('entries are frozen — the trail cannot be tampered with', async () => {
    const { app, audit } = await boot()
    await app.hooks.emit('auth:login', { user: { id: 'u1' } })
    const [entry] = await audit.trail()
    expect(Object.isFrozen(entry)).toBe(true)
    expect(() => {
      ;(entry as { event: string }).event = 'tampered'
    }).toThrow()
  })

  it('custom hook patterns override the defaults', async () => {
    const { app, audit } = await boot({ hooks: ['custom:**'], events: [] })
    await app.hooks.emit('auth:login', { user: { id: 'u1' } })
    await app.hooks.emit('custom:thing', { ok: true })
    const trail = await audit.trail()
    expect(trail.map((entry) => entry.event)).toEqual(['custom:thing'])
  })
})
