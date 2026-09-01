import { describe, expect, it } from 'vitest'
import { createApp, tryCtx } from '@basaltkit/core'
import {
  MemoryTenantSource,
  TENANCY,
  TenantCreateUnsupportedError,
  headerResolver,
  tenancyPlugin,
  type Tenant,
  type TenantSource,
} from '../src/index.js'

/**
 * Creating a tenant has to bring its storage into existence, not just write a
 * row. Before `onProvision` existed, `tenant:create` persisted the record and
 * stopped — and `subdomainResolver` would route traffic to it immediately, so
 * the new tenant's very first request hit a schema that was never created.
 *
 * That is fine for an operator who knows to run `basalt tenant:migrate` next.
 * It is not fine for self-service signup from an admin panel, where nobody is
 * standing by and the person clicking "create" has no access to the infra.
 */

const boot = async (options: {
  onProvision?: (tenant: Tenant) => void | Promise<void>
  source?: TenantSource
}) => {
  const source = options.source ?? new MemoryTenantSource()
  const app = await createApp({
    plugins: [
      tenancyPlugin({
        source,
        resolvers: [headerResolver()],
        ...(options.onProvision ? { onProvision: options.onProvision } : {}),
      }),
    ],
  }).boot()
  return { app, source, tenancy: app.container.get(TENANCY) }
}

describe('provisioning a new tenant', () => {
  it('persists the record, then provisions it, then announces it', async () => {
    const order: string[] = []
    const source = new MemoryTenantSource()
    const app = await createApp({
      plugins: [
        tenancyPlugin({
          source,
          resolvers: [headerResolver()],
          onProvision: async (tenant) => {
            // The record must already exist by now — provisioning reads it.
            expect(await source.find(tenant.id)).not.toBeNull()
            order.push('provision')
          },
        }),
      ],
    }).boot()
    app.hooks.on('tenancy:created', () => void order.push('created'))

    const tenant = await app.container.get(TENANCY).create({ id: 'acme', name: 'Acme' })

    expect(tenant.id).toBe('acme')
    // Order matters: a listener on `tenancy:created` may assume the tenant's
    // storage is ready, which is only true if provisioning already ran.
    expect(order).toEqual(['provision', 'created'])
    await app.shutdown()
  })

  it('runs onProvision inside the new tenant’s context', async () => {
    // So `ctx().tenant` and any tenant-scoped client resolve to the right
    // tenant, exactly as they do for onMigrate and onSeed.
    let seen: string | undefined
    const { app, tenancy } = await boot({
      onProvision: () => void (seen = tryCtx()?.tenant?.id),
    })
    await tenancy.create({ id: 'acme', name: 'Acme' })
    expect(seen).toBe('acme')
    await app.shutdown()
  })

  it('emits nothing and rethrows when provisioning fails', async () => {
    const events: Tenant[] = []
    const source = new MemoryTenantSource()
    const app = await createApp({
      plugins: [
        tenancyPlugin({
          source,
          resolvers: [headerResolver()],
          onProvision: () => {
            throw new Error('CREATE SCHEMA denied')
          },
        }),
      ],
    }).boot()
    app.hooks.on('tenancy:created', ({ tenant }) => void events.push(tenant))

    await expect(app.container.get(TENANCY).create({ id: 'acme' })).rejects.toThrow(
      'CREATE SCHEMA denied',
    )
    // No announcement — a listener reacting to a half-built tenant is worse
    // than one that never runs.
    expect(events).toEqual([])
    // But the record IS there, because the source persisted it first. This is
    // the documented half-state: not rolled back, and the reason onProvision is
    // required to be idempotent so a retry can finish the job.
    expect(await source.find('acme')).not.toBeNull()

    await app.shutdown()
  })

  it('still creates and announces when no onProvision is configured', async () => {
    // Single-database apps need no provisioning at all; the hook stays useful
    // on its own (welcome email, audit entry).
    const events: string[] = []
    const { app, tenancy, source } = await boot({})
    app.hooks.on('tenancy:created', ({ tenant }) => void events.push(tenant.id))

    await tenancy.create({ id: 'acme' })
    expect(events).toEqual(['acme'])
    expect(await source.find('acme')).not.toBeNull()
    await app.shutdown()
  })

  it('refuses clearly on a source that cannot persist', async () => {
    const readOnly: TenantSource = { find: async () => null }
    const { app, tenancy } = await boot({ source: readOnly })
    await expect(tenancy.create({ id: 'acme' })).rejects.toBeInstanceOf(
      TenantCreateUnsupportedError,
    )
    await expect(tenancy.create({ id: 'acme' })).rejects.toThrow(/neither create\(\) nor save\(\)/)
    await app.shutdown()
  })

  it('carries the extra fields the caller passed', async () => {
    const { app, tenancy, source } = await boot({})
    await tenancy.create({ id: 'acme', name: 'Acme', domain: 'acme.test' } as Tenant)
    const stored = await source.find('acme')
    expect(stored).toMatchObject({ id: 'acme', name: 'Acme', domain: 'acme.test' })
    await app.shutdown()
  })
})

/**
 * The durable sources — `@basaltkit/tenancy-prisma` and
 * `@basaltkit/tenancy-sqlite` — implement `save()` (an upsert), not `create()`.
 * Requiring `create()` limited this whole flow to `MemoryTenantSource`, which is
 * to say to tests: a real app on Prisma got TENANT_CREATE_UNSUPPORTED from a
 * source that persists tenants perfectly well.
 *
 * Shipped that way in 1.5.0 and caught in a real app, because every test here
 * used the one source that happens to have `create()`.
 */
describe('sources that persist through save() instead of create()', () => {
  const saveOnly = () => {
    const rows = new Map<string, Tenant>()
    return {
      rows,
      source: {
        find: async (id: string) => rows.get(id) ?? null,
        save: async (tenant: Tenant) => {
          rows.set(tenant.id, tenant)
          return tenant
        },
      } satisfies TenantSource,
    }
  }

  it('creates and provisions through save()', async () => {
    const { source, rows } = saveOnly()
    const order: string[] = []
    const app = await createApp({
      plugins: [
        tenancyPlugin({
          source,
          resolvers: [headerResolver()],
          onProvision: () => void order.push('provision'),
        }),
      ],
    }).boot()
    app.hooks.on('tenancy:created', () => void order.push('created'))

    const tenant = await app.container.get(TENANCY).create({ id: 'acme', name: 'Acme' })

    expect(tenant).toMatchObject({ id: 'acme', name: 'Acme' })
    expect(rows.get('acme')).toMatchObject({ id: 'acme' })
    expect(order).toEqual(['provision', 'created'])
    await app.shutdown()
  })

  it('prefers create() when a source offers both', async () => {
    // `create` is the stricter of the two (it may reject a duplicate), so it
    // wins wherever it exists.
    const calls: string[] = []
    const source: TenantSource = {
      find: async () => null,
      create: async (t) => {
        calls.push('create')
        return t
      },
      save: async (t) => {
        calls.push('save')
        return t
      },
    }
    const { app, tenancy } = await boot({ source })
    await tenancy.create({ id: 'acme' })
    expect(calls).toEqual(['create'])
    await app.shutdown()
  })

  it('names both ways out when a source can do neither', async () => {
    const { app, tenancy } = await boot({ source: { find: async () => null } })
    await expect(tenancy.create({ id: 'acme' })).rejects.toThrow(/neither create\(\) nor save\(\)/)
    await app.shutdown()
  })
})
