import { BasaltError } from '@basaltkit/core'

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
 * Intentional HTTP error throwable from any layer:
 * `throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')`
 */
export class HttpError extends BasaltError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
  ) {
    super(code, message)
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
