import { describe, expect, it } from 'vitest'
import { createApp, tryCtx } from '@basaltkit/core'
import {
  MemoryTenantSource,
  TENANCY,
  TenantAlreadyExistsError,
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
 * A source may implement only `save()` (an upsert) — the durable sources did,
 * until they gained an insert-only `create()`. Requiring `create()` limited this
 * whole flow to `MemoryTenantSource`, which is to say to tests: a real app on
 * Prisma got TENANT_CREATE_UNSUPPORTED from a source that persists tenants
 * perfectly well.
 *
 * Shipped that way in 1.5.0 and caught in a real app, because every test here
 * used the one source that happens to have `create()`. A third-party save-only
 * source is still supported, and still refuses an existing id.
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

  it('refuses an existing id through the find() pre-check, writing nothing', async () => {
    // A save-only source has no insert that could refuse the duplicate; without
    // the pre-check its upsert would replace the record wholesale.
    const { source, rows } = saveOnly()
    const saves: Tenant[] = []
    const counting: TenantSource = {
      find: source.find,
      save: async (tenant) => {
        saves.push(tenant)
        return source.save(tenant)
      },
    }
    const provisioned: string[] = []
    const { app, tenancy } = await boot({ source: counting, onProvision: (t) => void provisioned.push(t.id) })

    await tenancy.create({ id: 'acme', name: 'Acme' })
    const writes = saves.length
    await expect(tenancy.create({ id: 'acme', name: 'Other' })).rejects.toBeInstanceOf(TenantAlreadyExistsError)

    expect(saves).toHaveLength(writes)
    expect(rows.get('acme')).toMatchObject({ name: 'Acme', status: 'ready' })
    expect(provisioned).toEqual(['acme'])
    await app.shutdown()
  })

  it('names both ways out when a source can do neither', async () => {
    const { app, tenancy } = await boot({ source: { find: async () => null } })
    await expect(tenancy.create({ id: 'acme' })).rejects.toThrow(/neither create\(\) nor save\(\)/)
    await app.shutdown()
  })
})

/**
 * `create()` used to persist through the durable sources' `save`, an upsert. A
 * second create for an existing id — a double-submitted signup, an operator
 * re-running `tenant:create` — replaced the whole record: the owner was lost, a
 * suspended firm came back to life and provisioning ran again over live data.
 * Found in a real app review. An existing id is now refused, whatever its
 * status, before anything is written.
 */
describe('creating a tenant that already exists', () => {
  it('rejects with 409 and leaves the record, the hooks and provisioning alone', async () => {
    const provisioned: string[] = []
    const created: string[] = []
    const { app, tenancy, source } = await boot({ onProvision: (t) => void provisioned.push(t.id) })
    app.hooks.on('tenancy:created', ({ tenant }) => void created.push(tenant.id))

    await tenancy.create({ id: 'acme', name: 'Acme', ownerUserId: 'u1' })

    const error = await tenancy.create({ id: 'acme', name: 'Impostor' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TenantAlreadyExistsError)
    expect(error).toMatchObject({ code: 'TENANT_ALREADY_EXISTS', status: 409 })
    expect((error as Error).message).toMatch(/"acme" already exists/)

    expect(await source.find('acme')).toMatchObject({ name: 'Acme', ownerUserId: 'u1', status: 'ready' })
    expect(provisioned).toEqual(['acme'])
    expect(created).toEqual(['acme'])
    await app.shutdown()
  })

  it('points a failed tenant at provision() instead of creating it again', async () => {
    let attempts = 0
    const { app, tenancy, source } = await boot({
      onProvision: () => {
        attempts++
        throw new Error('CREATE SCHEMA denied')
      },
    })
    await expect(tenancy.create({ id: 'acme' })).rejects.toThrow('CREATE SCHEMA denied')

    const error = await tenancy.create({ id: 'acme' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TenantAlreadyExistsError)
    expect((error as Error).message).toMatch(/status "failed".*tenancy\.provision\("acme"\)/)
    // Refused before provisioning — the retry path is provision(id), not create.
    expect(attempts).toBe(1)
    expect((await source.find('acme'))?.['status']).toBe('failed')
    await app.shutdown()
  })

  it('gives exactly one winner to two concurrent creates of the same id', async () => {
    // Both calls pass the find() pre-check before either writes; the source's
    // own create() is what refuses the second.
    const provisioned: string[] = []
    const { app, tenancy, source } = await boot({ onProvision: (t) => void provisioned.push(String(t['name'])) })

    const results = await Promise.allSettled([
      tenancy.create({ id: 'acme', name: 'first' }),
      tenancy.create({ id: 'acme', name: 'second' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(TenantAlreadyExistsError)
    expect(provisioned).toHaveLength(1)
    expect((await source.find('acme'))?.['name']).toBe(provisioned[0])
    await app.shutdown()
  })
})

describe('MemoryTenantSource.create', () => {
  it('refuses an existing id and keeps the first record', async () => {
    const source = new MemoryTenantSource()
    await source.create({ id: 'acme', name: 'Acme' })

    await expect(source.create({ id: 'acme', name: 'Other' })).rejects.toBeInstanceOf(TenantAlreadyExistsError)
    expect(await source.find('acme')).toEqual({ id: 'acme', name: 'Acme' })
  })

  it('leaves add() and save() as upserts', async () => {
    const source = new MemoryTenantSource().add({ id: 'acme', name: 'Acme' }).add({ id: 'acme', name: 'Seeded' })
    await source.save({ id: 'acme', name: 'Saved' })
    expect(await source.find('acme')).toEqual({ id: 'acme', name: 'Saved' })
  })
})
