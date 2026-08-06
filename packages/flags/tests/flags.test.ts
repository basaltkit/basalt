import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@machize/core'
import { defineFlags, FLAGS, flagsPlugin } from '../src/index.js'

const flags = defineFlags({
  newDashboard: { default: false, tenants: { acme: true } },
  maxUploadMb: { default: 10, tenants: { pro: 100 }, users: { vip: 500 } },
  betaSearch: { default: false, rollout: 50 },
  darkLaunch: { default: false, rule: (ctx) => (ctx['region'] === 'eu' ? true : undefined) },
})

describe('FeatureFlags', () => {
  it('resolves defaults, tenant and user overrides (most specific wins)', () => {
    expect(flags.value('newDashboard', {})).toBe(false)
    expect(flags.value('newDashboard', { tenantId: 'acme' })).toBe(true)
    expect(flags.value('maxUploadMb', { tenantId: 'pro' })).toBe(100)
    // user override beats tenant override
    expect(flags.value('maxUploadMb', { tenantId: 'pro', userId: 'vip' })).toBe(500)
  })

  it('custom rules take precedence, undefined falls through', () => {
    expect(flags.value('darkLaunch', { region: 'eu' })).toBe(true)
    expect(flags.value('darkLaunch', { region: 'us' })).toBe(false)
  })

  it('percentage rollout is deterministic per subject', () => {
    const a = flags.enabled('betaSearch', { userId: 'user-1' })
    const b = flags.enabled('betaSearch', { userId: 'user-1' })
    expect(a).toBe(b) // stable
    // across many subjects, roughly half are enabled
    let on = 0
    for (let i = 0; i < 200; i++) if (flags.enabled('betaSearch', { userId: `u${i}` })) on++
    expect(on).toBeGreaterThan(60)
    expect(on).toBeLessThan(140)
  })

  it('all() resolves every flag for a context', () => {
    const resolved = flags.all({ tenantId: 'acme' })
    expect(resolved.newDashboard).toBe(true)
    expect(resolved.maxUploadMb).toBe(10)
  })

  it('falls back to the request context (tenant/user) when none is passed', async () => {
    const app = await createApp({ plugins: [flagsPlugin(flags)] }).boot()
    const resolved = app.container.get(FLAGS)
    const value = await runWithContext({ tenant: { id: 'acme' } } as never, () =>
      resolved.value('newDashboard'),
    )
    expect(value).toBe(true)
    await app.shutdown()
  })
})
