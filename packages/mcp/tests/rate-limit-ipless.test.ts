import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { route, securityPlugin, type RequestEnricher } from '@basaltkit/http'
import { fastifyPlugin } from '@basaltkit/fastify'
import { MCP, mcpPlugin } from '../src/index.js'

/** Trusts `x-user-id` — a stand-in for authPlugin's enricher. */
const identity = definePlugin({
  name: 'test-identity',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const id = request.headers['x-user-id']
      if (typeof id === 'string') context['user'] = { id }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

// BK-046: a tool called with no caller ip (stdio, McpServer.callTool) used to
// land every caller in the one shared `unknown` bucket.
describe('per-route rate limit on an ip-less tool call', () => {
  it('keys identified callers by identity and keeps anonymous ones in one bucket', async () => {
    const routes = [
      route({ method: 'POST', url: '/export', meta: { mcp: true, rateLimit: { limit: 1, windowMs: 60_000 } }, handler: () => ({ ok: true }) }),
    ]
    const app = await createApp({
      plugins: [
        identity,
        securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false }),
        mcpPlugin({ routes, forwardHeaders: ['x-user-id'] }),
        fastifyPlugin({ routes }),
      ],
    }).boot()
    try {
      const mcp = app.container.get(MCP)
      const call = async (user?: string) =>
        (await mcp.callTool('post_export', {}, user ? { headers: { 'x-user-id': user } } : {})).isError === true
      expect(await call('alice')).toBe(false)
      expect(await call('alice')).toBe(true) // RATE_LIMITED
      expect(await call('bob')).toBe(false)
      expect(await call()).toBe(false)
      expect(await call()).toBe(true)
    } finally {
      await app.shutdown()
    }
  })
})
