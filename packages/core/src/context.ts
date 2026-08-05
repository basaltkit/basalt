import { AsyncLocalStorage } from 'node:async_hooks'
import { ContextUnavailableError } from './errors.js'

/**
 * Contexto por request/job, propagado por toda a call stack via AsyncLocalStorage.
 * Pacotes estendem via module augmentation:
 *
 * declare module '@machize/core' {
 *   interface RequestContext {
 *     tenant?: { id: string }
 *   }
 * }
 */
export interface RequestContext {
  requestId?: string
  correlationId?: string
  [key: string]: unknown
}

const storage = new AsyncLocalStorage<RequestContext>()

/** Retorna o contexto ativo. Lança ContextUnavailableError fora de um escopo. */
export function ctx(): RequestContext {
  const store = storage.getStore()
  if (!store) throw new ContextUnavailableError()
  return store
}

/** Retorna o contexto ativo ou undefined — para código que precisa de fallback. */
export function tryCtx(): RequestContext | undefined {
  return storage.getStore()
}

/** Executa `fn` com o contexto dado ativo (inclusive através de awaits e callbacks). */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}
