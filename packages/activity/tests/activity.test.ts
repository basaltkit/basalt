import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import { ACTIVITY, Activity, activityPlugin } from '../src/index.js'

const asAcmeUser = <T>(fn: () => Promise<T>) =>
  runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, fn)

describe('Activity', () => {
  it('fluent builder: causer and tenant come from the context', async () => {
    const activity = new Activity()

    const record = await asAcmeUser(() =>
      activity
        .in('project')
        .performedOn('project', 'p1')
        .withProperties({ from: 'draft', to: 'published' })
        .log('published'),
    )

    expect(record).toMatchObject({
      log: 'project',
      description: 'published',
      subjectType: 'project',
      subjectId: 'p1',
      causerId: 'u1',
      tenantId: 'acme',
      properties: { from: 'draft', to: 'published' },
    })
  })

  it('causedBy overrides the context user; records are frozen', async () => {
    const activity = new Activity()
    const record = await asAcmeUser(() =>
      activity.performedOn('invoice', 'i1').causedBy('system').log('generated'),
    )
    expect(record.causerId).toBe('system')
    expect(record.log).toBe('default')
    expect(Object.isFrozen(record)).toBe(true)
  })

  it('feeds: for(subject), inLog and byCauser, newest first with limit', async () => {
    const activity = new Activity({ tenantScoped: false })
    await activity.performedOn('project', 'p1').causedBy('u1').log('created')
    await activity.performedOn('project', 'p1').causedBy('u2').log('renamed')
    await activity.performedOn('project', 'p2').causedBy('u1').log('created')
    await activity.in('billing').causedBy('u1').log('invoice paid')

    const feed = await activity.for('project', 'p1')
    expect(feed.map((record) => record.description)).toEqual(['renamed', 'created'])

    expect(await activity.inLog('billing')).toHaveLength(1)
    expect(await activity.byCauser('u1', 2)).toHaveLength(2)
  })

  it('queries auto-scope to the current tenant by default', async () => {
    const activity = new Activity()
    await runWithContext({ tenant: { id: 'acme' } }, () =>
      activity.performedOn('project', 'p1').log('acme thing'),
    )
    await runWithContext({ tenant: { id: 'globex' } }, () =>
      activity.performedOn('project', 'p1').log('globex thing'),
    )

    const acmeFeed = await runWithContext({ tenant: { id: 'acme' } }, () =>
      activity.for('project', 'p1'),
    )
    expect(acmeFeed.map((record) => record.description)).toEqual(['acme thing'])

    // outside a tenant, everything is visible (central/admin context)
    expect(await activity.for('project', 'p1')).toHaveLength(2)
  })

  it('activityPlugin registers the token', async () => {
    const app = await createApp({ plugins: [activityPlugin()] }).boot()
    const activity = app.container.get(ACTIVITY)
    await activity.in('test').log('works')
    expect(await activity.inLog('test')).toHaveLength(1)
    await app.shutdown()
  })
})
