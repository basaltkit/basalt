import type {
  AddJobOptions,
  DriverCapabilities,
  JobExecutor,
  QueueDriver,
} from '@machize/queue'

/** SQS caps per-message delay at 15 minutes. */
export const SQS_MAX_DELAY_SECONDS = 900

/** A received SQS message, normalized. */
export interface SqsMessage {
  body: string
  receiptHandle: string
  attributes: Record<string, string>
}

/** The SQS operations this driver uses. Injectable so tests need no broker. */
export interface SqsApi {
  sendMessage(input: {
    queueUrl: string
    body: string
    delaySeconds?: number
    attributes?: Record<string, string>
  }): Promise<void>
  receiveMessages(input: {
    queueUrl: string
    maxMessages: number
    waitTimeSeconds: number
    visibilityTimeout: number
  }): Promise<SqsMessage[]>
  deleteMessage(input: { queueUrl: string; receiptHandle: string }): Promise<void>
}

/** Thrown when a requested delay exceeds SQS's 15-minute maximum. */
export class SqsDelayTooLongError extends Error {
  constructor(seconds: number) {
    super(`SQS supports a maximum delay of ${SQS_MAX_DELAY_SECONDS}s; got ${seconds}s.`)
    this.name = 'SqsDelayTooLongError'
  }
}

const HEADER = {
  job: 'x-machize-job',
  attempt: 'x-machize-attempt',
  attempts: 'x-machize-attempts',
  backoffMs: 'x-machize-backoff-ms',
  backoffType: 'x-machize-backoff-type',
} as const

export interface SqsDriverOptions {
  /** Resolves a queue name to its SQS queue URL. */
  queueUrl: (queue: string) => string
  region?: string
  /** Suffix used to resolve the dead-letter queue's name. Default '-dead'. */
  deadSuffix?: string
  /** Long-poll wait, seconds. Default 20. */
  waitTimeSeconds?: number
  /** Visibility timeout while a message is being processed, seconds. Default 30. */
  visibilityTimeout?: number
  /** Injectable SQS API — defaults to the AWS SDK. Tests pass a fake. */
  api?: SqsApi
}

/**
 * Amazon SQS driver for `@machize/queue`. SQS has native per-message delay
 * (up to 15 min) but no priority, which its `capabilities` reflect honestly —
 * a priority dispatch is caught by the queue's `onUnsupported` policy.
 *
 * Retries and backoff are handled at the app level for parity with the other
 * drivers: on failure the message is re-sent with an incremented attempt and a
 * `DelaySeconds` backoff (clamped to 15 min); an exhausted job is sent to the
 * dead-letter queue (`<queue><deadSuffix>`). Provide a `queueUrl` resolver
 * mapping queue names — including the DLQ — to their SQS URLs.
 */
export class SqsQueueDriver implements QueueDriver {
  readonly name = 'sqs'
  readonly capabilities: DriverCapabilities = {
    delayed: true,
    priority: false,
    retries: true,
    backoff: true,
  }

  private executor: JobExecutor | undefined
  private apiPromise: Promise<SqsApi> | undefined
  private running = false
  private readonly pollers: Promise<void>[] = []
  private readonly deadSuffix: string
  private readonly waitTimeSeconds: number
  private readonly visibilityTimeout: number

  constructor(private readonly options: SqsDriverOptions) {
    this.deadSuffix = options.deadSuffix ?? '-dead'
    this.waitTimeSeconds = options.waitTimeSeconds ?? 20
    this.visibilityTimeout = options.visibilityTimeout ?? 30
  }

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    const api = await this.api()
    const attributes: Record<string, string> = {
      [HEADER.job]: jobName,
      [HEADER.attempt]: '1',
      [HEADER.attempts]: String(options.attempts),
      ...(options.backoff
        ? { [HEADER.backoffMs]: String(options.backoff.delayMs), [HEADER.backoffType]: options.backoff.type }
        : {}),
    }
    await api.sendMessage({
      queueUrl: this.options.queueUrl(queue),
      body: JSON.stringify(data),
      attributes,
      ...(options.delayMs !== undefined && options.delayMs > 0
        ? { delaySeconds: this.toDelaySeconds(options.delayMs, true) }
        : {}),
    })
  }

  startWorker(queue: string, options: { concurrency?: number } = {}): void {
    this.running = true
    const workers = Math.max(1, options.concurrency ?? 1)
    for (let i = 0; i < workers; i++) this.pollers.push(this.poll(queue))
  }

  async close(): Promise<void> {
    this.running = false
    await Promise.allSettled(this.pollers)
  }

  // --- internals -----------------------------------------------------------

  private async poll(queue: string): Promise<void> {
    const api = await this.api()
    const queueUrl = this.options.queueUrl(queue)
    while (this.running) {
      let messages: SqsMessage[]
      try {
        messages = await api.receiveMessages({
          queueUrl,
          maxMessages: 10,
          waitTimeSeconds: this.waitTimeSeconds,
          visibilityTimeout: this.visibilityTimeout,
        })
      } catch {
        if (!this.running) break
        continue
      }
      for (const message of messages) await this.handle(queue, message)
    }
  }

  private async handle(queue: string, message: SqsMessage): Promise<void> {
    const attributes = message.attributes
    const jobName = attributes[HEADER.job] ?? ''
    const api = await this.api()
    const queueUrl = this.options.queueUrl(queue)

    try {
      await this.executor?.(jobName, JSON.parse(message.body))
      await api.deleteMessage({ queueUrl, receiptHandle: message.receiptHandle })
    } catch {
      const attempt = Number(attributes[HEADER.attempt] ?? 1)
      const attempts = Number(attributes[HEADER.attempts] ?? 1)
      if (attempt < attempts) {
        await api.sendMessage({
          queueUrl,
          body: message.body,
          attributes: { ...attributes, [HEADER.attempt]: String(attempt + 1) },
          delaySeconds: this.toDelaySeconds(this.backoffDelay(attributes, attempt), false),
        })
      } else {
        await api.sendMessage({
          queueUrl: this.options.queueUrl(`${queue}${this.deadSuffix}`),
          body: message.body,
          attributes,
        })
      }
      // Re-routed, so remove the original from the source queue.
      await api.deleteMessage({ queueUrl, receiptHandle: message.receiptHandle })
    }
  }

  private backoffDelay(attributes: Record<string, string>, attempt: number): number {
    const base = Number(attributes[HEADER.backoffMs] ?? 0)
    if (!base) return 0
    return attributes[HEADER.backoffType] === 'exponential' ? base * 2 ** (attempt - 1) : base
  }

  /** ms → whole seconds. Throws on an over-limit user delay; clamps a backoff. */
  private toDelaySeconds(ms: number, strict: boolean): number {
    const seconds = Math.round(ms / 1000)
    if (seconds <= SQS_MAX_DELAY_SECONDS) return Math.max(0, seconds)
    if (strict) throw new SqsDelayTooLongError(seconds)
    return SQS_MAX_DELAY_SECONDS
  }

  private api(): Promise<SqsApi> {
    if (!this.apiPromise) {
      this.apiPromise = this.options.api ? Promise.resolve(this.options.api) : defaultApi(this.options)
    }
    return this.apiPromise
  }
}

// --- default AWS SDK-backed API ---------------------------------------------

interface SqsSdk {
  SQSClient: new (config: { region?: string }) => { send(command: unknown): Promise<SqsReceiveResult> }
  SendMessageCommand: new (input: Record<string, unknown>) => unknown
  ReceiveMessageCommand: new (input: Record<string, unknown>) => unknown
  DeleteMessageCommand: new (input: Record<string, unknown>) => unknown
}
interface SqsReceiveResult {
  Messages?: {
    Body?: string
    ReceiptHandle?: string
    MessageAttributes?: Record<string, { StringValue?: string }>
  }[]
}

const defaultApi = async (options: SqsDriverOptions): Promise<SqsApi> => {
  // Opaque specifier keeps @aws-sdk/client-sqs an optional peer dependency.
  const specifier = '@aws-sdk/client-sqs'
  const sdk = (await import(specifier)) as unknown as SqsSdk
  const client = new sdk.SQSClient(options.region !== undefined ? { region: options.region } : {})

  const toAttrs = (attributes?: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(attributes ?? {}).map(([key, value]) => [key, { DataType: 'String', StringValue: value }]),
    )

  return {
    async sendMessage({ queueUrl, body, delaySeconds, attributes }) {
      await client.send(
        new sdk.SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          ...(delaySeconds !== undefined ? { DelaySeconds: delaySeconds } : {}),
          MessageAttributes: toAttrs(attributes),
        }),
      )
    },
    async receiveMessages({ queueUrl, maxMessages, waitTimeSeconds, visibilityTimeout }) {
      const result = await client.send(
        new sdk.ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: maxMessages,
          WaitTimeSeconds: waitTimeSeconds,
          VisibilityTimeout: visibilityTimeout,
          MessageAttributeNames: ['All'],
        }),
      )
      return (result.Messages ?? []).map((message) => ({
        body: message.Body ?? '',
        receiptHandle: message.ReceiptHandle ?? '',
        attributes: Object.fromEntries(
          Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [key, value.StringValue ?? '']),
        ),
      }))
    },
    async deleteMessage({ queueUrl, receiptHandle }) {
      await client.send(new sdk.DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }))
    },
  }
}
