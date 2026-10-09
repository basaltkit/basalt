import { describe, expect, it } from 'vitest'
import { createApp, ctx, tryCtx } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route } from '@basaltkit/fastify'
import { headerResolver, MemoryTenantSource, TENANCY, tenancyPlugin } from '../src/index.js'

// BK-077: a listener that takes something on 'tenancy:switched' (prismaPlugin
// leases a database client) must be able to give it back when the run ends,
// and to tell a run from an HTTP request, whose resources end with the request.

const source = () => new MemoryTenantSource().add({ id: 'acme', name: 'Acme' }).add({ id: 'globex', name: 'Globex' })

describe("tenancy.run emits 'tenancy:exited' and tags 'tenancy:switched' with `via`", () => {
  const boot = async () => {
    const app = await createApp({
      plugins: [
        tenancyPlugin({ source: source(), resolvers: [headerResolver()] }),
        fastifyPlugin({ routes: [route({ method: 'GET', url: '/x', handler: () => ({ t: ctx().tenant?.id }) })] }),
      ],
    }).boot()
    const events: string[] = []
    app.hooks.on('tenancy:switched', ({ tenant, via }) => void events.push(`switched ${tenant.id} ${via}`))
    app.hooks.on('tenancy:exited', ({ tenant }) =>
      // still inside the tenant context the run entered
      void events.push(`exited ${tenant.id} in ${tryCtx()?.tenant?.id}`),
    )
    return { app, events }
  }

  it('pairs switched/exited for nested runs, inside each run context', async () => {
    const { app, events } = await boot()
    const tenancy = app.container.get(TENANCY)
    const result = await tenancy.run('acme', () => tenancy.run('globex', () => 42))
    expect(result).toBe(42)
    expect(events).toEqual([
      'switched acme run',
      'switched globex run',
      'exited globex in globex',
      'exited acme in acme',
    ])
    await app.shutdown()
  })

  it('emits exited when the callback throws, and keeps the callback error', async () => {
    const { app, events } = await boot()
    app.hooks.on('tenancy:exited', () => {
      throw new Error('cleanup failed')
    })
    await expect(
      app.container.get(TENANCY).run('acme', () => {
        throw new Error('job failed')
      }),
    ).rejects.toThrow('job failed')
    expect(events).toEqual(['switched acme run', 'exited acme in acme'])
    await app.shutdown()
  })

  it("tags the request enricher's switch `via: 'http'`, with no exited", async () => {
    const { app, events } = await boot()
    const res = await app.container.get(FASTIFY).inject({ url: '/x', headers: { 'x-tenant-id': 'acme' } })
    expect(res.json()).toEqual({ t: 'acme' })
    expect(events).toEqual(['switched acme http'])
    await app.shutdown()
  })
})
