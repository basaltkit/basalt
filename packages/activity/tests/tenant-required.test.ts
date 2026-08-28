import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { TenantRequiredError } from '@basaltkit/tenancy'
import { Activity } from '../src/index.js'

const seed = async (activity: Activity) => {
  await runWithContext({ tenant: { id: 'acme' } }, () => activity.in('default').log('acme event'))
  await runWithContext({ tenant: { id: 'globex' } }, () => activity.in('default').log('globex event'))
}

describe("Activity tenantScoped: 'required' (fail-closed)", () => {
  it('scopes to the context tenant, and the context wins over query.tenantId', async () => {
    const activity = new Activity({ tenantScoped: 'required' })
    await seed(activity)
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      const rows = await activity.query({})
      expect(rows.map((r) => r.description)).toEqual(['acme event'])
      // anti-widening: a (possibly client-supplied) tenantId cannot switch tenants
      const widened = await activity.query({ tenantId: 'globex' })
      expect(widened.map((r) => r.description)).toEqual(['acme event'])
    })
  })

  it('honours an explicit tenantId when no tenant is in context (system code)', async () => {
    const activity = new Activity({ tenantScoped: 'required' })
    await seed(activity)
    const rows = await activity.query({ tenantId: 'globex' })
    expect(rows.map((r) => r.description)).toEqual(['globex event'])
  })

  it('throws TenantRequiredError instead of returning every tenant fail-open', async () => {
    const activity = new Activity({ tenantScoped: 'required' })
    await seed(activity)
    await expect(activity.query({})).rejects.toBeInstanceOf(TenantRequiredError)
  })

  it('default (true) keeps the historical fail-open behavior — unchanged', async () => {
    const activity = new Activity()
    await seed(activity)
    const rows = await activity.query({})
    expect(rows).toHaveLength(2)
  })
})
