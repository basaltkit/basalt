import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import type { AddJobOptions, JobExecutor, QueueDriver } from '../driver.js'

export interface BullmqDriverOptions {
  /** Redis URL (redis://... or rediss://...) or ioredis connection options. */
  connection: string | ConnectionOptions
}

export class BullmqQueueDriver implements QueueDriver {
  readonly name = 'bullmq'
  readonly capabilities = { delayed: true, priority: true, retries: true, backoff: true }
  private readonly connection: ConnectionOptions
  private readonly queues = new Map<string, Queue>()
  private readonly workers: Worker[] = []
  private executor: JobExecutor | undefined

  constructor(options: BullmqDriverOptions) {
    this.connection =
      typeof options.connection === 'string'
        ? parseRedisUrl(options.connection)
        : options.connection
  }

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    await this.queue(queue).add(jobName, data, {
      attempts: options.attempts,
      ...(options.backoff
        ? { backoff: { type: options.backoff.type, delay: options.backoff.delayMs } }
        : {}),
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    })
  }

  startWorker(queue: string, options: { concurrency?: number } = {}): void {
    this.workers.push(
      new Worker(queue, async (job) => this.executor?.(job.name, job.data), {
        connection: this.connection,
        concurrency: options.concurrency ?? 1,
      }),
    )
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()))
    await Promise.all([...this.queues.values()].map((queue) => queue.close()))
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name)
    if (!queue) {
      queue = new Queue(name, { connection: this.connection })
      this.queues.set(name, queue)
    }
    return queue
  }
}

function parseRedisUrl(url: string): ConnectionOptions {
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.pathname && parsed.pathname !== '/' ? { db: Number(parsed.pathname.slice(1)) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    // required by BullMQ for workers
    maxRetriesPerRequest: null,
  }
}
