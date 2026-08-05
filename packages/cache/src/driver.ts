/** Contrato de driver de cache. Todo driver passa na mesma suíte de conformidade. */
export interface CacheDriver {
  /** Retorna o valor ou undefined em miss/expirado. */
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, ttlMs?: number, tags?: string[]): Promise<void>
  delete(key: string): Promise<boolean>
  /** Remove todas as chaves que começam com o prefixo. */
  flushPrefix(prefix: string): Promise<void>
  /** Remove todas as chaves associadas a qualquer uma das tags. */
  flushTags(tags: string[]): Promise<void>
  disconnect(): Promise<void>
}
