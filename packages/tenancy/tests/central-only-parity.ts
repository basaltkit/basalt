/**
 * Cross-adapter suite for central-only routes, `meta: { tenant: 'never' }`
 * (BK-043). Not a test file on its own: tenancy runs it against Fastify, and
 * the Express and Hono adapters run the very same suite from their own parity
 * tests (neither is a dependency of @basaltkit/tenancy), so the three are held
 * to identical assertions.
 *
 * Routes are plain `BasaltRoute`-shaped objects so this file needs nothing
 * from @basaltkit/http at runtime.
 */
import { ctx, definePlugin, ensureMetadata } from '@basaltkit/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { BasaltRoute } from '../../http/src/index.js'
import type { ParityDriver } from '../../http/tests/adapter-parity.js'
import { headerResolver, MemoryTenantSource, tenancyPlugin } from '../src/index.js'

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Route not found.' } }

export function centralOnlyParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: central-only routes, meta.tenant 'never' (BK-043)`, () => {
    afterEach(() => driver.close())

    const log: string[] = []
    const switched: string[] = []

    /** Stands in for auth: a guard that answers 401 to anonymous callers. */
    const signIn = definePlugin({
      name: 'test:sign-in-guard',
      register({ container, hooks }) {
        ensureMetadata(container).add(
          'http:guards',
          ({ route, request }: { route: BasaltRoute; request: { headers: Record<string, unknown> } }) => {
            log.push('guard')
            if (route.meta?.['signedIn'] === true && !request.headers['x-user']) {
              throw Object.assign(new Error('Sign in.'), { status: 401, expose: true })
            }
          },
        )
        hooks.on('tenancy:switched', ({ tenant }) => void switched.push(tenant.id))
      },
    })

    const tenancy = () =>
      tenancyPlugin({
        source: new MemoryTenantSource().add({ id: 'acme', name: 'Acme' }),
        resolvers: [headerResolver()],
        required: true,
      })

    const routes = [
      {
        method: 'GET',
        url: '/platform/plans',
        meta: { tenant: 'never', signedIn: true },
        handler: () => {
          log.push('handler')
          return { plans: [], tenant: ctx().tenant?.id ?? null }
        },
      },
      {
        method: 'GET',
        url: '/account',
        meta: { tenant: false },
        handler: () => ({ tenant: ctx().tenant?.id ?? null }),
      },
    ] as BasaltRoute[]

    const reset = () => {
      log.length = 0
      switched.length = 0
    }

    it('answers a tenant host with the plain not-found body, before any guard, handler or switch', async () => {
      reset()
      const send = await driver.boot(routes, [tenancy(), signIn])

      // Anonymous: a 401 here would confirm the route exists.
      const anonymous = await send({ method: 'GET', url: '/platform/plans', headers: { 'x-tenant-id': 'acme' } })
      expect(anonymous.status).toBe(404)
      expect(anonymous.json).toEqual(NOT_FOUND)

      const signedIn = await send({
        method: 'GET',
        url: '/platform/plans',
        headers: { 'x-tenant-id': 'acme', 'x-user': 'u1' },
      })
      expect(signedIn.status).toBe(404)
      expect(signedIn.json).toEqual(NOT_FOUND)

      // Indistinguishable from a route that does not exist at all.
      const missing = await send({ method: 'GET', url: '/nowhere', headers: { 'x-tenant-id': 'acme' } })
      expect(missing.status).toBe(404)
      expect(anonymous.json).toEqual(missing.json)

      expect(log).toEqual([])
      expect(switched).toEqual([])
    })

    it('serves the apex: no tenant resolves, the guards and the handler run', async () => {
      reset()
      const send = await driver.boot(routes, [tenancy(), signIn])

      const anonymous = await send({ method: 'GET', url: '/platform/plans' })
      expect(anonymous.status).toBe(401)

      const ok = await send({ method: 'GET', url: '/platform/plans', headers: { 'x-user': 'u1' } })
      expect(ok.status).toBe(200)
      expect(ok.json).toEqual({ plans: [], tenant: null })
      expect(log).toEqual(['guard', 'guard', 'handler'])
      expect(switched).toEqual([])
    })

    it('leaves tenant: false alone — it still runs on a tenant host, in that tenant', async () => {
      reset()
      const send = await driver.boot(routes, [tenancy(), signIn])
      const res = await send({ method: 'GET', url: '/account', headers: { 'x-tenant-id': 'acme' } })
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ tenant: 'acme' })
      expect(switched).toEqual(['acme'])
    })

    it('refuses to boot on a meta.tenant value it does not know', async () => {
      const bad = [
        ...routes,
        { method: 'GET', url: '/typo', meta: { tenant: 'none' }, handler: () => 'x' },
        { method: 'POST', url: '/stringly', meta: { tenant: 'false' }, handler: () => 'x' },
      ] as BasaltRoute[]
      const boot = driver.boot(bad, [tenancy(), signIn])
      await expect(boot).rejects.toMatchObject({
        code: 'HTTP_INVALID_ROUTE_META',
        problems: [
          { route: 'GET /typo', problem: `meta.tenant "none" is not valid (expected true, false or 'never')` },
          { route: 'POST /stringly', problem: `meta.tenant "false" is not valid (expected true, false or 'never')` },
        ],
      })
    })
  })
}
