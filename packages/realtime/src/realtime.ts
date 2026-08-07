import type { RealtimeHub } from './hub.js'

/** A channel bound to a tenant — the fluent target of an emit. */
export interface ChannelTarget {
  emit(event: string, data?: unknown): Promise<void>
  presence(): string[]
  count(): number
}

/**
 * Ergonomic facade over the hub:
 *
 *   realtime.to('acme').channel('notes').emit('created', note)
 *   realtime.to('acme').channel('notes').presence()   // → user ids online
 */
export class Realtime {
  constructor(private readonly hub: RealtimeHub) {}

  to(tenantId: string): { channel(name: string): ChannelTarget } {
    return {
      channel: (name: string): ChannelTarget => ({
        emit: (event, data) => this.hub.publish(tenantId, name, event, data),
        presence: () => this.hub.presence(tenantId, name),
        count: () => this.hub.count(tenantId, name),
      }),
    }
  }
}
