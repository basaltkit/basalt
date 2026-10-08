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
        `Use a permission string ('projects:delete'), a resource requirement ` +
        `({ permission: 'projects:update', resource: (input) => load(input.params.id) }), ` +
        `or a non-empty array of those (all required).`,
    )
  }
}

const describe = (value: unknown): string =>
  Array.isArray(value)
    ? 'array with a malformed entry or no entries'
    : value !== null && typeof value === 'object'
      ? 'object without a valid permission string and resource loader'
      : `type ${typeof value}`

/**
 * A `meta.can` resource requirement's loader found nothing (returned `null` or
 * `undefined`). The default answer is a 404: there is nothing to authorize
 * against. Set `notFound: 'deny'` (on the requirement, or `resourceNotFound`
 * on the plugin) to answer 403 instead, so a caller cannot tell a missing
 * resource from one they may not touch.
 */
export class ResourceNotFoundError extends BasaltError {
  readonly status = 404
  constructor() {
    super('RESOURCE_NOT_FOUND', 'Resource not found.')
  }
}

/**
 * `canResource()` was called where the `meta.can` guard resolved no resource
 * (a route without a resource requirement, a different permission, or code
 * running outside the request). A programming error — fails loud.
 */
export class CanResourceUnavailableError extends BasaltError {
  readonly status = 500
  constructor(reason: string) {
    super('PERMISSION_RESOURCE_UNAVAILABLE', `canResource(): ${reason}`)
  }
}

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
 * `gate.listFilter(user, 'doc:read')` found no list filter for exactly
 * `resource:action`. There is no RBAC fallback and `onMissingPolicy` does not
 * apply: "RBAC allows" has no row-set meaning, and answering "unrestricted"
 * would list every row. Fails closed.
 */
export class MissingPolicyFilterError extends BasaltError {
  readonly status = 500
  constructor(permission: string, registered: string[]) {
    super(
      'PERMISSION_FILTER_MISSING',
      `No list filter for "${permission}". Add \`filters: { ${permission.split(':')[1] ?? 'action'}: (user) => … }\` ` +
        `to the definePolicy() call for this resource (next to its check), or fix the resource:action spelling. ` +
        `Registered filters: ${registered.length ? registered.join(', ') : '(none)'}.`,
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

/**
 * A grant write (`assignRole`, `grantToUser`, `grantTemporarily`, `delegate`…)
 * was made with no explicit `scope`, in a multi-tenant app, while no tenant is
 * in the context. Defaulting to the global scope there would turn a tenant
 * administration call — say, on a request whose tenant failed to resolve — into
 * a platform-wide grant, so the write fails closed. Pass the scope explicitly
 * (a tenant id, or `GLOBAL_SCOPE` when a global grant is really meant), run it
 * inside the tenant's context, or build the Gate with `allowGlobalWrites: true`.
 */
export class ScopeRequiredError extends BasaltError {
  readonly status = 400
  constructor(operation: string) {
    super(
      'PERMISSION_SCOPE_REQUIRED',
      `gate.${operation}() was called with no scope and no tenant in the context, in an app with tenancy active. ` +
        `Refusing to write a platform-wide grant by default: pass the scope explicitly (a tenant id, or ` +
        `GLOBAL_SCOPE for a global grant), run the write inside the tenant's context, or set allowGlobalWrites: true.`,
    )
  }
}
