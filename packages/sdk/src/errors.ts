/**
 * Error thrown by the client for any non-2xx response (or a response that
 * fails the endpoint's result schema). `code` mirrors the server's stable
 * error code, so callers branch on it the same way on both sides.
 *
 * Kept dependency-free (no @basaltkit/core) so the SDK stays browser-friendly.
 */
export class BasaltClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'BasaltClientError'
  }
}
