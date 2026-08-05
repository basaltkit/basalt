import { MachizeError } from '@machize/core'
import {
  queuePlugin,
  type AddJobOptions,
  type JobDefinition,
  type JobExecutor,
  type QueueDriver,
} from '@machize/queue'

export class QueueAssertionError extends MachizeError {
  constructor(message: string) {
    super('TEST_QUEUE_ASSERTION', message)
  }
}

export interface CapturedJob {
  queue: string
  job: string
  payload: unknown
  context: unknown
  options: AddJobOptions
}

/** Captures dispatches without executing them; drain() runs the backlog. */
class CapturingQueueDriver implements QueueDriver {
  readonly captured: CapturedJob[] = []
  private readonly pending: { jobName: string; data: unknown }[] = []
  private executor: JobExecutor | undefined

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    const envelope = data as { payload?: unknown; context?: unknown }
    this.captured.push({
      queue,
      job: jobName,
      payload: envelope.payload,
      context: envelope.context,
      options,
    })
    this.pending.push({ jobName, data })
  }

  async drain(): Promise<number> {
    let ran = 0
    while (this.pending.length > 0) {
      const next = this.pending.shift() as { jobName: string; data: unknown }
      await this.executor?.(next.jobName, next.data)
      ran++
    }
    return ran
  }

  startWorker(): void {}
  async close(): Promise<void> {}
}

export interface FakeQueue {
  /** Register this in createTestApp({ plugins: [queue.plugin, ...] }). */
  plugin: ReturnType<typeof queuePlugin>
  /** Every dispatch, in order — payload and context snapshot included. */
  dispatched: CapturedJob[]
  assertDispatched(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test boundary
    job: JobDefinition<any> | string,
    predicate?: (captured: CapturedJob) => boolean,
  ): CapturedJob
  assertNothingDispatched(): void
  /** Executes the captured backlog through the real handlers. */
  drain(): Promise<number>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test boundary
export function fakeQueue(options: { jobs?: JobDefinition<any>[] } = {}): FakeQueue {
  const driver = new CapturingQueueDriver()
  const plugin = queuePlugin({
    driver,
    ...(options.jobs ? { jobs: options.jobs as JobDefinition<never>[] } : {}),
  })

  return {
    plugin,
    dispatched: driver.captured,
    assertDispatched(job, predicate) {
      const name = typeof job === 'string' ? job : job.name
      const matches = driver.captured.filter(
        (captured) => captured.job === name && (predicate ? predicate(captured) : true),
      )
      if (matches.length === 0) {
        const seen = driver.captured.map((captured) => captured.job).join(', ') || '(nothing)'
        throw new QueueAssertionError(
          `Expected job "${name}" to have been dispatched${predicate ? ' matching the predicate' : ''}. Dispatched: ${seen}`,
        )
      }
      return matches[0] as CapturedJob
    },
    assertNothingDispatched() {
      if (driver.captured.length > 0) {
        throw new QueueAssertionError(
          `Expected no jobs, but ${driver.captured.length} were dispatched: ${driver.captured
            .map((captured) => captured.job)
            .join(', ')}`,
        )
      }
    },
    drain: () => driver.drain(),
  }
}
