import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  DriveConnectionNotFoundError,
  DriveProviderUnknownError,
  DriveTenantMismatchError,
  DriveTenantRequiredError,
} from '../src/errors.js'
import { connect, harness } from './helpers.js'

describe('connections', () => {
  it('stores a connection and returns a view with no credentials in it', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })

    expect(view.provider).toBe('fake')
    expect(view.label).toBe('Drive Finance')
    expect(view.status).toBe('active')
    // The whole point of the view type: there is no `secret` key to leak.
    expect(view).not.toHaveProperty('secret')
    expect(JSON.stringify(view)).not.toContain('refresh-')
    expect(JSON.stringify(view)).not.toContain('access-')
  })

  it('encrypts the credentials at rest, bound to the row', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    const stored = await h.store.find('acme', view.id)

    expect(stored?.secret).toMatch(/^bkd1\.k1\./)
    expect(stored?.secret).not.toContain('refresh-')
    expect(stored?.secret).not.toContain('access-')
  })

  it('records the provider account when the adapter exposes one', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    expect(view.account).toEqual({ id: 'fake-account', email: 'drive@example.test', name: 'Fake Account' })
  })

  it('refuses an unknown provider, naming the registered ones', async () => {
    const h = harness()
    await expect(
      h.drives.connect({ provider: 'nope', label: 'x', tokens: { accessToken: 'a' }, tenantId: 'acme' }),
    ).rejects.toThrow(DriveProviderUnknownError)
    expect(h.drives.providerNames()).toEqual(['fake'])
  })

  describe('multiple connections of the same provider per tenant', () => {
    it('keeps "Drive Finance" and "Drive HR" fully independent', async () => {
      const h = harness()
      const finance = await connect(h, { tenantId: 'acme', label: 'Drive Finance', rootId: 'folder-finance' })
      const hr = await connect(h, { tenantId: 'acme', label: 'Drive HR', rootId: 'folder-hr' })

      expect(finance.id).not.toBe(hr.id)
      const listed = await h.drives.list({ tenantId: 'acme' })
      expect(listed.map((c) => c.label).sort()).toEqual(['Drive Finance', 'Drive HR'])
      expect(listed.map((c) => c.rootId).sort()).toEqual(['folder-finance', 'folder-hr'])

      // Independent credentials: each row's blob is bound to its own id, so
      // they are not interchangeable even though both are the same account.
      const a = await h.store.find('acme', finance.id)
      const b = await h.store.find('acme', hr.id)
      expect(a?.secret).not.toBe(b?.secret)
    })

    it('filters a listing by provider and status', async () => {
      const h = harness()
      await connect(h, { tenantId: 'acme', label: 'A' })
      const other = await connect(h, { tenantId: 'acme', label: 'B' })
      await h.store.update('acme', other.id, { status: 'invalid' })

      expect(await h.drives.list({ tenantId: 'acme', provider: 'fake' })).toHaveLength(2)
      expect(await h.drives.list({ tenantId: 'acme', status: 'active' })).toHaveLength(1)
      expect(await h.drives.list({ tenantId: 'acme', provider: 'other' })).toHaveLength(0)
    })
  })

  describe('tenant isolation — enforced in the data layer', () => {
    it('does not list another tenant’s connections', async () => {
      const h = harness()
      await connect(h, { tenantId: 'acme', label: 'Acme Drive' })
      await connect(h, { tenantId: 'globex', label: 'Globex Drive' })

      expect((await h.drives.list({ tenantId: 'acme' })).map((c) => c.label)).toEqual(['Acme Drive'])
      expect((await h.drives.list({ tenantId: 'globex' })).map((c) => c.label)).toEqual(['Globex Drive'])
    })

    it('reports another tenant’s connection as NOT FOUND, never as forbidden', async () => {
      const h = harness()
      const acme = await connect(h, { tenantId: 'acme' })
      // A 403 would confirm the id exists — an oracle across tenants.
      await expect(h.drives.get(acme.id, 'globex')).rejects.toThrow(DriveConnectionNotFoundError)
      await expect(h.drives.get(acme.id, 'globex')).rejects.toMatchObject({ status: 404 })
    })

    it('cannot be widened by an explicit tenantId when a tenant is in context', async () => {
      const h = harness({ tenancyActive: true })
      const acme = await connect(h, { tenantId: 'acme' })
      await connect(h, { tenantId: 'globex' })

      // The classic bug: a route forwards `?tenantId=` from the client.
      await runWithContext({ tenant: { id: 'globex' } } as never, async () => {
        await expect(h.drives.get(acme.id, 'acme')).rejects.toThrow(DriveTenantMismatchError)
        await expect(h.drives.list({ tenantId: 'acme' })).rejects.toThrow(DriveTenantMismatchError)
      })
    })

    it('uses the ambient tenant when no explicit one is passed', async () => {
      const h = harness({ tenancyActive: true })
      await connect(h, { tenantId: 'acme', label: 'Acme Drive' })
      await runWithContext({ tenant: { id: 'acme' } } as never, async () => {
        expect((await h.drives.list()).map((c) => c.label)).toEqual(['Acme Drive'])
      })
    })

    it('refuses to run unscoped while tenancy is active', async () => {
      const h = harness({ tenancyActive: true })
      await expect(h.drives.list()).rejects.toThrow(DriveTenantRequiredError)
    })

    it('works unscoped when the app is single-tenant', async () => {
      const h = harness({ tenancyActive: false })
      await connect(h)
      expect(await h.drives.list()).toHaveLength(1)
    })

    it('ignores a store that answers across tenants', async () => {
      const h = harness()
      const acme = await connect(h, { tenantId: 'acme', label: 'Acme Drive' })
      await connect(h, { tenantId: 'globex', label: 'Globex Drive' })

      // A deliberately broken store: it ignores the tenant argument entirely.
      // The facade re-filters, so a bad store cannot widen a result set.
      const leaky = Object.create(h.store) as typeof h.store
      leaky.list = async () => [
        (await h.store.find('acme', acme.id))!,
        ...(await h.store.list('globex')),
      ]
      const drives = new (await import('../src/drives.js')).Drives({
        providers: [h.fake],
        keys: [{ id: 'k1', key: 'k'.repeat(32) }],
        secret: 'test-app-secret-value',
        store: leaky,
      })
      expect((await drives.list({ tenantId: 'acme' })).map((c) => c.label)).toEqual(['Acme Drive'])
    })
  })

  describe('disconnect', () => {
    it('revokes at the provider by default and deletes the row', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      await h.drives.disconnect(view.id, { tenantId: 'acme' })

      expect(h.fake.calls['revoke']).toBe(1)
      expect(await h.store.find('acme', view.id)).toBeNull()
    })

    it('can skip revocation when the caller asks', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      await h.drives.disconnect(view.id, { tenantId: 'acme', revoke: false })

      expect(h.fake.calls['revoke']).toBeUndefined()
      expect(await h.store.find('acme', view.id)).toBeNull()
    })

    it('still deletes the row when revocation fails at the provider', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      h.fake.authorization.revoke = async () => {
        throw new Error('provider is down')
      }
      await h.drives.disconnect(view.id, { tenantId: 'acme' })
      expect(await h.store.find('acme', view.id)).toBeNull()
    })

    it('cannot disconnect another tenant’s connection', async () => {
      const h = harness()
      const acme = await connect(h, { tenantId: 'acme' })
      await expect(h.drives.disconnect(acme.id, { tenantId: 'globex' })).rejects.toThrow(DriveConnectionNotFoundError)
      expect(await h.store.find('acme', acme.id)).not.toBeNull()
    })
  })
})
