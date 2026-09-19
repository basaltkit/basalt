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

/**
 * `can(user, 'doc:update', resource)` was called with a resource, but no policy
 * check matched — a typo'd resource or action. Historically this fell through to
 * pure RBAC, so the ownership rule the author wrote never ran and a broad grant
 * ("doc:*") silently allowed the request. Fails closed instead.
 */
export class MissingPolicyError extends BasaltError {
  readonly status = 500
  constructor(permission: string, registered: string[]) {
    super(
      'PERMISSION_POLICY_MISSING',
      `No policy check for "${permission}", but a resource was passed — the ABAC rule you intended would be skipped ` +
        `and the decision would fall back to plain RBAC. Register the check with definePolicy(), fix the ` +
        `resource:action spelling, or drop the resource argument. ` +
        `Registered policies: ${registered.length ? registered.join(', ') : '(none)'}. ` +
        `To restore the old fall-through, set onMissingPolicy: 'rbac'.`,
    )
  }
}

/**
 * The request's tenant id equals a scope the Gate reserves for platform-wide
 * grants (`GLOBAL_SCOPE`, or the historic `'global'`). Evaluating grants there
 * would let the members of that tenant read and write the global bucket, so the
 * check fails closed. Reserve these ids in your tenant registry. Also thrown
 * when a tenant is present in the context without a non-empty string id.
 */
export class ReservedScopeError extends BasaltError {
  readonly status = 403
  constructor(tenantId: string) {
    super(
      'PERMISSION_SCOPE_RESERVED',
      tenantId === ''
        ? 'The request has a tenant but no usable tenant id, so no permission scope can be derived from it.'
        : `Tenant id ${JSON.stringify(tenantId)} is reserved for global grants and cannot be used as a permission scope.`,
    )
  }
}
