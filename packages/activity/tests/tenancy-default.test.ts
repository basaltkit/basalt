import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { ACTIVITY, activityPlugin } from '../src/index.js'

/**
 * B17 · the safe mode existed and was not the default.
 *
 * `tenantScoped` accepted `true` (the default), `'required'` and `false`, and
 * `true` meant: scope to the context tenant when there is one, and **run
 * unscoped when there is not**. In a multi-tenant application a feed query made
 * outside a tenant context therefore returned every firm's records.
 *
 * An activity record is not an aggregate number. It reads "Dr. Kiala opened
 * matter 2026/014 for Kwanza Lda" — another firm's client, by name, in prose.
 *
 * The fix follows the rule the framework already states and `@basaltkit/cache`
 * already implements: a generic package never *requires* tenancy, but when
 * tenancy is present it adopts the safe default by itself.
 */

/** Stands in for `tenancyPlugin`: all this package reads is the marker. */
const fakeTenancy = definePlugin({
  name: 'fake-tenancy',
  register({ container }) {
    ensureMetadata(container).add('tenancy:active', true)
  },
})

type ActivityService = ReturnType<typeof activityService>
const activityService = (app: { container: { get: (t: typeof ACTIVITY) => unknown } }) =>
  app.container.get(ACTIVITY) as {
    performedOn: (type: string, id: string) => { log: (d: string) => Promise<unknown> }
    query: (q: Record<string, unknown>) => Promise<Array<{ subjectId?: string }>>
  }

const seed = async (activity: ActivityService) => {
  await runWithContext({ tenant: { id: 'acme' } }, () =>
    activity.performedOn('matter', '1').log('opened'),
  )
  await runWithContext({ tenant: { id: 'globex' } }, () =>
    activity.performedOn('matter', '2').log('opened'),
  )
}

describe('F-31 · activity adopts the safe scope when tenancy is present', () => {
  it('refuses an unscoped query instead of returning every tenant', async () => {
    const app = await createApp({ plugins: [fakeTenancy, activityPlugin()] }).boot()
    const activity = activityService(app)
    await seed(activity)

    // The whole gap. Before this, the same call answered with both firms'
    // records — one of which names the other's client.
    await expect(activity.query({})).rejects.toThrow()
    await app.shutdown()
  })

  it('still scopes normally inside a tenant', async () => {
    const app = await createApp({ plugins: [fakeTenancy, activityPlugin()] }).boot()
    const activity = activityService(app)
    await seed(activity)

    const rows = await runWithContext({ tenant: { id: 'acme' } }, () => activity.query({}))
    expect(rows.map((r) => r.subjectId)).toEqual(['1'])
    await app.shutdown()
  })

  it('leaves a single-tenant app exactly as it was', async () => {
    // No tenancy marker: there is no tenant dimension, so there is nothing to
    // cross and nothing to refuse. Tightening here would break every app that
    // never asked for tenancy.
    const app = await createApp({ plugins: [activityPlugin()] }).boot()
    const activity = activityService(app)
    await activity.performedOn('matter', '1').log('opened')

    expect(await activity.query({})).toHaveLength(1)
    await app.shutdown()
  })

  it('an explicit choice still wins, in either direction', async () => {
    // The tightening is a default, not a policy. An app that has a reason to
    // read across tenants — an operator console — says so and is obeyed.
    const loose = await createApp({
      plugins: [fakeTenancy, activityPlugin({ tenantScoped: false })],
    }).boot()
    const activity = activityService(loose)
    await seed(activity)
    expect(await activity.query({})).toHaveLength(2)
    await loose.shutdown()

    const strict = await createApp({
      plugins: [fakeTenancy, activityPlugin({ tenantScoped: 'required' })],
    }).boot()
    await expect(activityService(strict).query({})).rejects.toThrow()
    await strict.shutdown()
  })
})
