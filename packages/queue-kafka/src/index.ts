import type {
  AddJobOptions,
  DriverCapabilities,
  JobExecutor,
  QueueDriver,
} from '@basaltkit/queue'
import { queuePlugin, type QueuePluginOptions } from '@basaltkit/queue'

/** The subset of a kafkajs client this driver uses. */
export interface KafkaClient {
  producer(): KafkaProducer
  consumer(config: { groupId: string }): KafkaConsumer
}

export interface KafkaProducer {
  connect(): Promise<void>
  send(record: {
    topic: string
    messages: { value: string; headers?: Record<string, string> }[]
  }): Promise<unknown>
  disconnect(): Promise<void>
}

export interface KafkaMessage {
  value: Uint8Array | string | null
  headers?: Record<string, Uint8Array | string | undefined>
}

export interface KafkaConsumer {
  connect(): Promise<void>
  subscribe(subscription: { topic: string; fromBeginning?: boolean }): Promise<void>
  run(config: {
    eachMessage: (payload: { topic: string; message: KafkaMessage }) => Promise<void>
    partitionsConsumedConcurrently?: number
  }): Promise<void>
  disconnect(): Promise<void>
}

const HEADER = {
  job: 'x-basalt-job',
  attempt: 'x-basalt-attempt',
  attempts: 'x-basalt-attempts',
} as const

/** Hard ceiling on retries, so a crafted message can't request unbounded ones. */
const MAX_ATTEMPTS = 50

export interface KafkaDriverOptions {
  brokers: string[]
  clientId?: string
  /** Consumer group used by workers. Default 'basalt-queue'. */
  groupId?: string
  /** Suffix for the retry topic. Default '.retry'. */
  retrySuffix?: string
  /** Suffix for the dead-letter topic. Default '.dead'. */
  deadSuffix?: string
  /** Injectable client — defaults to kafkajs. Tests pass a fake. */
  client?: KafkaClient
  /**
   * Called on infrastructure faults the driver cannot recover in line — a
   * worker's connect/subscribe/run failing at boot (otherwise the app reports
   * healthy with ZERO workers and the rejection is process-fatal), or a
   * retry/dead-letter re-publish failing inside the consume callback. Same
   * pattern as the rabbitmq/sqs drivers. Default: console.error with context.
   */
  onError?: (error: unknown, info: { source: 'consumer' | 'producer'; queue?: string }) => void
}

const defaultClient = async (options: KafkaDriverOptions): Promise<KafkaClient> => {
  // Opaque specifier keeps kafkajs an optional peer dependency (runtime-resolved).
  const specifier = 'kafkajs'
  const mod = (await import(specifier)) as {
    Kafka: new (config: { clientId: string; brokers: string[] }) => KafkaClient
  }
  return new mod.Kafka({ clientId: options.clientId ?? 'basalt', brokers: options.brokers })
}

/**
 * Kafka driver for `@basaltkit/queue`. Kafka is a log, not a task queue, so this
 * driver is deliberately honest about what it can't do:
 *
 * - `delayed` and `priority` are NOT supported (Kafka has neither). With the
 *   queue's `onUnsupported: 'throw'` policy a delayed/priority dispatch fails
 *   loudly; with the default 'warn' it logs and proceeds without them.
 * - `retries` are supported via a retry topic (`<topic>.retry`) the worker also
 *   consumes; exhausted jobs go to `<topic>.dead`. There is no backoff delay
 *   (Kafka can't defer a message), so `backoff` is not supported either.
 *
 * Worker concurrency is bounded by the topic's partition count, not the
 * `concurrency` number (passed through as `partitionsConsumedConcurrently`).
 */
export class KafkaQueueDriver implements QueueDriver {
  readonly name = 'kafka'
  readonly capabilities: DriverCapabilities = {
    delayed: false,
    priority: false,
    retries: true,
    backoff: false,
  }

  private executor: JobExecutor | undefined
  private clientPromise: Promise<KafkaClient> | undefined
  private producerPromise: Promise<KafkaProducer> | undefined
  private readonly consumers: KafkaConsumer[] = []
  private readonly groupId: string
  private readonly retrySuffix: string
  private readonly deadSuffix: string

  private readonly onError: (error: unknown, info: { source: 'consumer' | 'producer'; queue?: string }) => void

  constructor(private readonly options: KafkaDriverOptions) {
    this.groupId = options.groupId ?? 'basalt-queue'
    this.retrySuffix = options.retrySuffix ?? '.retry'
    this.deadSuffix = options.deadSuffix ?? '.dead'
    this.onError =
      options.onError ??
      ((error, info) =>
        console.error(
          `[basalt:queue] kafka ${info.source} error${info.queue ? ` (queue "${info.queue}")` : ''}:`,
          error,
        ))
  }

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    // delay/priority are unsupported (see capabilities); the QueueManager has
    // already applied its onUnsupported policy, so they are simply not encoded.
    void options
    const producer = await this.producer()
    await producer.send({
      topic: queue,
      messages: [
        {
          value: JSON.stringify(data),
          headers: {
            [HEADER.job]: jobName,
            [HEADER.attempt]: '1',
            [HEADER.attempts]: String(options.attempts),
          },
        },
      ],
    })
  }

  startWorker(queue: string, options: { concurrency?: number } = {}): void {
    ;(async () => {
      const consumer = (await this.client()).consumer({ groupId: this.groupId })
      this.consumers.push(consumer)
      await consumer.connect()
      await consumer.subscribe({ topic: queue, fromBeginning: false })
      await consumer.subscribe({ topic: this.retryTopic(queue), fromBeginning: false })
      await consumer.run({
        eachMessage: ({ message }) => this.handle(queue, message),
        ...(options.concurrency !== undefined ? { partitionsConsumedConcurrently: options.concurrency } : {}),
      })
    })().catch((error) => {
      // A broker-connect/subscribe failure at boot must be VISIBLE — otherwise
      // the app reports healthy with zero workers, and the floating rejection
      // would be process-fatal by Node's default.
      this.onError(error, { source: 'consumer', queue })
    })
  }

  async close(): Promise<void> {
    const producer = await this.producerPromise?.catch(() => undefined)
    await producer?.disconnect()
    await Promise.all(this.consumers.map((consumer) => consumer.disconnect()))
  }

  // --- internals -----------------------------------------------------------

  private async handle(queue: string, message: KafkaMessage): Promise<void> {
    if (message.value === null) return
    const headers = decodeHeaders(message.headers)
    const jobName = headers[HEADER.job] ?? ''
    const value = asString(message.value)

    try {
      await this.executor?.(jobName, JSON.parse(value))
    } catch {
      const attempt = Number(headers[HEADER.attempt] ?? 1)
      // Clamp the max-attempts read from the (untrusted) message to a hard
      // ceiling so a crafted `attempts` can't drive a retry-amplification loop.
      const attempts = Math.min(Number(headers[HEADER.attempts] ?? 1) || 1, MAX_ATTEMPTS)
      try {
        const producer = await this.producer()
        if (attempt < attempts) {
          await producer.send({
            topic: this.retryTopic(queue),
            messages: [{ value, headers: { ...headers, [HEADER.attempt]: String(attempt + 1) } }],
          })
        } else {
          await producer.send({ topic: this.deadTopic(queue), messages: [{ value, headers }] })
        }
      } catch (publishError) {
        // The failed job could not be re-routed. Surface the fault, then
        // RETHROW so eachMessage rejects and the offset is NOT committed —
        // kafkajs redelivers the message (at-least-once) instead of the job
        // silently vanishing on a producer outage. (Rabbitmq keeps the message
        // unacked for the same reason; Kafka's equivalent is not committing.)
        this.onError(publishError, { source: 'producer', queue })
        throw publishError
      }
    }
    // Offsets auto-commit after eachMessage resolves — a re-routed failure is
    // considered handled so the same message is not redelivered by Kafka.
  }

  private client(): Promise<KafkaClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.options.client
        ? Promise.resolve(this.options.client)
        : defaultClient(this.options)
    }
    return this.clientPromise
  }

  private producer(): Promise<KafkaProducer> {
    if (!this.producerPromise) {
      this.producerPromise = (async () => {
        const producer = (await this.client()).producer()
        await producer.connect()
        return producer
      })()
    }
    return this.producerPromise
  }

  private retryTopic(queue: string): string {
    return `${queue}${this.retrySuffix}`
  }
  private deadTopic(queue: string): string {
    return `${queue}${this.deadSuffix}`
  }
}

const asString = (value: Uint8Array | string): string =>
  typeof value === 'string' ? value : new TextDecoder().decode(value)

const decodeHeaders = (
  headers: Record<string, Uint8Array | string | undefined> | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) out[key] = asString(value)
  }
  return out
}

/**
 * Everything {@link queuePlugin} accepts, minus `driver` (this plugin IS the
 * driver choice), plus every Kafka driver option.
 */
export interface KafkaQueuePluginOptions
  extends Omit<QueuePluginOptions, 'driver'>,
    KafkaDriverOptions {}

/**
 * The Kafka-backed queue plugin — one line to put an app's jobs on Kafka:
 *
 * ```ts
 * kafkaQueuePlugin({ brokers: ['localhost:9092'], jobs: [SendWelcome], workers: [{ queue: 'welcome' }] })
 * ```
 *
 * Every backend ships a plugin of this shape (`bullmqQueuePlugin`, `rabbitmqQueuePlugin`, `sqsQueuePlugin`), so no backend is
 * privileged in the core's API and `@basaltkit/queue` stays a pure contract.
 * Use `queuePlugin({ driver })` directly for a driver you wrote yourself.
 *
 * Building the driver here, when the app is DEFINED, is safe: the constructor
 * only reads defaults, and every connection is opened lazily on first use.
 */
export function kafkaQueuePlugin(options: KafkaQueuePluginOptions) {
  // Split by the CORE's keys, not the driver's: a new driver option then flows
  // through untouched, and only a change to QueuePluginOptions needs an edit here.
  const { jobs, workers, onUnsupported, removeOnComplete, removeOnFail, ...driver } = options
  return queuePlugin({
    ...(jobs !== undefined ? { jobs } : {}),
    ...(workers !== undefined ? { workers } : {}),
    ...(onUnsupported !== undefined ? { onUnsupported } : {}),
    ...(removeOnComplete !== undefined ? { removeOnComplete } : {}),
    ...(removeOnFail !== undefined ? { removeOnFail } : {}),
    driver: new KafkaQueueDriver(driver),
  })
}
