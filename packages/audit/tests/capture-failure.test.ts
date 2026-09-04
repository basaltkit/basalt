import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import { z } from 'zod'
import { MemoryTenantSource, TENANCY, tenancyPlugin } from '@basaltkit/tenancy'
import { AUDIT, auditPlugin, type AuditStore } from '../src/index.js'

/**
 * F-13 · A failing audit write must not abort the operation that emitted it.
 *
 * The bridge is opportunistic capture: "when something happens, note it". The
 * explicit `audit.record()` API is the one to use when the audit *is* the
 * point, and that one still throws. What must not happen is a domain write
 * failing because the trail could not be appended.
 *
 * Same reasoning `@basaltkit/realtime` already applies to its bridge
 * (`onBridgeError`): the fan-out "must never fail (or slow down) the domain
 * write that emitted the hook". The difference — and why the default logs
 * loudly instead of staying quiet — is that an audit trail with a silent hole
 * is worse than no trail: it looks complete.
 *
 * How it showed up: `tenancy.provision()` runs the provisioning callback inside
 * the new tenant's context, which emits `tenancy:switched`. With a store bound
 * to the tenant's own database, the audit write hit a schema that did not exist
 * yet, and the error propagated out through `provision()` — which marked the
 * tenant `failed` and rethrew. Applications following the defaults could not
 * create a single tenant.
 */
const brokenStore = (): AuditStore => ({
  async append() {
    throw new Error('relation "audit_entries" does not exist')
  },
  async list() {
    return []
  },
})

describe('F-13 · audit capture failures are isolated', () => {
  it('does not propagate out of the hook that emitted it', async () => {
    const onCaptureError = vi.fn()
    const app = await createApp({
      plugins: [eventsPlugin(), auditPlugin({ store: brokenStore(), onCaptureError })],
    }).boot()

    // Before the fix this rejected, and the caller — `tenancy.provision()` —
    // marked the tenant as failed.
    await expect(app.hooks.emit('auth:login', { userId: 'u1' })).resolves.toBeUndefined()

    expect(onCaptureError).toHaveBeenCalledTimes(1)
    const [error, info] = onCaptureError.mock.calls[0]!
    expect((error as Error).message).toContain('audit_entries')
    expect(info).toMatchObject({ source: 'hook', event: 'auth:login' })

    await app.shutdown()
  })

  it('does the same for the event bridge', async () => {
    const onCaptureError = vi.fn()
    const app = await createApp({
      plugins: [eventsPlugin(), auditPlugin({ store: brokenStore(), onCaptureError })],
    }).boot()

    const OrderCreated = defineEvent('order.created', z.object({ id: z.string() }))
    await app.container.get(EVENTS).emit(OrderCreated, { id: '1' })
    expect(onCaptureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'event', event: 'order.created' }),
    )

    await app.shutdown()
  })

  it('still throws from the explicit record() API', async () => {
    // The bridge is best-effort; a deliberate `audit.record()` is not. Silencing
    // it too would turn "I wrote this to the trail" into a guess.
    const app = await createApp({
      plugins: [eventsPlugin(), auditPlugin({ store: brokenStore() })],
    }).boot()

    await expect(app.container.get(AUDIT).record('privacy:override', {})).rejects.toThrow(
      'audit_entries',
    )

    await app.shutdown()
  })
})

describe('F-13 · the default hook patterns', () => {
  it('keep tenant lifecycle but drop context switching', async () => {
    /**
     * `tenancy:switched` fires on every HTTP request that resolves a tenant.
     * Capturing it by default meant one audit row per request, forever — a
     * compliance trail drowned in routing noise. It also fires *inside* the
     * new tenant's context during provisioning, which is what broke tenant
     * creation outright.
     *
     * `tenancy:created` is the opposite: rare, meaningful, and emitted outside
     * the tenant context. It stays.
     */
    const app = await createApp({ plugins: [eventsPlugin(), auditPlugin()] }).boot()
    const audit = app.container.get(AUDIT)

    await app.hooks.emit('tenancy:created', { tenant: { id: 't1' } })
    await app.hooks.emit('tenancy:switched', { tenant: { id: 't1' } })

    // `systemTrail` e não `trail`: estes eventos não têm ator nem tenant, e o
    // `trail` filtra por contexto.
    const entries = await audit.systemTrail({})
    const eventos = entries.map((e) => e.event)
    expect(eventos).toContain('tenancy:created')
    expect(eventos).not.toContain('tenancy:switched')

    await app.shutdown()
  })
})

describe('F-13 · the combination that broke: audit + tenancy + schema-per-tenant', () => {
  it('provisions a tenant on the default configuration', async () => {
    /**
     * The end-to-end shape of the bug, with both packages composed exactly as
     * an application would: no `hooks` option, so the defaults apply.
     *
     * The store stands in for one bound to the tenant's own database — it
     * rejects any write carrying a tenant id whose storage does not exist yet.
     * That is precisely the state during `provision()`.
     *
     * Before the fix: `run()` entered the new tenant's context, emitted
     * `tenancy:switched`, the audit write failed, the rejection propagated out
     * of `provision()`, and the tenant was marked `failed`. An application on
     * the default configuration could not create a single tenant.
     */
    const provisioned = new Set<string>()
    const store: AuditStore = {
      async append(entry) {
        if (entry.tenantId && !provisioned.has(entry.tenantId)) {
          throw new Error('relation "audit_entries" does not exist')
        }
      },
      async query() {
        return []
      },
    }

    const app = await createApp({
      plugins: [
        auditPlugin({ store }),
        tenancyPlugin({
          source: new MemoryTenantSource(),
          onProvision: async (t) => {
            provisioned.add(t.id)
          },
        }),
      ],
    }).boot()

    const tenant = await app.container.get(TENANCY).create({ id: 'acme', name: 'Acme' })
    expect(tenant.id).toBe('acme')
    expect(tenant.status).not.toBe('failed')

    await app.shutdown()
  })
})
