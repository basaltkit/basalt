import { AsyncLocalStorage } from 'node:async_hooks'
import { ContextUnavailableError } from './errors.js'

/**
 * Per-request/job context, propagated through the whole call stack via AsyncLocalStorage.
 * Packages extend it via module augmentation:
 *
 * declare module '@basaltkit/core' {
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

/** Returns the active context. Throws ContextUnavailableError outside of a scope. */
export function ctx(): RequestContext {
  const store = storage.getStore()
  if (!store) throw new ContextUnavailableError()
  return store
}

/** Returns the active context or undefined — for code that needs a fallback. */
export function tryCtx(): RequestContext | undefined {
  return storage.getStore()
}

/** Runs `fn` with the given context active (including across awaits and callbacks). */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}
