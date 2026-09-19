/**
 * The error body every Basalt adapter serves (`@basaltkit/http`'s neutral
 * serializer), described here so callers can read a failed response without
 * casting their way through `unknown`.
 */
export interface BasaltErrorBody {
  error: {
    /** Stable, machine-readable code — safe to branch on. */
    code: string
    message: string
    /** Validation failures only: which part of the request failed. */
    part?: 'body' | 'query' | 'params'
    /** Validation failures only: one entry per offending field. */
    issues?: { path: string; message: string }[]
    /**
     * Structured payload from a server error deliberately constructed with one
     * (`new HttpError(status, code, message, { details })`). Plain JSON data,
     * bounded by the server — which checks failed, how much quota is left, the
     * current version behind a conflict.
     */
    details?: Record<string, unknown>
  }
}

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

  /**
   * The server's structured `error.details`, or `undefined` when the response
   * carried none. `details` is the whole response body; this is the payload the
   * server meant the UI to act on — no casting, no digging.
   */
  get errorDetails(): Record<string, unknown> | undefined {
    const body = this.details as Partial<BasaltErrorBody> | null | undefined
    const details: unknown = body?.error?.details
    if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined
    return details as Record<string, unknown>
  }
}
