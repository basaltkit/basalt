/**
 * Cancellation helpers shared by the provider layer and the workflow engine.
 * Kept dependency-free so both the low-level fetch and the high-level workflows
 * speak the same abort vocabulary.
 */

/** An `AbortError` with the conventional name, for signal-based cancellation. */
export function abortError(message = 'The operation was aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/** Throw an {@link abortError} if the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/** True when an error is an abort (from a cancelled fetch or {@link abortError}). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
