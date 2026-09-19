import { BasaltError, type BasaltErrorOptions } from '@basaltkit/core'
import type { ErrorDetails } from './error-details.js'

export interface ValidationIssue {
  path: string
  message: string
}

/** Body/query/params validation failure — becomes a standardized 400 response. */
export class RequestValidationError extends BasaltError {
  constructor(
    readonly part: 'body' | 'query' | 'params',
    readonly issues: ValidationIssue[],
  ) {
    super('HTTP_VALIDATION', `Validation failed in ${part}`)
  }
}

/**
 * Fourth argument to `HttpError` — an options object rather than a positional
 * `details`, so later additions do not keep widening the signature.
 */
export interface HttpErrorOptions extends BasaltErrorOptions {
  /**
   * Machine-readable data the client is meant to act on — which checks failed,
   * how much quota is left, the current version behind a 409. Serialised as
   * `error.details`, so it is PUBLIC: plain JSON data, no secrets, no
   * internals, and bounded (see `sanitizeErrorDetails`).
   */
  details?: ErrorDetails
}

/**
 * Intentional HTTP error throwable from any layer:
 * `throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')`
 *
 * With a structured payload for the UI to act on:
 * `throw new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', { details: { failed: ['age'] } })`
 */
export class HttpError extends BasaltError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
    options?: HttpErrorOptions,
  ) {
    super(code, message, options)
  }
}

/**
 * The neutral not-found body every adapter serves for an unmatched route
 * (unless the adapter plugin is given `notFound: false`). One shape across
 * Fastify, Express and Hono — same `{ error: { code, message } }` contract as
 * validation and HttpError responses, and no framework-fingerprinting HTML or
 * plain-text defaults.
 */
export const NOT_FOUND_RESPONSE = {
  error: { code: 'NOT_FOUND', message: 'Route not found.' },
} as const

/**
 * A route pipeline carried guards but no container, so the guards could not run.
 * The pipeline used to skip them silently — a fail-open shape: the request would
 * reach the handler unauthorized. Guards and container are wired together in every
 * shipped adapter, so this can only fire on a hand-built pipeline; it fails closed.
 */
export class GuardsWithoutContainerError extends BasaltError {
  readonly status = 500
  constructor(route: string, count: number) {
    super(
      'HTTP_GUARDS_UNRUNNABLE',
      `${route}: ${count} route guard(s) are registered but the pipeline has no container, so none of them can run. ` +
        'Pass `container` to the pipeline (every Basalt adapter does), or register no guards.',
    )
  }
}
