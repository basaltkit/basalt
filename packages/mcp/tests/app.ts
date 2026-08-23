import { ctx, definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import { HttpError, route, type BasaltRoute, type RequestEnricher } from '@basaltkit/http'
import { z } from 'zod'
import { mcpPlugin, mcpRoutes } from '../src/index.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    tenant?: { id: string }
  }
}

/** A tiny in-memory domain so tool calls exercise real handler logic. */
export function makeRoutes() {
  const store = new Map<string, { id: string; name: string; tenant: string | null }>()
  let seq = 0
  const routes: BasaltRoute[] = [
    route({
      method: 'POST',
      url: '/projects',
      meta: { mcp: true },
      body: z.object({ name: z.string().min(3) }),
      async handler({ body }) {
        const id = `p${++seq}`
        const project = { id, name: body.name, tenant: ctx().tenant?.id ?? null }
        store.set(id, project)
        return project
      },
    }),
    route({
      method: 'GET',
      url: '/projects/:id',
      meta: { mcp: { name: 'get_project', description: 'Fetch a project by id' } },
      params: z.object({ id: z.string() }),
      async handler({ params }) {
        const project = store.get(params.id)
        if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
        return project
      },
    }),
    // Reads the tenant from context — proves headers propagate into tool calls.
    route({
      method: 'GET',
      url: '/whoami',
      meta: { mcp: true },
      async handler() {
        return { tenant: ctx().tenant?.id ?? null }
      },
    }),
    // NOT opted in — must never surface as a tool.
    route({
      method: 'GET',
      url: '/secret',
      async handler() {
        return { secret: 42 }
      },
    }),
  ]
  return routes
}

/** Trust `x-tenant-id` so tenancy can be asserted end-to-end. */
export const tenancy = definePlugin({
  name: 'test-tenancy',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const id = request.headers['x-tenant-id']
      if (typeof id === 'string') context.tenant = { id }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

export function basePlugins(routes: BasaltRoute[]) {
  return [tenancy, mcpPlugin({ routes, serverInfo: { name: 'test-app', version: '9.9.9' } })]
}

export { mcpRoutes }
export type { Container }
