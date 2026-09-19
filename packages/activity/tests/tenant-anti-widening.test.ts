import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { Activity } from '../src/index.js'

const seed = async (activity: Activity) => {
  await runWithContext({ tenant: { id: 'acme' } }, () => activity.in('default').log('acme event'))
  await runWithContext({ tenant: { id: 'globex' } }, () => activity.in('default').log('globex event'))
}

describe('Activity tenantScoped: true — the context tenant cannot be widened by query.tenantId', () => {
  it('forces the context tenant over a caller-supplied query.tenantId (query)', async () => {
    const activity = new Activity({ tenantScoped: true })
    await seed(activity)
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      const rows = await activity.query({ tenantId: 'globex' })
      expect(rows.map((r) => r.description)).toEqual(['acme event'])
    })
  })

  it('is enforced by default (no options) as well', async () => {
    const activity = new Activity()
    await seed(activity)
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      const rows = await activity.query({ tenantId: 'globex', log: 'default' })
      expect(rows.map((r) => r.description)).toEqual(['acme event'])
    })
  })

  it('an empty-string tenantId does not bypass the context tenant', async () => {
    const activity = new Activity()
    await seed(activity)
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      const rows = await activity.query({ tenantId: '' })
      expect(rows.map((r) => r.description)).toEqual(['acme event'])
    })
  })

  it('still honours an explicit tenantId when no tenant is in context (system code)', async () => {
    const activity = new Activity()
    await seed(activity)
    const rows = await activity.query({ tenantId: 'globex' })
    expect(rows.map((r) => r.description)).toEqual(['globex event'])
  })

  it('tenantScoped: false keeps the caller-supplied tenantId (explicit opt-out)', async () => {
    const activity = new Activity({ tenantScoped: false })
    await seed(activity)
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      const rows = await activity.query({ tenantId: 'globex' })
      expect(rows.map((r) => r.description)).toEqual(['globex event'])
    })
  })
})
