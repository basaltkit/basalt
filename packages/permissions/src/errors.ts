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
