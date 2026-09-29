import { describe, expect, it } from 'vitest'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route } from '@basaltkit/fastify'
import {
  MemoryTenantSource,
  TENANCY,
  headerResolver,
  Tenancy,
  assertTenantServing,
  isTenantReady,
  TenantNotReadyError,
  TenantStatusUnknownError,
  TenantSuspendedError,
  tenancyPlugin,
  type Tenant,
} from '../src/index.js'

/**
 * A tenant record can exist before its storage does. The resolvers route by the
 * record, so without a status that window is one in which the tenant is
 * reachable AND broken — its first request dies on a raw database error.
 *
 * The status closes it: `provisioning` and `failed` answer 503 (retryable, and
 * true — the tenant exists, it just is not serving), and only `ready` serves.
 */

const ping = route({ method: 'GET', url: '/ping', async handler() { return { ok: true } } })

async function boot(options: {
  source?: MemoryTenantSource
  onProvision?: (t: Tenant) => void | Promise<void>
  provision?: 'inline' | 'deferred'
} = {}) {
  const source = options.source ?? new MemoryTenantSource()
  const app: BasaltApp = await createApp({
    plugins: [
      tenancyPlugin({
        source,
        resolvers: [headerResolver()],
        ...(options.onProvision ? { onProvision: options.onProvision } : {}),
        ...(options.provision ? { provision: options.provision } : {}),
      }),
      fastifyPlugin({ routes: [ping] }),
    ],
  }).boot()
  const server = app.container.get(FASTIFY)
  const call = (tenant: string) =>
    server.inject({ method: 'GET', url: '/ping', headers: { 'x-tenant-id': tenant } })
  return { app, source, tenancy: app.container.get(TENANCY), call }
}

describe('tenant status', () => {
  it('inline provisioning leaves the tenant ready and serving', async () => {
    const { app, tenancy, call } = await boot({ onProvision: () => {} })
    const tenant = await tenancy.create({ id: 'acme' })

    expect(tenant['status']).toBe('ready')
    expect((await call('acme')).statusCode).toBe(200)
    await app.shutdown()
  })

  it('answers 503 while a deferred tenant is still provisioning', async () => {
    const announced: string[] = []
    const { app, tenancy, call } = await boot({ onProvision: () => {}, provision: 'deferred' })
    app.hooks.on('tenancy:created', ({ tenant }) => void announced.push(tenant.id))

    const tenant = await tenancy.create({ id: 'acme' })
    expect(tenant['status']).toBe('provisioning')
    // Not announced yet — the storage does not exist.
    expect(announced).toEqual([])

    const response = await call('acme')
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('TENANT_NOT_READY')
    // 503 and not 404: the tenant exists, and the client may retry. (The HTTP
    // layer replaces a toolkit 5xx message with a fixed one, so assert the code.)
    expect(new TenantNotReadyError('acme', 'provisioning').message).toMatch(/still being provisioned/)

    await app.shutdown()
  })

  it('provision() finishes a deferred tenant and it starts serving', async () => {
    // The cross-process path: a worker re-enters with the id, since a closure
    // from the creating process cannot reach it.
    const announced: string[] = []
    const { app, tenancy, call } = await boot({ onProvision: () => {}, provision: 'deferred' })
    app.hooks.on('tenancy:created', ({ tenant }) => void announced.push(tenant.id))

    await tenancy.create({ id: 'acme' })
    expect((await call('acme')).statusCode).toBe(503)

    const ready = await tenancy.provision('acme')
    expect(ready['status']).toBe('ready')
    expect(announced).toEqual(['acme'])
    expect((await call('acme')).statusCode).toBe(200)

    await app.shutdown()
  })

  it('marks a failed tenant and keeps it out of service', async () => {
    const { app, tenancy, source, call } = await boot({
      onProvision: () => {
        throw new Error('CREATE SCHEMA denied')
      },
    })

    await expect(tenancy.create({ id: 'acme' })).rejects.toThrow('CREATE SCHEMA denied')

    // Marked, not deleted — the record is the evidence that it was attempted.
    expect((await source.find('acme'))?.['status']).toBe('failed')
    const response = await call('acme')
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('TENANT_NOT_READY')
    expect(new TenantNotReadyError('acme', 'failed').message).toMatch(/failed to provision/)

    await app.shutdown()
  })

  it('a retry after a failure brings it back into service', async () => {
    let attempts = 0
    const { app, tenancy, call } = await boot({
      onProvision: () => {
        if (++attempts === 1) throw new Error('transient')
      },
    })
    await expect(tenancy.create({ id: 'acme' })).rejects.toThrow('transient')
    expect((await call('acme')).statusCode).toBe(503)

    await tenancy.provision('acme')
    expect((await call('acme')).statusCode).toBe(200)
    await app.shutdown()
  })

  it('serves tenants that predate the status, which carry none', async () => {
    // The compatibility that matters: every tenant created before this feature
    // has no status. Treating "missing" as anything but ready would 503 a whole
    // production estate on upgrade.
    const source = new MemoryTenantSource().add({ id: 'legacy', name: 'Legacy' })
    const { app, call } = await boot({ source, onProvision: () => {} })

    expect(isTenantReady({ id: 'legacy' })).toBe(true)
    expect((await call('legacy')).statusCode).toBe(200)
    await app.shutdown()
  })

  it('stamps no status at all when there is nothing to provision', async () => {
    // Single-database apps never provision. Marking them `provisioning` would
    // set a flag nothing would ever clear.
    const { app, tenancy, call } = await boot({})
    const tenant = await tenancy.create({ id: 'acme' })

    expect(tenant['status']).toBeUndefined()
    expect((await call('acme')).statusCode).toBe(200)
    await app.shutdown()
  })

  it('answers 403 TENANT_SUSPENDED for a suspended tenant, not "still provisioning"', async () => {
    // A suspension is not a storage problem: retrying will not help, and the
    // old 503 "still being provisioned" sent clients into a retry loop.
    const source = new MemoryTenantSource().add({ id: 'acme', status: 'suspended' })
    const { app, call } = await boot({ source })

    const response = await call('acme')
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('TENANT_SUSPENDED')
    expect(isTenantReady({ id: 'acme', status: 'suspended' })).toBe(false)
    expect(() => assertTenantServing({ id: 'acme', status: 'suspended' })).toThrow(TenantSuspendedError)
    await app.shutdown()
  })

  it('fails closed on a status tenancy does not know, with an accurate message', async () => {
    // `active` is a common app-side spelling of ready. Tenancy cannot tell
    // whether the storage behind it is usable, so it refuses — but it says what
    // it saw instead of claiming the tenant is still being provisioned.
    const source = new MemoryTenantSource().add({ id: 'acme', status: 'active' })
    const { app, call } = await boot({ source })

    const response = await call('acme')
    expect(response.statusCode).toBe(500)
    expect(response.json().error.code).toBe('TENANT_STATUS_UNKNOWN')
    expect(isTenantReady({ id: 'acme', status: 'active' })).toBe(false)
    const error = (() => {
      try {
        assertTenantServing({ id: 'acme', status: 'active' })
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(TenantStatusUnknownError)
    expect((error as Error).message).toMatch(/status "active", which tenancy does not recognise/)
    expect((error as Error).message).not.toMatch(/still being provisioned/)
    await app.shutdown()
  })

  it('maps each known non-serving status to its own error', () => {
    for (const status of ['provisioning', 'failed', 'deleting'] as const) {
      expect(() => assertTenantServing({ id: 'acme', status })).toThrow(TenantNotReadyError)
    }
    expect(() => assertTenantServing({ id: 'acme', status: 'ready' })).not.toThrow()
    expect(() => assertTenantServing({ id: 'acme' })).not.toThrow()
    // A nullable status column holds `null` for "no status" — same as absent.
    expect(isTenantReady({ id: 'acme', status: null })).toBe(true)
    expect(() => assertTenantServing({ id: 'acme', status: 42 })).toThrow(TenantStatusUnknownError)
  })
})

describe('new Tenancy()', () => {
  it('takes an options object, equivalent to the positional form', async () => {
    const provisioned: string[] = []
    const source = new MemoryTenantSource()
    const byName = new Tenancy({
      source,
      resolvers: [headerResolver()],
      onProvision: (t) => void provisioned.push(t.id),
      provisionMode: 'deferred',
      validateTenantId: (id) => id.startsWith('t-'),
    })

    await expect(byName.create({ id: 'acme' })).rejects.toThrow(/Invalid tenant id/)
    const created = await byName.create({ id: 't-acme' })
    expect(created['status']).toBe('provisioning')
    expect(provisioned).toEqual([])
    expect((await byName.resolve({ headers: { 'x-tenant-id': 't-acme' } }))?.id).toBe('t-acme')

    const positional = new Tenancy(new MemoryTenantSource(), [headerResolver()], undefined, undefined, 'deferred')
    expect((await positional.create({ id: 'acme' }))['status']).toBeUndefined()
  })
})
