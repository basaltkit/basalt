import type { WebhookStore } from '../stores.js'

/** Minimal ioredis-compatible surface for webhook dedupe. */
export interface RedisWebhookClient {
  set(
    key: string,
    value: string,
    ex: 'EX',
    seconds: number,
    nx: 'NX',
  ): Promise<'OK' | null>
  del(key: string): Promise<number>
}

export interface RedisWebhookStoreOptions {
  /** Key prefix. Default: 'mach:webhook'. */
  prefix?: string
  /**
   * How long a processed id stays deduplicated, in seconds. Cover the
   * gateway's retry window with margin. Default: 7 days.
   */
  ttlSeconds?: number
}

/**
 * Durable webhook dedupe via Redis `SET key value NX EX` — the atomic claim
 * returns 'OK' only for the first caller, so idempotency holds across process
 * restarts and multiple instances.
 */
export class RedisWebhookStore implements WebhookStore {
  private readonly prefix: string
  private readonly ttlSeconds: number

  constructor(
    private readonly redis: RedisWebhookClient,
    options: RedisWebhookStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'mach:webhook'
    this.ttlSeconds = options.ttlSeconds ?? 7 * 24 * 60 * 60
  }

  private key(id: string): string {
    return `${this.prefix}:${id}`
  }

  async markProcessed(id: string): Promise<boolean> {
    const result = await this.redis.set(this.key(id), '1', 'EX', this.ttlSeconds, 'NX')
    return result === 'OK'
  }

  async release(id: string): Promise<void> {
    await this.redis.del(this.key(id))
  }
}
