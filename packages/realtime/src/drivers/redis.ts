import type { BackplaneMessage, RealtimeBackplane } from '../hub.js'

/**
 * The Redis pub/sub surface this backplane needs. `ioredis` satisfies it. A
 * subscriber connection is in subscribe mode and can't publish, so provide two
 * clients (or two duplicates of one).
 */
export interface RedisRealtimeClient {
  publish(channel: string, message: string): Promise<unknown> | unknown
  subscribe(channel: string): Promise<unknown> | unknown
  on(event: 'message', listener: (channel: string, message: string) => void): void
}

export interface RedisBackplaneOptions {
  publisher: RedisRealtimeClient
  subscriber: RedisRealtimeClient
  /** Redis pub/sub channel the instances share. Default 'basalt:realtime'. */
  channel?: string
}

/**
 * Redis pub/sub backplane for multi-instance realtime. Every emit is PUBLISHed
 * and delivered to every instance's SUBSCRIBE (including the origin), so the
 * hub's local delivery path handles one node or many identically.
 */
export class RedisBackplane implements RealtimeBackplane {
  private readonly channel: string
  constructor(private readonly options: RedisBackplaneOptions) {
    this.channel = options.channel ?? 'basalt:realtime'
  }

  async publish(message: BackplaneMessage): Promise<void> {
    await this.options.publisher.publish(this.channel, JSON.stringify(message))
  }

  async subscribe(handler: (message: BackplaneMessage) => void): Promise<void> {
    this.options.subscriber.on('message', (channel, raw) => {
      if (channel !== this.channel) return
      // Never throw into ioredis's 'message' emitter — an escaped exception
      // there is an uncaughtException (fatal). Malformed or wrong-shaped
      // payloads are dropped and logged (Q-3).
      try {
        const message = JSON.parse(raw) as Partial<BackplaneMessage>
        if (
          typeof message?.tenantId !== 'string' ||
          typeof message.channel !== 'string' ||
          typeof message.event !== 'string'
        ) {
          console.error('[basalt:realtime] dropping malformed backplane message (missing tenantId/channel/event)')
          return
        }
        handler(message as BackplaneMessage)
      } catch (error) {
        console.error('[basalt:realtime] dropping unparseable backplane message:', error)
      }
    })
    await this.options.subscriber.subscribe(this.channel)
  }
}
