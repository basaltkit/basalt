import type {
  AddJobOptions,
  DriverCapabilities,
  JobExecutor,
  QueueDriver,
} from '@basaltkit/queue'
import { queuePlugin, splitQueuePluginOptions, type QueuePluginOptions } from '@basaltkit/queue'

/** The subset of an amqplib channel this driver uses. */
export interface AmqpChannel {
  /**
   * amqplib channels are EventEmitters; optional so test fakes stay tiny.
   * `'close'` is what drives reconnection — without it a lost channel is
   * permanent.
   */
  on?(event: 'error' | 'close', listener: (error?: unknown) => void): void
  assertQueue(queue: string, options?: Record<string, unknown>): Promise<unknown>
  sendToQueue(queue: string, content: Uint8Array, options?: Record<string, unknown>): boolean
  consume(
    queue: string,
    onMessage: (msg: AmqpMessage | null) => void,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  ack(message: AmqpMessage): void
  prefetch(count: number): Promise<unknown> | void
  /**
   * Confirm channels only (amqplib `createConfirmChannel`): resolves when the
   * broker has confirmed every outstanding publish. The driver awaits this
   * before acking, closing the publish-lost/ack-done job-loss window.
   */
  waitForConfirms?(): Promise<void>
  close(): Promise<void>
}

export interface AmqpMessage {
  content: Uint8Array
  properties: { headers?: Record<string, unknown>; priority?: number }
}

export interface AmqpConnection {
  /** amqplib connections are EventEmitters; optional so test fakes stay tiny. */
  on?(event: 'error' | 'close', listener: (error?: unknown) => void): void
  createChannel(): Promise<AmqpChannel>
  /** Preferred when present: publisher-confirm channel (amqplib supports it). */
  createConfirmChannel?(): Promise<AmqpChannel>
  close(): Promise<void>
}

/** Opens a connection. Defaults to amqplib; injectable for tests. */
export type AmqpConnect = (url: string) => Promise<AmqpConnection>

const HEADER = {
  job: 'x-basalt-job',
  attempt: 'x-basalt-attempt',
  attempts: 'x-basalt-attempts',
  backoffMs: 'x-basalt-backoff-ms',
  backoffType: 'x-basalt-backoff-type',
} as const

/** Hard ceilings on retries and backoff so a crafted message can't demand unbounded ones. */
const MAX_ATTEMPTS = 50
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * The attempt number a message carries, as an integer in `[1, MAX_ATTEMPTS]`.
 * The header is untrusted: a negative or fractional value used to satisfy
 * `attempt < attempts` for a million rounds, bypassing the retry ceiling.
 */
function readAttempt(raw: unknown): number {
  const value = Number(raw ?? 1)
  if (!Number.isFinite(value) || value < 1) return 1
  return Math.min(Math.trunc(value), MAX_ATTEMPTS)
}

const defaultConnect: AmqpConnect = async (url) => {
  // Bare-specifier dynamic import kept opaque to the bundler/type-checker so
  // `amqplib` stays an optional peer dependency, resolved at runtime.
  const specifier = 'amqplib'
  const amqp = (await import(specifier)) as { connect(url: string): Promise<AmqpConnection> }
  return amqp.connect(url)
}

export interface RabbitmqDriverOptions {
  /** AMQP URL, e.g. amqp://user:pass@host:5672. */
  url: string
  /**
   * Infra errors from the amqplib connection/channel emitters (broker gone,
   * channel torn down). amqplib surfaces these as EventEmitter 'error' events
   * — unhandled, they CRASH the process. Default: console.error with context.
   */
  onError?: (error: unknown, info: { source: 'connection' | 'channel' }) => void
  /** Max priority level for priority queues (`x-max-priority`). Default 10. */
  maxPriority?: number
  /**
   * On `close()`, how long to wait for in-flight job handlers to finish before
   * tearing the channel down anyway. Default 10_000 ms. Unfinished jobs stay
   * unacked, so the broker redelivers them.
   */
  drainTimeoutMs?: number
  /**
   * After the connection or channel closes unexpectedly (broker restart,
   * network cut, a channel-level protocol error), how long to wait before
   * reconnecting — doubled on each consecutive failure, capped at 30s. The
   * next `add()` reconnects on demand; workers are re-subscribed by the
   * reconnect loop. Default 1000 ms.
   */
  reconnectDelayMs?: number
  /** Injectable connector — defaults to amqplib. Tests pass a fake. */
  connect?: AmqpConnect
}

const MAX_RECONNECT_DELAY_MS = 30_000

/**
 * RabbitMQ queue driver for `@basaltkit/queue`. Retries and backoff use a
 * per-queue delay queue (`<queue>.delay`) that dead-letters back to the main
 * queue via message TTL; exhausted jobs land in `<queue>.dead`. Priority uses
 * `x-max-priority`.
 *
 * Caveat: the delay queue relies on per-message TTL, which only releases a
 * message once it reaches the queue head (head-of-line blocking). For mixed
 * delays at scale, prefer the RabbitMQ delayed-message-exchange plugin.
 */
export class RabbitmqQueueDriver implements QueueDriver {
  readonly name = 'rabbitmq'
  readonly capabilities: DriverCapabilities = {
    delayed: true,
    priority: true,
    retries: true,
    backoff: true,
  }

  private executor: JobExecutor | undefined
  private channelPromise: Promise<AmqpChannel> | undefined
  private connection: AmqpConnection | undefined
  private readonly asserted = new Set<string>()
  private readonly maxPriority: number
  private readonly connect: AmqpConnect
  private readonly onError: (error: unknown, info: { source: 'connection' | 'channel' }) => void
  private readonly drainTimeoutMs: number
  /** In-flight message handlers — close() drains these before tearing down. */
  private readonly inflight = new Set<Promise<void>>()
  private closing = false
  /** Workers started on this driver — re-subscribed after a reconnect. */
  private readonly workers = new Map<string, { concurrency?: number }>()
  private readonly reconnectDelayMs: number
  private reconnectTimer: NodeJS.Timeout | undefined
  private reconnectAttempt = 0

  constructor(private readonly options: RabbitmqDriverOptions) {
    this.maxPriority = options.maxPriority ?? 10
    this.connect = options.connect ?? defaultConnect
    this.drainTimeoutMs = options.drainTimeoutMs ?? 10_000
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000
    this.onError =
      options.onError ??
      ((error: unknown, info: { source: 'connection' | 'channel' }) =>
        console.error(`[basalt:queue] rabbitmq ${info.source} error:`, error))
  }

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    const channel = await this.channel()
    await this.ensureTopology(channel, queue)

    const headers: Record<string, unknown> = {
      [HEADER.job]: jobName,
      [HEADER.attempt]: 1,
      [HEADER.attempts]: options.attempts,
      ...(options.backoff
        ? { [HEADER.backoffMs]: options.backoff.delayMs, [HEADER.backoffType]: options.backoff.type }
        : {}),
    }
    const content = encode(data)
    const publish: Record<string, unknown> = {
      persistent: true,
      headers,
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
    }

    if (options.delayMs !== undefined && options.delayMs > 0) {
      channel.sendToQueue(this.delayQueue(queue), content, { ...publish, expiration: String(options.delayMs) })
    } else {
      channel.sendToQueue(queue, content, publish)
    }
    // On a confirm channel, only report the job as dispatched once the broker
    // has taken responsibility for the message.
    await channel.waitForConfirms?.()
  }

  startWorker(queue: string, options: { concurrency?: number } = {}): void {
    this.workers.set(queue, options)
    this.consume(queue, options).catch((error) => {
      // A broker-connect/consume failure at boot must be visible — otherwise the
      // app reports healthy with zero workers (and the rejection would be fatal).
      this.onError(error, { source: 'connection' })
      this.scheduleReconnect()
    })
  }

  private async consume(queue: string, options: { concurrency?: number }): Promise<void> {
    const channel = await this.channel()
    await this.ensureTopology(channel, queue)
    await channel.prefetch(options.concurrency ?? 1)
    await channel.consume(queue, (message) => {
      if (!message) return
      // handle() never rejects; track it so close() can drain in-flight work.
      const pending = this.handle(channel, queue, message).finally(() => this.inflight.delete(pending))
      this.inflight.add(pending)
    })
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    // Drain: let in-flight handlers finish (bounded), so their acks land on a
    // live channel. Anything unfinished stays unacked and gets redelivered.
    if (this.inflight.size > 0) {
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.drainTimeoutMs)
        timer.unref?.()
      })
      await Promise.race([Promise.allSettled([...this.inflight]).then(() => undefined), deadline])
      if (timer) clearTimeout(timer)
    }
    const channel = await this.channelPromise?.catch(() => undefined)
    await channel?.close()
    await this.connection?.close()
  }

  // --- internals -----------------------------------------------------------

  private async handle(channel: AmqpChannel, queue: string, message: AmqpMessage): Promise<void> {
    // Shutting down: don't start new work and don't ack — the broker holds the
    // durable copy and redelivers it once this consumer goes away.
    if (this.closing) return
    const headers = message.properties.headers ?? {}
    const jobName = String(headers[HEADER.job] ?? '')
    let failed = false
    try {
      await this.executor?.(jobName, decode(message.content))
    } catch {
      failed = true
    }
    try {
      if (failed) {
        const attempt = readAttempt(headers[HEADER.attempt])
        // Clamp the max-attempts read from the (untrusted) message to a hard
        // ceiling so a crafted `attempts` can't drive a retry-amplification loop.
        const attempts = Math.min(Number(headers[HEADER.attempts] ?? 1) || 1, MAX_ATTEMPTS)
        if (attempt < attempts) {
          // Re-enqueue via the delay queue with the next attempt and a backoff TTL.
          channel.sendToQueue(this.delayQueue(queue), message.content, {
            persistent: true,
            headers: { ...headers, [HEADER.attempt]: attempt + 1 },
            expiration: String(this.backoffDelay(headers, attempt)),
          })
        } else {
          channel.sendToQueue(this.deadQueue(queue), message.content, { persistent: true, headers })
        }
        // On a confirm channel, wait until the broker owns the re-routed copy —
        // acking before the publish is confirmed is a silent job-loss window.
        await channel.waitForConfirms?.()
      }
      channel.ack(message)
    } catch (error) {
      // Publish unconfirmed or ack failed: the durable copy is still on the
      // broker (nothing was acked), so redelivery keeps the job — surface the
      // fault instead of throwing into the consume callback (fatal).
      this.onError(error, { source: 'channel' })
    }
  }

  private backoffDelay(headers: Record<string, unknown>, attempt: number): number {
    // A negative/NaN base became `expiration: "-5"`, which the broker answers
    // with a channel-closing PRECONDITION_FAILED.
    const raw = Number(headers[HEADER.backoffMs] ?? 0)
    const base = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), MAX_BACKOFF_MS) : 0
    if (!base) return 0
    if (headers[HEADER.backoffType] !== 'exponential') return base
    // Clamp the exponent (attempt comes from the message) so the TTL can't blow
    // up to Infinity / an absurd expiration string handed to the broker.
    return Math.min(base * 2 ** Math.min(Math.max(attempt - 1, 0), 16), MAX_BACKOFF_MS)
  }

  private async ensureTopology(channel: AmqpChannel, queue: string): Promise<void> {
    if (this.asserted.has(queue)) return
    await channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-max-priority': this.maxPriority },
    })
    // Delay/retry buffer: messages expire after their TTL and dead-letter back
    // to the main queue (default exchange, routing key = queue name).
    await channel.assertQueue(this.delayQueue(queue), {
      durable: true,
      arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue },
    })
    await channel.assertQueue(this.deadQueue(queue), { durable: true })
    this.asserted.add(queue)
  }

  private async channel(): Promise<AmqpChannel> {
    if (!this.channelPromise) {
      const opening = (async () => {
        const connection = await this.connect(this.options.url)
        this.connection = connection
        // Unlistened EventEmitter 'error' events are fatal in Node (Q-2).
        connection.on?.('error', (error) => this.onError(error, { source: 'connection' }))
        connection.on?.('close', () => this.lost(opening))
        // Prefer a publisher-confirm channel: sendToQueue can then be awaited
        // via waitForConfirms, so ack only happens after the broker took over.
        const channel = await (connection.createConfirmChannel?.() ?? connection.createChannel())
        channel.on?.('error', (error) => this.onError(error, { source: 'channel' }))
        channel.on?.('close', () => this.lost(opening))
        return channel
      })()
      // A failed open must not be cached: the next call retries it.
      opening.catch(() => {
        if (this.channelPromise === opening) this.channelPromise = undefined
      })
      this.channelPromise = opening
    }
    return this.channelPromise
  }

  /**
   * The channel (or its connection) closed. Unless we are shutting down, drop
   * the cached channel and topology so the next `add()` reopens them, and
   * schedule a reconnect that re-subscribes every worker. Unacked messages of
   * the dead channel are redelivered by the broker.
   */
  private lost(opening: Promise<AmqpChannel>): void {
    if (this.closing || this.channelPromise !== opening) return // stale or deliberate
    this.channelPromise = undefined
    this.connection = undefined
    this.asserted.clear()
    this.onError(new Error('RabbitMQ channel closed — reconnecting'), { source: 'channel' })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer || this.workers.size === 0) return
    const delay = Math.min(this.reconnectDelayMs * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.resubscribe()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private async resubscribe(): Promise<void> {
    if (this.closing) return
    try {
      for (const [queue, options] of this.workers) await this.consume(queue, options)
      this.reconnectAttempt = 0
    } catch (error) {
      this.onError(error, { source: 'connection' })
      this.scheduleReconnect()
    }
  }

  private delayQueue(queue: string): string {
    return `${queue}.delay`
  }
  private deadQueue(queue: string): string {
    return `${queue}.dead`
  }
}

const encode = (data: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(data))
const decode = (content: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(content))

/**
 * Everything {@link queuePlugin} accepts, minus `driver` (this plugin IS the
 * driver choice), plus every RabbitMQ driver option.
 */
export interface RabbitmqQueuePluginOptions
  extends Omit<QueuePluginOptions, 'driver'>,
    RabbitmqDriverOptions {}

/**
 * The RabbitMQ-backed queue plugin — one line to put an app's jobs on RabbitMQ:
 *
 * ```ts
 * rabbitmqQueuePlugin({ url: process.env.AMQP_URL!, jobs: [SendWelcome], workers: [{ queue: 'welcome' }] })
 * ```
 *
 * Every backend ships a plugin of this shape (`bullmqQueuePlugin`, `sqsQueuePlugin`, `kafkaQueuePlugin`), so no backend is
 * privileged in the core's API and `@basaltkit/queue` stays a pure contract.
 * Use `queuePlugin({ driver })` directly for a driver you wrote yourself.
 *
 * Building the driver here, when the app is DEFINED, is safe: the constructor
 * only reads defaults, and every connection is opened lazily on first use.
 */
export function rabbitmqQueuePlugin(options: RabbitmqQueuePluginOptions) {
  // Split by the CORE's key list: a new core option (e.g. `signingKey`) reaches
  // queuePlugin, and every other key flows to the driver untouched.
  const { core, driver } = splitQueuePluginOptions(options)
  return queuePlugin({ ...core, driver: new RabbitmqQueueDriver(driver) })
}
