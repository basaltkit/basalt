import { createHmac, timingSafeEqual } from 'node:crypto'
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
  /**
   * Redis pub/sub channel the instances share. Default 'basalt:realtime'.
   * Every app and environment on the same Redis that keeps the default shares
   * one channel — and therefore each other's tenant ids. Give each deployment
   * its own (e.g. `'myapp:prod:realtime'`).
   */
  channel?: string
  /**
   * HMAC-SHA256 key(s) for signing backplane messages. When set, every message
   * is published as a signed envelope and anything arriving unsigned, tampered
   * or signed with another key is dropped — so a client that can merely
   * `PUBLISH` on the Redis cannot push forged events to your tenants.
   *
   * Pass an array to rotate: the FIRST key signs, ALL keys verify. Every
   * instance must share the key(s); a node without one drops signed messages
   * as malformed (and vice versa). Default: unsigned plain JSON.
   */
  secret?: string | readonly string[]
}

/** The signed wire format: the exact JSON that was signed, plus its MAC. */
interface SignedEnvelope {
  payload: string
  sig: string
}

/**
 * Redis pub/sub backplane for multi-instance realtime. Every emit is PUBLISHed
 * and delivered to every instance's SUBSCRIBE (including the origin), so the
 * hub's local delivery path handles one node or many identically.
 */
export class RedisBackplane implements RealtimeBackplane {
  private readonly channel: string
  private readonly secrets: readonly string[] | undefined
  constructor(private readonly options: RedisBackplaneOptions) {
    this.channel = options.channel ?? 'basalt:realtime'
    if (options.secret !== undefined) {
      const secrets = typeof options.secret === 'string' ? [options.secret] : [...options.secret]
      if (secrets.length === 0 || secrets.some((s) => typeof s !== 'string' || s.length === 0)) {
        throw new TypeError('RedisBackplane: `secret` must be a non-empty string or a non-empty array of them')
      }
      this.secrets = secrets
    }
  }

  async publish(message: BackplaneMessage): Promise<void> {
    const payload = JSON.stringify(message)
    const wire = this.secrets
      ? JSON.stringify({ payload, sig: sign(this.secrets[0]!, payload) } satisfies SignedEnvelope)
      : payload
    await this.options.publisher.publish(this.channel, wire)
  }

  /** Unwraps and verifies a signed envelope; `undefined` means "drop it". */
  private verified(raw: string): string | undefined {
    const envelope = JSON.parse(raw) as Partial<SignedEnvelope> | null
    if (typeof envelope?.payload !== 'string' || typeof envelope.sig !== 'string') return undefined
    const given = Buffer.from(envelope.sig)
    for (const secret of this.secrets!) {
      const expected = Buffer.from(sign(secret, envelope.payload))
      if (expected.length === given.length && timingSafeEqual(expected, given)) return envelope.payload
    }
    return undefined
  }

  async subscribe(handler: (message: BackplaneMessage) => void): Promise<void> {
    this.options.subscriber.on('message', (channel, raw) => {
      if (channel !== this.channel) return
      // Never throw into ioredis's 'message' emitter — an escaped exception
      // there is an uncaughtException (fatal). Malformed or wrong-shaped
      // payloads are dropped and logged (Q-3).
      try {
        let payload = raw
        if (this.secrets) {
          const verified = this.verified(raw)
          if (verified === undefined) {
            console.error('[basalt:realtime] dropping backplane message with a missing or invalid signature')
            return
          }
          payload = verified
        }
        const message = JSON.parse(payload) as Partial<BackplaneMessage> | null
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

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url')
