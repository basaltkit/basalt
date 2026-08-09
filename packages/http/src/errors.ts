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
