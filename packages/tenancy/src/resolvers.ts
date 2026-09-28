import { tryNormalizeDomain } from './custom-domains.js'
/** Neutral request shape — resolvers never see the HTTP framework. */
export interface ResolutionRequest {
  headers?: Record<string, string | string[] | undefined>
  /** Route params, when the adapter provides them. */
  params?: Record<string, string>
  url?: string
}

/** What a resolver identified: a tenant id or a custom domain to look up. */
export type TenantRef = { id: string } | { domain: string }

export type TenantResolver = ((
  request: ResolutionRequest,
) => TenantRef | null | Promise<TenantRef | null>) & {
  /**
   * An AUTHORITATIVE resolver reads something the platform controls — the
   * `Host` it serves (subdomain, custom domain) or the route it matched. Once
   * one of them names a tenant, that answer is final: if the tenant does not
   * exist the request resolves to no tenant, and no other resolver — above all
   * not a client-controlled header — gets a say. Authoritative resolvers are
   * always consulted before the others, whatever the list order.
   *
   * Unmarked resolvers (including `headerResolver`) are fallbacks, consulted in
   * list order only when no authoritative resolver named a tenant.
   */
  readonly authoritative?: boolean
}

/**
 * Marks a resolver as authoritative — see {@link TenantResolver.authoritative}.
 * Use it for a custom resolver whose input the platform controls (a claim in a
 * token it signed, a gateway-injected header clients cannot set).
 */
export function authoritative(
  resolver: (request: ResolutionRequest) => TenantRef | null | Promise<TenantRef | null>,
): TenantResolver {
  return Object.assign((request: ResolutionRequest) => resolver(request), { authoritative: true as const })
}

function hostOf(request: ResolutionRequest): string | undefined {
  const raw = request.headers?.['host']
  const host = Array.isArray(raw) ? raw[0] : raw
  // Canonicalize exactly like registration/lookup (lowercase, strip port +
  // trailing dot) so an oddly-cased Host maps to the same key. A Host outside
  // the hostname grammar (userinfo, path, `%`, non-ASCII) matches nothing.
  return host ? (tryNormalizeDomain(host) ?? undefined) : undefined
}

/**
 * acme.basalt.app → { id: 'acme' }. Ignores the bare base domain and 'www'.
 * Authoritative: `nosuch.basalt.app` resolves to no tenant, never to a fallback.
 */
export function subdomainResolver(options: { base: string }): TenantResolver {
  const suffix = `.${tryNormalizeDomain(options.base) ?? options.base.toLowerCase()}`
  return authoritative((request) => {
    const host = hostOf(request)
    if (!host || !host.endsWith(suffix)) return null
    const subdomain = host.slice(0, -suffix.length)
    if (!subdomain || subdomain === 'www' || subdomain.includes('.')) return null
    return { id: subdomain }
  })
}

/**
 * app.acme.com → { domain: 'app.acme.com' } — resolved via source.findByDomain.
 * Authoritative: an unknown Host resolves to no tenant, never to a fallback.
 */
export function domainResolver(): TenantResolver {
  return authoritative((request) => {
    const host = hostOf(request)
    return host ? { domain: host } : null
  })
}

/**
 * `x-tenant-id: acme` → { id: 'acme' }. CLIENT-controlled, so it is a fallback:
 * it is consulted only when no authoritative resolver (subdomain, domain,
 * route) named a tenant, and it can never override one.
 */
export function headerResolver(options: { header?: string } = {}): TenantResolver {
  const header = (options.header ?? 'x-tenant-id').toLowerCase()
  return (request) => {
    const raw = request.headers?.[header]
    const value = Array.isArray(raw) ? raw[0] : raw
    return value ? { id: value } : null
  }
}

/** /t/:tenant/... → { id: params.tenant }. Authoritative: the app chose to put the tenant in its route. */
export function routeResolver(options: { param?: string } = {}): TenantResolver {
  const param = options.param ?? 'tenant'
  return authoritative((request) => {
    const value = request.params?.[param]
    return value ? { id: value } : null
  })
}
