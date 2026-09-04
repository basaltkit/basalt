import { describe, expect, it, vi } from 'vitest'
import { HookBus } from '@basaltkit/core'
import {
  MemoryTenantSource,
  Tenancy,
  TenantDeleteUnsupportedError,
  TenantNotFoundError,
  type Tenant,
} from '../src/index.js'

/**
 * B10 · a tenant can be removed.
 *
 * `TenantSource` had `find`, `findByDomain`, `list`, `create` and `save`, and
 * `Tenancy` had no `destroy`. There was no path out — not even an optional one.
 *
 * Two consequences, both real. In tests, isolation suites reached for
 * `$executeRawUnsafe('DROP SCHEMA …')` with a string-interpolated identifier;
 * without that cleanup a leftover schema makes provisioning a no-op and every
 * assertion below it passes without testing anything. In production, a
 * self-serve signup that failed halfway left a PostgreSQL schema that nothing
 * in the framework could remove.
 */

const tenancy = (opts: {
  source?: MemoryTenantSource
  hooks?: HookBus
  onProvision?: (t: Tenant) => Promise<void> | void
  onDeprovision?: (t: Tenant) => Promise<void> | void
} = {}) => {
  const source = opts.source ?? new MemoryTenantSource()
  return {
    source,
    service: new Tenancy(
      source,
      [],
      opts.hooks,
      opts.onProvision,
      undefined,
      opts.onDeprovision,
    ),
  }
}

describe('F-29 · Tenancy.destroy', () => {
  it('runs onDeprovision inside the tenant context, then removes the record', async () => {
    const seen: Array<string | undefined> = []
    const { source, service } = tenancy({
      onDeprovision: async () => {
        // Inside the context, exactly like onProvision — so a tenant-scoped
        // client resolves to the schema that is about to be dropped, rather
        // than to whatever the caller happened to be in.
        const { ctx } = await import('@basaltkit/core')
        seen.push((ctx()['tenant'] as Tenant | undefined)?.id)
      },
    })

    await service.create({ id: 'acme' } as Tenant)
    await service.destroy('acme')

    expect(seen).toEqual(['acme'])
    expect(await source.find('acme')).toBeNull()
  })

  it('stops serving the tenant before its storage is touched', async () => {
    const statuses: Array<string | undefined> = []
    const { source, service } = tenancy({
      onDeprovision: async () => {
        // The status the resolver sees while the schema is being dropped. If it
        // still said `ready` here, a request arriving mid-teardown would be
        // routed to storage that is being deleted underneath it.
        statuses.push((await source.find('acme'))?.['status'] as string | undefined)
      },
    })

    await service.create({ id: 'acme' } as Tenant)
    await service.destroy('acme')
    expect(statuses).toEqual(['deleting'])
  })

  it('keeps the record when deprovisioning fails', async () => {
    const { source, service } = tenancy({
      onDeprovision: () => {
        throw new Error('DROP SCHEMA failed')
      },
    })

    await service.create({ id: 'acme' } as Tenant)
    await expect(service.destroy('acme')).rejects.toThrow('DROP SCHEMA failed')

    // The record is the only thing naming the storage that is still out there.
    // Deleting it on a failed teardown would orphan a schema nobody can find.
    const remaining = await source.find('acme')
    expect(remaining).not.toBeNull()
    expect(remaining?.['status']).toBe('deleting')
  })

  it('force removes the record even when deprovisioning fails', async () => {
    const { source, service } = tenancy({
      onDeprovision: () => {
        throw new Error('DROP SCHEMA failed')
      },
    })

    await service.create({ id: 'acme' } as Tenant)
    // The escape hatch, for when the storage is already gone by other means.
    await service.destroy('acme', { force: true })
    expect(await source.find('acme')).toBeNull()
  })

  it('emits tenancy:destroyed only after the record is gone', async () => {
    const hooks = new HookBus()
    const { source, service } = tenancy({ hooks })
    const recordGoneWhenEmitted: Array<boolean> = []
    hooks.on('tenancy:destroyed', async () => {
      recordGoneWhenEmitted.push((await source.find('acme')) === null)
    })

    await service.create({ id: 'acme' } as Tenant)
    await service.destroy('acme')
    // A listener that reacts by cleaning up its own rows must not find the
    // tenant still listed.
    expect(recordGoneWhenEmitted).toEqual([true])
  })

  it('refuses a tenant that is not there', async () => {
    const { service } = tenancy()
    await expect(service.destroy('never-existed')).rejects.toThrow(TenantNotFoundError)
  })

  it('refuses a source that cannot delete, instead of reporting success', async () => {
    const sourceWithoutDelete = {
      find: async () => ({ id: 'acme' }) as Tenant,
      save: async (t: Tenant) => t,
    }
    const service = new Tenancy(sourceWithoutDelete, [])
    await expect(service.destroy('acme')).rejects.toThrow(TenantDeleteUnsupportedError)
  })

  it('does not run onDeprovision when there is none, and still removes the record', async () => {
    const { source, service } = tenancy()
    await service.create({ id: 'acme' } as Tenant)
    await service.destroy('acme')
    expect(await source.find('acme')).toBeNull()
  })

  it('leaves other tenants alone', async () => {
    const deprovisioned = vi.fn()
    const { source, service } = tenancy({ onDeprovision: deprovisioned })
    await service.create({ id: 'acme' } as Tenant)
    await service.create({ id: 'globex' } as Tenant)

    await service.destroy('acme')

    expect(await source.find('globex')).not.toBeNull()
    expect(deprovisioned).toHaveBeenCalledTimes(1)
  })
})
