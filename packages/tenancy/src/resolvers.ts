import { normalizeDomain } from './custom-domains.js'
/** Neutral request shape — resolvers never see the HTTP framework. */
export interface ResolutionRequest {
  headers?: Record<string, string | string[] | undefined>
  /** Route params, when the adapter provides them. */
  params?: Record<string, string>
  url?: string
}

/** What a resolver identified: a tenant id or a custom domain to look up. */
export type TenantRef = { id: string } | { domain: string }

export type TenantResolver = (
  request: ResolutionRequest,
) => TenantRef | null | Promise<TenantRef | null>

function hostOf(request: ResolutionRequest): string | undefined {
  const raw = request.headers?.['host']
  const host = Array.isArray(raw) ? raw[0] : raw
  // Canonicalize exactly like registration/lookup (lowercase, strip port +
  // trailing dot, IDNA) so a forged/oddly-cased Host maps to the same key.
  return host ? normalizeDomain(host) : undefined
}

/** acme.basalt.app → { id: 'acme' }. Ignores the bare base domain and 'www'. */
export function subdomainResolver(options: { base: string }): TenantResolver {
  const suffix = `.${options.base}`
  return (request) => {
    const host = hostOf(request)
    if (!host || !host.endsWith(suffix)) return null
    const subdomain = host.slice(0, -suffix.length)
    if (!subdomain || subdomain === 'www' || subdomain.includes('.')) return null
    return { id: subdomain }
  }
}

/** app.acme.com → { domain: 'app.acme.com' } — resolved via source.findByDomain. */
export function domainResolver(): TenantResolver {
  return (request) => {
    const host = hostOf(request)
    return host ? { domain: host } : null
  }
}

export function headerResolver(options: { header?: string } = {}): TenantResolver {
  const header = (options.header ?? 'x-tenant-id').toLowerCase()
  return (request) => {
    const raw = request.headers?.[header]
    const value = Array.isArray(raw) ? raw[0] : raw
    return value ? { id: value } : null
  }
}

/** /t/:tenant/... → { id: params.tenant }. */
export function routeResolver(options: { param?: string } = {}): TenantResolver {
  const param = options.param ?? 'tenant'
  return (request) => {
    const value = request.params?.[param]
    return value ? { id: value } : null
  }
}
