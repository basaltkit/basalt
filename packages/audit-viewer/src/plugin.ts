import { createToken, ctx, definePlugin, type Container } from '@basaltkit/core'
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
      container.singleton(AUDIT_VIEWER, () => new AuditViewer(container.get(AUDIT), options))
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
}

/**
 * Read-only audit routes for the current tenant, requiring a logged-in user
 * (add your own admin guard on top): `GET /audit`, `/audit/stats`,
 * `/audit/:id`, and a browsable HTML page at `/audit/view`.
 */
export function auditViewerRoutes(options: AuditViewerRoutesOptions = {}): BasaltRoute[] {
  const csp = options.csp === false ? undefined : (options.csp ?? auditViewerCsp(options))
  return [
    route({
      method: 'GET',
      url: '/audit',
      meta: { auth: true },
      query: querySchema,
      async handler({ query }) {
        return viewer().page(toQuery(query))
      },
    }),
    route({
      method: 'GET',
      url: '/audit/stats',
      meta: { auth: true },
      query: querySchema,
      async handler({ query }) {
        return viewer().stats(toQuery(query))
      },
    }),
    route({
      method: 'GET',
      url: '/audit/view',
      meta: { auth: true },
      async handler({ reply }) {
        if (csp !== undefined) reply.header('content-security-policy', csp)
        return reply.header('content-type', 'text/html; charset=utf-8').send(auditViewerHtml(options))
      },
    }),
    route({
      method: 'GET',
      url: '/audit/:id',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        const entry = await viewer().get(params.id)
        return entry ?? reply.code(404).send({ error: { code: 'AUDIT_NOT_FOUND', message: 'Entry not found.' } })
      },
    }),
  ]
}
