import { BasaltError, tryCtx } from '@basaltkit/core'
import type { Tenant } from './tenant.js'

/**
 * A tenant-owned operation ran without a tenant in context (and without an
 * explicit fallback). Fails closed: better a 400 than silently querying
 * UNSCOPED — with Prisma, `where: { tenantId: undefined }` drops the filter
 * and returns every tenant's rows. Maps to HTTP 400 in every adapter.
 */
export class TenantRequiredError extends BasaltError {
  readonly status = 400
  constructor() {
    super(
      'TENANT_REQUIRED',
      'No tenant in the current context. Resolve a tenant before touching tenant-owned data — this operation fails closed instead of querying unscoped.',
    )
  }
}

/** Fail-closed: the tenant of the active context, or throw {@link TenantRequiredError}. */
export function requireTenant(): Tenant {
  const tenant = tryCtx()?.tenant
  if (!tenant) throw new TenantRequiredError()
  return tenant
}

/**
 * Fail-closed tenant id resolution with anti-widening semantics:
 *
 * 1. A tenant in context always wins — a caller-supplied `fallback` (which may
 *    carry client input) can never widen or switch the scope of a request.
 * 2. With no context tenant, an explicit `fallback` is honoured — system code
 *    (jobs, CLI commands) can pin one tenant deliberately.
 * 3. Otherwise it THROWS instead of returning `undefined` — the value is
 *    always a real tenant id, never a filter that silently disappears.
 *
 * Same rules as `Audit.trail()`'s hardened scoping.
 */
export function requireTenantId(fallback?: string): string {
  const contextId = tryCtx()?.tenant?.id
  if (contextId !== undefined) return contextId
  if (fallback !== undefined) return fallback
  throw new TenantRequiredError()
}

/**
 * Fail-closed tenant filter for repository `where` clauses:
 *
 *     const rows = await db.project.findMany({ where: tenantScoped({ archived: false }) })
 *
 * The tenant comes from the context and ONLY from the context. A `tenantId`
 * in `where` is never used as a fallback: `where` is routinely built from
 * client input (`{ ...req.query }`), and with no tenant resolved (tenancy's
 * `required` defaults to false) that would let the client pick any tenant.
 * `tenantId` is spread LAST, so a smuggled value cannot override the context
 * tenant either. Throws {@link TenantRequiredError} when there is no context
 * tenant — system code that must pin a tenant calls `requireTenantId(id)`
 * explicitly, or runs inside `tenancy.run(id, …)`.
 */
export function tenantScoped<W extends Record<string, unknown> = Record<string, never>>(
  where?: W,
): W & { tenantId: string } {
  const tenantId = requireTenantId()
  return { ...(where as W), tenantId }
}
