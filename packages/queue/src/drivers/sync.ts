import type { AddJobOptions, JobExecutor, QueueDriver } from '../driver.js'

/**
 * Driver síncrono: executa o job inline no dispatch, honrando `attempts`
 * (retry imediato). É o driver de testes e de dev sem Redis — o equivalente
 * ao queue driver `sync` do Laravel.
 */
export class SyncQueueDriver implements QueueDriver {
  private executor: JobExecutor | undefined
  /** histórico de execuções — útil em asserções de teste */
  readonly executed: { queue: string; jobName: string; attempts: number }[] = []

  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= options.attempts; attempt++) {
      try {
        await this.executor?.(jobName, data)
        this.executed.push({ queue, jobName, attempts: attempt })
        return
      } catch (error) {
        lastError = error
      }
    }
    this.executed.push({ queue, jobName, attempts: options.attempts })
    throw lastError
  }

  startWorker(): void {
    // no-op: add() já executa inline
  }

  async close(): Promise<void> {}
}
