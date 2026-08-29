import { BasaltError } from '@basaltkit/core'

export class PermissionDeniedError extends BasaltError {
  readonly status = 403
  constructor(permission: string) {
    super('PERMISSION_DENIED', `Missing permission "${permission}".`)
  }
}

/** A `can` route was hit without an authenticated user. */
export class AuthRequiredGuardError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REQUIRED', 'Authentication required.')
  }
}

/**
 * A route declared `meta.can` with a shape the guard cannot enforce (anything
 * other than a non-empty string or a non-empty array of strings). Thrown on
 * every request to that route: an unenforceable authorization declaration must
 * fail CLOSED, never silently skip the permission check.
 */
export class InvalidCanMetaError extends BasaltError {
  readonly status = 500
  constructor(route: string, received: unknown) {
    super(
      'PERMISSION_META_INVALID',
      `Route "${route}" declares meta.can with an unenforceable shape (${describe(received)}). ` +
        `Use a permission string ('projects:delete') or a non-empty array of strings (all required).`,
    )
  }
}

const describe = (value: unknown): string =>
  Array.isArray(value) ? 'array with non-string or no entries' : `type ${typeof value}`
