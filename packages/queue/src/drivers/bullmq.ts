import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq'
import type { AddJobOptions, JobExecutor, QueueDriver, QueueStats, RetentionOption } from '../driver.js'

type KeepJobs = { age?: number; count?: number }

/** Map the driver-neutral retention to BullMQ's (age in seconds), falling back to a default. */
function toBullRetention(retention: RetentionOption | undefined, fallback: boolean | KeepJobs): boolean | number | KeepJobs {
  if (retention === undefined) return fallback
  if (typeof retention === 'boolean' || typeof retention === 'number') return retention
  const out: KeepJobs = {}
  if (retention.ageMs !== undefined) out.age = Math.max(1, Math.round(retention.ageMs / 1000))
  if (retention.count !== undefined) out.count = retention.count
  return out
}

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
      removeOnComplete: toBullRetention(options.removeOnComplete, { count: 1000 }) as NonNullable<
        JobsOptions['removeOnComplete']
      >,
      removeOnFail: toBullRetention(options.removeOnFail, false) as NonNullable<JobsOptions['removeOnFail']>,
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

  async stats(queue: string): Promise<QueueStats> {
    const c = await this.queue(queue).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')
    return {
      waiting: c['waiting'] ?? 0,
      active: c['active'] ?? 0,
      completed: c['completed'] ?? 0,
      failed: c['failed'] ?? 0,
      delayed: c['delayed'] ?? 0,
    }
  }

  async retryFailed(queue: string, options: { limit?: number } = {}): Promise<number> {
    const limit = options.limit ?? 1000
    const failed = await this.queue(queue).getFailed(0, limit - 1)
    let retried = 0
    for (const job of failed) {
      await job.retry()
      retried++
    }
    return retried
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
