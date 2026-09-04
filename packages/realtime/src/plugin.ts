import { createToken, definePlugin } from '@basaltkit/core'
import type { BasaltHooks, Container } from '@basaltkit/core'
import { MemoryBackplane, RealtimeHub, type Connection, type RealtimeBackplane } from './hub.js'
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
export interface BridgeRule<K extends keyof BasaltHooks & string = keyof BasaltHooks & string> {
  hook: K
  /** Tenant to deliver to; return undefined to skip this event. */
  tenant: (payload: BasaltHooks[K]) => string | undefined
  channel: string | ((payload: BasaltHooks[K]) => string)
  event: string
  /** What to send. Default: the whole hook payload. */
  data?: (payload: BasaltHooks[K]) => unknown
}

/**
 * Type-checks one bridge rule against its hook's payload, then erases the
 * generic so rules for different hooks live in the same array.
 */
export function bridgeRule<K extends keyof BasaltHooks & string>(rule: BridgeRule<K>): BridgeRule {
  return rule as unknown as BridgeRule
}

export interface RealtimePluginOptions {
  /** Fan-out backplane. Default in-memory (single instance). */
  backplane?: RealtimeBackplane
  /** Rules mapping domain hooks to realtime pushes. */
  bridge?: BridgeRule[]
  /**
   * Server-side subscription gate — return `false` to refuse a client joining a
   * channel. Set this whenever channels carry data not readable by every member
   * of the tenant (private/admin channels); without it any authenticated
   * connection can subscribe to any channel name in its tenant.
   */
  authorize?: (
    connection: Connection,
    channel: string,
    /**
     * The application's container.
     *
     * `authorize` runs outside any request — there is no `ctx()` when a client
     * opens a stream — and `Connection` carries `id`, `tenantId` and `userId`.
     * Not roles, not permissions, which is exactly what deciding "may this
     * connection hear this channel" needs.
     *
     * Without this, gates stashed the container in a module-level variable and
     * filled it from a companion plugin's `boot` — which is quietly wrong when
     * plugin order changes.
     *
     * A container rather than resolved roles: the gate does not always want
     * roles. It might want a subscription, a feature flag, a per-tenant
     * setting. Deciding that here would be deciding it for everyone.
     */
    context: { container: Container },
  ) => boolean | Promise<boolean>
  /** Max distinct channels per connection (DoS bound). Default 1000. */
  maxSubscriptionsPerConnection?: number
  /** Max channel-name length (DoS bound). Default 256. */
  maxChannelLength?: number
  /**
   * Called when a bridged broadcast fails (e.g. the backplane is down). The
   * bridge is fire-and-forget by design — a realtime push is cosmetic and must
   * never fail the domain write that emitted the hook — so failures land here
   * instead of propagating. Default: logs to console with the rule's context.
   */
  onBridgeError?: (error: unknown, info: { hook: string; channel: string; event: string }) => void
  /**
   * A local delivery failed (dead socket) — forwarded to the hub. The
   * connection is pruned and remaining recipients still receive the message.
   * Default: console.error with context.
   */
  onDeliveryError?: (
    error: unknown,
    info: { connectionId: string; tenantId: string; channel: string; event: string },
  ) => void
}

export function realtimePlugin(options: RealtimePluginOptions = {}) {
  return definePlugin({
    name: 'basalt:realtime',
    register({ container }) {
      const hub = new RealtimeHub(options.backplane ?? new MemoryBackplane(), {
        ...(options.onDeliveryError ? { onDeliveryError: options.onDeliveryError } : {}),
        // Bound here, where the container exists. Existing two-parameter gates
        // are unaffected — they simply ignore the extra argument.
        ...(options.authorize
          ? {
              authorize: (connection: Connection, channel: string) =>
                options.authorize!(connection, channel, { container }),
            }
          : {}),
        ...(options.maxSubscriptionsPerConnection !== undefined
          ? { maxSubscriptionsPerConnection: options.maxSubscriptionsPerConnection }
          : {}),
        ...(options.maxChannelLength !== undefined ? { maxChannelLength: options.maxChannelLength } : {}),
      })
      container.singleton(REALTIME_HUB, () => hub)
      container.singleton(REALTIME, () => new Realtime(hub))
    },
    async boot({ container, hooks }) {
      const hub = container.get(REALTIME_HUB)
      await hub.start()
      const realtime = container.get(REALTIME)

      const onBridgeError =
        options.onBridgeError ??
        ((error: unknown, info: { hook: string; channel: string; event: string }) =>
          console.error(
            `[basalt:realtime] bridge broadcast failed (hook "${info.hook}" -> channel "${info.channel}", event "${info.event}"):`,
            error,
          ))
      for (const rule of options.bridge ?? []) {
        hooks.on(rule.hook, (payload) => {
          const tenantId = rule.tenant(payload)
          if (tenantId === undefined) return
          const channel = typeof rule.channel === 'function' ? rule.channel(payload) : rule.channel
          // Fire-and-forget: a realtime push is a cosmetic fan-out — it must
          // never fail (or slow down) the domain write that emitted the hook.
          // Failures stay observable via onBridgeError. (Review 2026-08-b, Q-1.)
          void Promise.resolve(
            realtime.to(tenantId).channel(channel).emit(rule.event, rule.data ? rule.data(payload) : payload),
          ).catch((error: unknown) => onBridgeError(error, { hook: rule.hook, channel, event: rule.event }))
        })
      }
    },
    async shutdown({ container }) {
      await container.get(REALTIME_HUB).close()
    },
  })
}
