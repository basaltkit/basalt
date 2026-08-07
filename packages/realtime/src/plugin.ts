import { createToken, definePlugin } from '@machize/core'
import type { MachizeHooks } from '@machize/core'
import { MemoryBackplane, RealtimeHub, type RealtimeBackplane } from './hub.js'
import { Realtime } from './realtime.js'

export const REALTIME = createToken<Realtime>('realtime')
export const REALTIME_HUB = createToken<RealtimeHub>('realtime:hub')

/**
 * Pushes a hook's payload to a realtime channel. Wire domain events straight to
 * connected clients without touching the emitting code:
 *
 *   bridge: [{
 *     hook: 'note:created',
 *     tenant: (p) => p.tenantId,
 *     channel: 'notes',
 *     event: 'created',
 *     data: (p) => p.note,
 *   }]
 */
export interface BridgeRule<K extends keyof MachizeHooks & string = keyof MachizeHooks & string> {
  hook: K
  /** Tenant to deliver to; return undefined to skip this event. */
  tenant: (payload: MachizeHooks[K]) => string | undefined
  channel: string | ((payload: MachizeHooks[K]) => string)
  event: string
  /** What to send. Default: the whole hook payload. */
  data?: (payload: MachizeHooks[K]) => unknown
}

/**
 * Type-checks one bridge rule against its hook's payload, then erases the
 * generic so rules for different hooks live in the same array.
 */
export function bridgeRule<K extends keyof MachizeHooks & string>(rule: BridgeRule<K>): BridgeRule {
  return rule as unknown as BridgeRule
}

export interface RealtimePluginOptions {
  /** Fan-out backplane. Default in-memory (single instance). */
  backplane?: RealtimeBackplane
  /** Rules mapping domain hooks to realtime pushes. */
  bridge?: BridgeRule[]
}

export function realtimePlugin(options: RealtimePluginOptions = {}) {
  return definePlugin({
    name: 'machize:realtime',
    register({ container }) {
      const hub = new RealtimeHub(options.backplane ?? new MemoryBackplane())
      container.singleton(REALTIME_HUB, () => hub)
      container.singleton(REALTIME, () => new Realtime(hub))
    },
    async boot({ container, hooks }) {
      const hub = container.get(REALTIME_HUB)
      await hub.start()
      const realtime = container.get(REALTIME)

      for (const rule of options.bridge ?? []) {
        hooks.on(rule.hook, (payload) => {
          const tenantId = rule.tenant(payload)
          if (tenantId === undefined) return
          const channel = typeof rule.channel === 'function' ? rule.channel(payload) : rule.channel
          return realtime.to(tenantId).channel(channel).emit(rule.event, rule.data ? rule.data(payload) : payload)
        })
      }
    },
    async shutdown({ container }) {
      await container.get(REALTIME_HUB).close()
    },
  })
}
