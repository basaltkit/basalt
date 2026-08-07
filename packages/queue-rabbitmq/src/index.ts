import type {
  AddJobOptions,
  DriverCapabilities,
  JobExecutor,
  QueueDriver,
} from '@machize/queue'

/** The subset of an amqplib channel this driver uses. */
export interface AmqpChannel {
  assertQueue(queue: string, options?: Record<string, unknown>): Promise<unknown>
  sendToQueue(queue: string, content: Uint8Array, options?: Record<string, unknown>): boolean
  consume(
    queue: string,
    onMessage: (msg: AmqpMessage | null) => void,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  ack(message: AmqpMessage): void
  prefetch(count: number): Promise<unknown> | void
  close(): Promise<void>
}

export interface AmqpMessage {
  content: Uint8Array
  properties: { headers?: Record<string, unknown>; priority?: number }
}

export interface AmqpConnection {
  createChannel(): Promise<AmqpChannel>
  close(): Promise<void>
}

/** Opens a connection. Defaults to amqplib; injectable for tests. */
export type AmqpConnect = (url: string) => Promise<AmqpConnection>

const HEADER = {
  job: 'x-machize-job',
  attempt: 'x-machize-attempt',
  attempts: 'x-machize-attempts',
  backoffMs: 'x-machize-backoff-ms',
  backoffType: 'x-machize-backoff-type',
} as const

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
  /** Max priority level for priority queues (`x-max-priority`). Default 10. */
  maxPriority?: number
  /** Injectable connector — defaults to amqplib. Tests pass a fake. */
  connect?: AmqpConnect
}

/**
 * RabbitMQ queue driver for `@machize/queue`. Retries and backoff use a
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

  constructor(private readonly options: RabbitmqDriverOptions) {
    this.maxPriority = options.maxPriority ?? 10
    this.connect = options.connect ?? defaultConnect
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
  }

  startWorker(queue: string, options: { concurrency?: number } = {}): void {
    void (async () => {
      const channel = await this.channel()
      await this.ensureTopology(channel, queue)
      await channel.prefetch(options.concurrency ?? 1)
      await channel.consume(queue, (message) => {
        if (message) void this.handle(channel, queue, message)
      })
    })()
  }

  async close(): Promise<void> {
    const channel = await this.channelPromise?.catch(() => undefined)
    await channel?.close()
    await this.connection?.close()
  }

  // --- internals -----------------------------------------------------------

  private async handle(channel: AmqpChannel, queue: string, message: AmqpMessage): Promise<void> {
    const headers = message.properties.headers ?? {}
    const jobName = String(headers[HEADER.job] ?? '')
    try {
      await this.executor?.(jobName, decode(message.content))
      channel.ack(message)
    } catch {
      const attempt = Number(headers[HEADER.attempt] ?? 1)
      const attempts = Number(headers[HEADER.attempts] ?? 1)
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
      // Either way the message has been re-routed, so remove it from the queue.
      channel.ack(message)
    }
  }

  private backoffDelay(headers: Record<string, unknown>, attempt: number): number {
    const base = Number(headers[HEADER.backoffMs] ?? 0)
    if (!base) return 0
    return headers[HEADER.backoffType] === 'exponential' ? base * 2 ** (attempt - 1) : base
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
      this.channelPromise = (async () => {
        this.connection = await this.connect(this.options.url)
        return this.connection.createChannel()
      })()
    }
    return this.channelPromise
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
