import { describe, expect, it, vi } from 'vitest'
import { createApp, definePlugin, runWithContext, type HookBus } from '@basaltkit/core'
import { ACTIVITY, activityPlugin, activityRule } from '../src/index.js'

/**
 * B16 · the declarative rule the other two packages already had.
 *
 * `@basaltkit/search` has `syncRule({ hook, index, document })` and
 * `@basaltkit/realtime` has `bridgeRule({ hook, channel, event, data })`. Same
 * shape, and a good one: **the domain emits, the package listens, and neither
 * knows the other**. `activity` — the same use case, and probably the most
 * common of the three — had only the fluent builder, which is for writing a
 * line by hand inside a service.
 *
 * The asymmetry has a cost beyond thirteen `hooks.on(...)` calls: the natural
 * answer to "record this" becomes "call activity from MatterService", which
 * couples the domain to the package the other two teach you to keep at arm's
 * length.
 */

declare module '@basaltkit/core' {
  interface BasaltHooks {
    'matter:opened': { matter: { id: string; number: string }; by: string }
    'matter:closed': { matter: { id: string } }
  }
}

const emitter = (fn: (hooks: HookBus) => Promise<void>) =>
  definePlugin({
    name: 'test:emitter',
    async boot({ hooks }) {
      await fn(hooks)
    },
  })

describe('F-33 · activityRule', () => {
  it('writes a feed line from a domain event, with no service knowing about it', async () => {
    const app = await createApp({
      plugins: [
        activityPlugin({
          rules: [
            activityRule({
              hook: 'matter:opened',
              log: 'matters',
              subject: ({ matter }) => ({ type: 'matter', id: matter.id }),
              description: ({ matter }) => `opened matter ${matter.number}`,
              causer: ({ by }) => by,
            }),
          ],
        }),
        emitter(async (hooks) => {
          await hooks.emit('matter:opened', { matter: { id: 'm1', number: '2026/014' }, by: 'u1' })
        }),
      ],
    }).boot()

    const [line] = await app.container.get(ACTIVITY).query({})
    expect(line?.description).toBe('opened matter 2026/014')
    expect(line?.log).toBe('matters')
    expect(line?.subjectType).toBe('matter')
    expect(line?.subjectId).toBe('m1')
    expect(line?.causerId).toBe('u1')
    await app.shutdown()
  })

  it('skips the line when the description returns null', async () => {
    const app = await createApp({
      plugins: [
        activityPlugin({
          rules: [activityRule({ hook: 'matter:closed', description: () => null })],
        }),
        emitter(async (hooks) => {
          await hooks.emit('matter:closed', { matter: { id: 'm1' } })
        }),
      ],
    }).boot()

    expect(await app.container.get(ACTIVITY).query({})).toEqual([])
    await app.shutdown()
  })

  it('does not bring down the operation that emitted the event', async () => {
    // The difference from `syncRule`, and the reason this is not a copy of it.
    // `HookBus` rethrows to the emitter, which is right for an audit trail and
    // wrong for a readable feed: a history line that cannot be written must not
    // fail the case closure that produced it.
    const onRuleError = vi.fn()
    const app = await createApp({
      plugins: [
        activityPlugin({
          onRuleError,
          rules: [
            activityRule({
              hook: 'matter:closed',
              description: () => {
                throw new Error('the feed is on fire')
              },
            }),
          ],
        }),
      ],
    }).boot()

    const hooks = app.hooks
    await expect(hooks.emit('matter:closed', { matter: { id: 'm1' } })).resolves.not.toThrow()
    expect(onRuleError).toHaveBeenCalledTimes(1)
    expect((onRuleError.mock.calls[0]?.[0] as Error).message).toBe('the feed is on fire')
    await app.shutdown()
  })

  it('records the tenant of the emitting context', async () => {
    const app = await createApp({
      plugins: [
        activityPlugin({
          tenantScoped: false,
          rules: [activityRule({ hook: 'matter:closed', description: () => 'closed' })],
        }),
      ],
    }).boot()

    await runWithContext({ tenant: { id: 'acme' } }, () =>
      app.hooks.emit('matter:closed', { matter: { id: 'm1' } }),
    )

    const [line] = await app.container.get(ACTIVITY).query({})
    // The line is written inside the emitter's context, so it belongs to the
    // firm whose action produced it — not to whoever reads the feed later.
    expect(line?.tenantId).toBe('acme')
    await app.shutdown()
  })

  it('carries properties when the rule supplies them', async () => {
    const app = await createApp({
      plugins: [
        activityPlugin({
          rules: [
            activityRule({
              hook: 'matter:closed',
              description: () => 'closed',
              properties: ({ matter }) => ({ matterId: matter.id }),
            }),
          ],
        }),
      ],
    }).boot()

    await app.hooks.emit('matter:closed', { matter: { id: 'm1' } })
    const [line] = await app.container.get(ACTIVITY).query({})
    expect(line?.properties).toEqual({ matterId: 'm1' })
    await app.shutdown()
  })
})
