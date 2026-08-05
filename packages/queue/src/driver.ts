export interface AddJobOptions {
  attempts: number
  backoff?: { type: 'exponential' | 'fixed'; delayMs: number } | undefined
  delayMs?: number | undefined
  priority?: number | undefined
}

export type JobExecutor = (jobName: string, data: unknown) => Promise<void>

/** Contrato de driver de fila. BullMQ em produção; sync em testes/dev. */
export interface QueueDriver {
  /** Chamado uma vez pelo QueueManager — como executar um job recebido. */
  setExecutor(executor: JobExecutor): void
  add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void>
  /** Inicia um worker para a fila (no driver sync é no-op: add executa inline). */
  startWorker(queue: string, options?: { concurrency?: number }): void
  close(): Promise<void>
}
