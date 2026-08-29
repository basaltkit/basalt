import { describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp, definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { honoPlugin, HONO } from '@basaltkit/hono'
import type { RequestEnricher } from '@basaltkit/http'
import { INVOICES, invoiceRoutes, subscriptionsPlugin, definePlans, FakeBillingGateway } from '../src/index.js'

const plans = definePlans({ pro: { price: 2900, features: {} } })

// Trust x-tenant-id so the routes have a current tenant.
// The invoice routes here run auth: false — this suite tests cross-adapter rendering parity;
// the auth-by-default behavior has its own suite (billing-auth.test.ts).
const tenancy = definePlugin({
  name: 'fake-tenancy',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const id = request.headers['x-tenant-id']
      if (typeof id === 'string') context.tenant = { id }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

const basePlugins = () => [
  tenancy,
  subscriptionsPlugin({ plans, fallbackPlan: 'pro', gateway: new FakeBillingGateway() }),
]

// Seed one finalized invoice for `acme` through the INVOICES service.
async function seed(container: Container): Promise<string> {
  const invoices = container.get(INVOICES)
  const draft = await invoices.draft({
    billableId: 'acme', currency: 'USD', lineItems: [{ description: 'Pro plan', unitAmount: 2900 }],
  })
  await invoices.finalize(draft.id)
  return draft.id
}

type Live = { url: string; close: () => Promise<void>; container: Container }

async function fastifyLive(): Promise<Live> {
  const app = await createApp({ plugins: [...basePlugins(), fastifyPlugin({ routes: invoiceRoutes({ auth: false }) })] }).boot()
  const server = app.container.get(FASTIFY)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { url: `http://127.0.0.1:${port}`, close: () => app.shutdown(), container: app.container }
}

async function expressLive(): Promise<Live> {
  const app = await createApp({ plugins: [...basePlugins(), expressPlugin({ routes: invoiceRoutes({ auth: false }) })] }).boot()
  const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())), container: app.container }
}

async function honoLive(): Promise<Live> {
  const app = await createApp({ plugins: [...basePlugins(), honoPlugin({ routes: invoiceRoutes({ auth: false }) })] }).boot()
  const { server, port } = await new Promise<{ server: { close: (cb: () => void) => void }; port: number }>((resolve) => {
    const s = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
      resolve({ server: s as unknown as { close: (cb: () => void) => void }, port: info.port }),
    )
  })
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())), container: app.container }
}

const adapters: Array<[string, () => Promise<Live>]> = [
  ['fastify', fastifyLive],
  ['express', expressLive],
  ['hono', honoLive],
]

describe.each(adapters)('invoiceRoutes on the %s adapter', (_name, start) => {
  it('lists the tenant invoices and renders HTML — identically', async () => {
    const live = await start()
    try {
      await seed(live.container)
      const h = { 'x-tenant-id': 'acme' }

      const list = await fetch(`${live.url}/billing/invoices`, { headers: h })
      expect(list.status).toBe(200)
      const body = (await list.json()) as { data: Array<{ id: string; number: string; total: number }> }
      expect(body.data).toHaveLength(1)
      expect(body.data[0]!.total).toBe(2900)
      const id = body.data[0]!.id

      const html = await fetch(`${live.url}/billing/invoices/${id}/html`, { headers: h })
      expect(html.headers.get('content-type')).toContain('text/html')
      expect(await html.text()).toContain('acme')

      // another tenant cannot read acme's invoice → 404
      const forbidden = await fetch(`${live.url}/billing/invoices/${id}`, { headers: { 'x-tenant-id': 'other' } })
      expect(forbidden.status).toBe(404)
    } finally {
      await live.close()
    }
  })
})
