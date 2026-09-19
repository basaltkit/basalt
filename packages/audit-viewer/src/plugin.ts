import { BasaltError, createToken, ctx, definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import { AUDIT } from '@basaltkit/audit'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { AuditViewer, type AuditViewerOptions, type ViewerQuery } from './viewer.js'
import { auditViewerCsp, auditViewerHtml, type AuditViewerHtmlOptions } from './html.js'

export const AUDIT_VIEWER = createToken<AuditViewer>('audit:viewer')

export type AuditViewerPluginOptions = AuditViewerOptions

export function auditViewerPlugin(options: AuditViewerPluginOptions = {}) {
  return definePlugin({
    name: 'basalt:audit-viewer',
    register({ container }) {
      // 'tenancy:active' is tenancyPlugin's marker: how a generic package
      // learns the app is multi-tenant without importing @basaltkit/tenancy.
      const metadata = ensureMetadata(container)
      container.singleton(
        AUDIT_VIEWER,
        () => new AuditViewer(container.get(AUDIT), options, () => metadata.get('tenancy:active').length > 0),
      )
    },
  })
}

const viewer = () => (ctx().container as Container).get(AUDIT_VIEWER)

const querySchema = z.object({
  event: z.string().optional(),
  actorId: z.string().optional(),
  source: z.enum(['hook', 'event', 'manual']).optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
})

const toQuery = (q: z.infer<typeof querySchema>): ViewerQuery => ({
  ...(q.event !== undefined ? { event: q.event } : {}),
  ...(q.actorId !== undefined ? { actorId: q.actorId } : {}),
  ...(q.source !== undefined ? { source: q.source } : {}),
  ...(q.since !== undefined ? { since: q.since } : {}),
  ...(q.until !== undefined ? { until: q.until } : {}),
  ...(q.limit !== undefined ? { limit: q.limit } : {}),
  ...(q.offset !== undefined ? { offset: q.offset } : {}),
})

export interface AuditViewerRoutesOptions extends AuditViewerHtmlOptions {
  /**
   * Content-Security-Policy for the HTML page. Default: the hash-locked
   * {@link auditViewerCsp}. Pass a string to override, or `false` to send none.
   */
  csp?: string | false
  /**
   * The authorization guard merged into every route's `meta` — e.g.
   * `{ can: 'audit:read' }` (@basaltkit/permissions) or `{ teamRole: 'admin' }`
   * (@basaltkit/teams). `auth: true` is always added on top.
   *
   * Required unless `allowAnyAuthenticated` is set: the trail holds every
   * user's actions, emails and event payloads, so it is an admin surface.
   */
  meta?: Record<string, unknown>
  /**
   * Explicitly lets any logged-in user of the tenant read the whole trail.
   * Only for apps where every user is an administrator.
   */
  allowAnyAuthenticated?: boolean
}

/** `auditViewerRoutes()` was called without an authorization guard. */
export class AuditViewerUnguardedError extends BasaltError {
  constructor() {
    super(
      'AUDIT_VIEWER_UNGUARDED',
      'auditViewerRoutes() exposes every user\'s audit entries and needs an authorization guard: ' +
        "pass `meta` (e.g. { can: 'audit:read' } or { teamRole: 'admin' }), " +
        'or `allowAnyAuthenticated: true` if every logged-in user may read the whole trail.',
    )
  }
}

/**
 * Route-meta keys the framework reads that authorize nobody: throttling,
 * documentation, caching, exposure and tenant-routing switches. A `meta` made
 * only of these is no guard at all.
 */
const NON_AUTHORIZING_META = new Set([
  'auth',
  'rateLimit',
  'central',
  'tenant',
  'mcp',
  'etag',
  'summary',
  'description',
  'tags',
  'operationId',
  'deprecated',
])

/**
 * Whether a guard value asks for something. Guards skip falsy values (the teams
 * guard returns early on `!meta.teamRole`), so `''`, `null`, `false`, `0` or an
 * empty array would mount the routes with no check behind them.
 */
const isPresent = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : value !== null && value !== false && value !== '' && value !== 0

/**
 * Read-only audit routes for the current tenant: `GET /audit`, `/audit/stats`,
 * `/audit/:id`, and a browsable HTML page at `/audit/view`.
 *
 * Every route requires a logged-in user **and** the guard given as `meta`;
 * building the routes without one throws {@link AuditViewerUnguardedError}
 * unless `allowAnyAuthenticated: true` opts out explicitly.
 */
export function auditViewerRoutes(options: AuditViewerRoutesOptions = {}): BasaltRoute[] {
  const guard = Object.fromEntries(
    Object.entries(options.meta ?? {}).filter(([key, value]) => key !== 'auth' && value !== undefined),
  )
  const authorizes = Object.entries(guard).some(([key, value]) => !NON_AUTHORIZING_META.has(key) && isPresent(value))
  if (!authorizes && options.allowAnyAuthenticated !== true) throw new AuditViewerUnguardedError()
  const meta = { ...guard, auth: true }
  const csp = options.csp === false ? undefined : (options.csp ?? auditViewerCsp(options))
  return [
    route({
      method: 'GET',
      url: '/audit',
      meta,
      query: querySchema,
      async handler({ query }) {
        return viewer().page(toQuery(query))
      },
    }),
    route({
      method: 'GET',
      url: '/audit/stats',
      meta,
      query: querySchema,
      async handler({ query }) {
        return viewer().stats(toQuery(query))
      },
    }),
    route({
      method: 'GET',
      url: '/audit/view',
      meta,
      async handler({ reply }) {
        if (csp !== undefined) reply.header('content-security-policy', csp)
        return reply.header('content-type', 'text/html; charset=utf-8').send(auditViewerHtml(options))
      },
    }),
    route({
      method: 'GET',
      url: '/audit/:id',
      meta,
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        const entry = await viewer().get(params.id)
        return entry ?? reply.code(404).send({ error: { code: 'AUDIT_NOT_FOUND', message: 'Entry not found.' } })
      },
    }),
  ]
}
