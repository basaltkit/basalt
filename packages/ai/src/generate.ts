import { abortError, isAbortError, throwIfAborted } from './provider/abort.js'
import type { AIProvider, GenerateOptions } from './provider/types.js'

/**
 * A progress event from a long-running workflow step. `chunk`/`text` carry
 * streamed model output (streaming generations); `message` carries a coarse
 * status (e.g. a `make` phase). All fields optional so a consumer maps whatever
 * is present onto its own progress surface (e.g. MCP `notifications/progress`).
 */
export interface WorkflowProgress {
  /** A short human-readable status. */
  message?: string
  /** The newest streamed text fragment. */
  chunk?: string
  /** All model text received so far. */
  text?: string
}

export type OnProgress = (progress: WorkflowProgress) => void

/** Cross-cutting options threaded through the workflow engine. */
export interface WorkflowRunOptions {
  /** Abort the operation. Forwarded to the provider's fetch and raced at this layer. */
  signal?: AbortSignal
  /** Receive progress as it happens. When set, streaming providers stream. */
  onProgress?: OnProgress
}

/**
 * Run a provider completion. With `onProgress`, consume `provider.stream` and
 * emit each fragment (real token streaming where the provider supports it; a
 * single final chunk otherwise). Without it, the one-shot `provider.generate`
 * path is used unchanged.
 */
export async function generateText(
  provider: AIProvider,
  options: GenerateOptions,
  onProgress?: OnProgress,
): Promise<string> {
  if (!onProgress) return provider.generate(options)
  let text = ''
  for await (const chunk of provider.stream(options)) {
    if (!chunk) continue
    text += chunk
    onProgress({ chunk, text })
  }
  return text
}

/**
 * Race a task against an abort signal so cancellation is prompt even if the
 * underlying provider doesn't honour the signal itself.
 */
export async function withAbort<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!signal) return run()
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Provider generation with optional streaming (`onProgress`) and cancellation
 * (`signal`) — the single seam the workflow steps call so signal + progress are
 * threaded consistently.
 */
export function runGeneration(
  provider: AIProvider,
  options: GenerateOptions,
  run: WorkflowRunOptions = {},
): Promise<string> {
  const genOptions: GenerateOptions = run.signal ? { ...options, signal: run.signal } : options
  return withAbort(run.signal, () => generateText(provider, genOptions, run.onProgress))
}

export { abortError, isAbortError, throwIfAborted }
