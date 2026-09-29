import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, ctx, definePlugin, ensureMetadata, runWithContext, type RequestContext } from '@basaltkit/core'
import { InvalidRouteMetaError, isRouteVisible, runRoute, type HttpReply, type RouteMeta } from '@basaltkit/http'
import { FASTIFY, fastifyPlugin, route, type BasaltRoute, type RequestEnricher, type RouteGuard } from '@basaltkit/fastify'
import {
  CanResourceUnavailableError,
  GATE,
  GLOBAL_SCOPE,
  MemoryAccessStore,
  canResource,
  definePolicy,
  permissionsPlugin,
  type CanResourceInput,
  type PermissionsPluginOptions,
} from '../src/index.js'

/**
 * BK-049 / FA-H04 (GAP-2) · resource-aware `meta.can`.
 *
 * `meta.can: 'projects:update'` is pure RBAC: the guard never passes a
 * resource, so a registered ABAC policy is never consulted. The requirement
 * form `{ permission, resource }` loads the resource in the guard and lets the
 * policy decide. Over-the-wire coverage on every adapter and through MCP tool
 * calls lives in packages/mcp/tests/permissions-can-resource.test.ts.
 */

interface Project {
  id: string
  ownerId: string
}

const projects = new Map<string, Project>([
  ['p-alice', { id: 'p-alice', ownerId: 'alice' }],
  ['p-bob', { id: 'p-bob', ownerId: 'bob' }],
])

const OwnerPolicy = definePolicy<Project>('projects', {
  update: (user, project) => project.ownerId === user.id,
  publish: (user, project) => project.ownerId === user.id,
})

/** Test-only authentication: trusts the x-user-id header. */
const fakeAuth = definePlugin({
  name: 'fake-auth-can-resource',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const id = request.headers['x-user-id']
      if (typeof id === 'string') context.user = { id }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

function harness() {
  const loads: string[] = []
  const inputs: CanResourceInput[] = []
  const load = async (input: CanResourceInput): Promise<Project | null> => {
    inputs.push(input)
    loads.push(input.params.id)
    return projects.get(input.params.id) ?? null
  }
  return { loads, inputs, load }
}

async function boot(routes: BasaltRoute[], extra: Partial<PermissionsPluginOptions> = {}) {
  const store = new MemoryAccessStore()
  await store.grantToUser('alice', ['projects:*'], GLOBAL_SCOPE)
  const denied: string[] = []
  const app = await createApp({
    plugins: [fakeAuth, permissionsPlugin({ store, policies: [OwnerPolicy as never], ...extra }), fastifyPlugin({ routes })],
  }).boot()
  app.hooks.on('permission:denied', ({ permission }) => {
    denied.push(permission)
  })
  const server = app.container.get(FASTIFY)
  const patch = (url: string, user?: string, payload?: unknown) =>
    server.inject({
      method: 'PATCH',
      url,
      ...(user ? { headers: { 'x-user-id': user } } : {}),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    })
  return { app, server, patch, denied }
}

const idParams = z.object({ id: z.string() })

describe('GAP-2 regression — meta.can consults the ABAC policy through a resource requirement', () => {
  // GAP-2a: before, `can: 'projects:update'` let alice (projects:*) update
  // bob's project — the policy never ran. The requirement form must refuse.
  it('GAP-2a: a broad RBAC grant no longer bypasses the ownership policy (403, handler never runs)', async () => {
    const { load } = harness()
    let ran = false
    const { app, patch, denied } = await boot([
      route({
        method: 'PATCH',
        url: '/projects/:id',
        params: idParams,
        meta: { can: { permission: 'projects:update', resource: load } },
        handler: () => {
          ran = true
          return { ok: true }
        },
      }),
    ])
    try {
      const res = await patch('/projects/p-bob', 'alice')
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('PERMISSION_DENIED')
      expect(ran).toBe(false)
      expect(denied).toEqual(['projects:update'])
    } finally {
      await app.shutdown()
    }
  })

  // GAP-2b: the check that used to need `gate.authorize(user, perm, resource)`
  // inside the handler now happens in the guard — and the owner passes.
  it('GAP-2b: the owner is allowed and the handler receives the loaded resource', async () => {
    const { load, loads } = harness()
    const { app, patch } = await boot([
      route({
        method: 'PATCH',
        url: '/projects/:id',
        params: idParams,
        meta: { can: { permission: 'projects:update', resource: load } },
        handler: ({ params }) => ({ updated: params.id, owner: canResource<Project>().ownerId, by: (ctx().user as { id: string }).id }),
      }),
    ])
    try {
      const res = await patch('/projects/p-alice', 'alice')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ updated: 'p-alice', owner: 'alice', by: 'alice' })
      // Loaded once, in the guard — the handler did not reload it.
      expect(loads).toEqual(['p-alice'])
      // The owner needs no RBAC grant: the policy alone decides.
      const bob = await patch('/projects/p-bob', 'bob')
      expect(bob.statusCode).toBe(200)
    } finally {
      await app.shutdown()
    }
  })

  it('GAP-2c: fail-closed — no user in context → 401 before any load', async () => {
    const { load, loads } = harness()
    const { app, patch } = await boot([
      route({ method: 'PATCH', url: '/projects/:id', params: idParams, meta: { can: { permission: 'projects:update', resource: load } }, handler: () => ({ leaked: true }) }),
    ])
    try {
      const res = await patch('/projects/p-alice')
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('AUTH_REQUIRED')
      expect(loads).toEqual([])
    } finally {
      await app.shutdown()
    }
  })

  it('GAP-2d: fail-closed — malformed meta.can (true) is refused, not skipped; a malformed requirement at runtime too', async () => {
    const bad = [
      route({ method: 'GET', url: '/bad', meta: { can: true as never }, handler: () => ({ leaked: true }) }),
      route({ method: 'GET', url: '/bad-req', meta: { can: { permission: 'projects:update' } as never }, handler: () => ({ leaked: true }) }),
    ]
    const store = new MemoryAccessStore()
    const app = await createApp({ plugins: [fakeAuth, permissionsPlugin({ store })] }).boot()
    const guards = ensureMetadata(app.container).get<RouteGuard>('http:guards')
    const enrichers = ensureMetadata(app.container).get<RequestEnricher>('http:enrichers')
    try {
      for (const r of bad) {
        const reply = { header: () => reply, code: () => reply, send: () => undefined, sent: false } as unknown as HttpReply
        const run = runRoute(r, { method: 'GET', url: r.url, headers: { 'x-user-id': 'alice' }, params: {}, query: {}, body: undefined, raw: null }, reply, {
          container: app.container,
          guards,
          enrichers,
        })
        await expect(run).rejects.toMatchObject({ code: 'PERMISSION_META_INVALID' })
      }
    } finally {
      await app.shutdown()
    }
  })
})

describe('resource-aware meta.can · semantics', () => {
  it('a missing resource answers 404 by default; notFound: "deny" (per requirement or plugin-wide) answers an audited 403', async () => {
    const { load } = harness()
    const routes = [
      route({ method: 'PATCH', url: '/a/:id', params: idParams, meta: { can: { permission: 'projects:update', resource: load } }, handler: () => ({}) }),
      route({ method: 'PATCH', url: '/b/:id', params: idParams, meta: { can: { permission: 'projects:update', resource: load, notFound: 'deny' } }, handler: () => ({}) }),
    ]
    const first = await boot(routes)
    try {
      const notFound = await first.patch('/a/nope', 'alice')
      expect(notFound.statusCode).toBe(404)
      expect(notFound.json().error.code).toBe('RESOURCE_NOT_FOUND')
      expect(first.denied).toEqual([])
      const deny = await first.patch('/b/nope', 'alice')
      expect(deny.statusCode).toBe(403)
      expect(deny.json().error.code).toBe('PERMISSION_DENIED')
      expect(first.denied).toEqual(['projects:update'])
    } finally {
      await first.app.shutdown()
    }
    const second = await boot(routes, { resourceNotFound: 'deny' })
    try {
      expect((await second.patch('/a/nope', 'alice')).statusCode).toBe(403)
    } finally {
      await second.app.shutdown()
    }
  })

  it('a loader that throws propagates its error (never swallowed into an allow)', async () => {
    const { app, patch } = await boot([
      route({
        method: 'PATCH',
        url: '/projects/:id',
        params: idParams,
        meta: {
          can: {
            permission: 'projects:update',
            resource: () => {
              throw Object.assign(new Error('db down'), { code: 'DB_DOWN' })
            },
          },
        },
        handler: () => ({ leaked: true }),
      }),
    ])
    try {
      const res = await patch('/projects/p-alice', 'alice')
      expect(res.statusCode).toBe(500)
      expect(res.body).not.toContain('leaked')
    } finally {
      await app.shutdown()
    }
  })

  it('the loader gets the parsed params/query/body, the user, the tenant and the container; invalid input is a 400 before any load', async () => {
    const { load, inputs } = harness()
    const { app, server } = await boot([
      route({
        method: 'PATCH',
        url: '/projects/:id',
        params: z.object({ id: z.string().min(3) }),
        query: z.object({ dry: z.coerce.boolean().optional() }),
        body: z.object({ name: z.string() }),
        meta: { can: { permission: 'projects:update', resource: load } },
        handler: ({ body }) => ({ renamed: body.name }),
      }),
    ])
    try {
      const ok = await server.inject({ method: 'PATCH', url: '/projects/p-alice?dry=1', headers: { 'x-user-id': 'alice' }, payload: { name: 'x' } })
      expect(ok.json()).toEqual({ renamed: 'x' })
      const input = inputs[0]!
      expect(input.params).toEqual({ id: 'p-alice' })
      expect(input.query).toEqual({ dry: true })
      expect(input.body).toEqual({ name: 'x' })
      expect(input.user).toEqual({ id: 'alice' })
      expect(input.tenant).toBeUndefined()
      expect(input.container.get(GATE)).toBeDefined()
      expect(input.route.url).toBe('/projects/:id')

      const invalid = await server.inject({ method: 'PATCH', url: '/projects/p', headers: { 'x-user-id': 'alice' }, payload: { name: 'x' } })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json().error.part).toBe('params')
      expect(inputs).toHaveLength(1)
    } finally {
      await app.shutdown()
    }
  })

  it('array form: plain permissions are checked first (no load for an RBAC refusal), then every requirement; a shared loader runs once', async () => {
    const { load, loads } = harness()
    let seen: unknown
    const { app, patch } = await boot([
      route({
        method: 'PATCH',
        url: '/projects/:id',
        params: idParams,
        meta: {
          can: ['projects:update', { permission: 'projects:update', resource: load }, { permission: 'projects:publish', resource: load }],
        },
        handler: () => {
          seen = [canResource('projects:update'), canResource('projects:publish'), canResource()]
          return { ok: true }
        },
      }),
    ])
    try {
      // bob owns p-bob but holds no RBAC grant: the plain entry refuses first.
      const bob = await patch('/projects/p-bob', 'bob')
      expect(bob.statusCode).toBe(403)
      expect(loads).toEqual([])
      // alice holds projects:* and owns p-alice: every entry passes, one load.
      const alice = await patch('/projects/p-alice', 'alice')
      expect(alice.statusCode).toBe(200)
      expect(loads).toEqual(['p-alice'])
      expect(seen).toEqual([projects.get('p-alice'), projects.get('p-alice'), projects.get('p-alice')])
      // alice's grant does not cover bob's project: the policy refuses.
      expect((await patch('/projects/p-bob', 'alice')).statusCode).toBe(403)
    } finally {
      await app.shutdown()
    }
  })

  it('canResource(): asks for the permission when requirements resolved different resources; fails loud when none was resolved', async () => {
    const other = async () => ({ id: 'other', ownerId: 'alice' })
    const { load } = harness()
    const errors: unknown[] = []
    const { app, patch } = await boot([
      route({
        method: 'PATCH',
        url: '/two/:id',
        params: idParams,
        meta: { can: [{ permission: 'projects:update', resource: load }, { permission: 'projects:publish', resource: other }] },
        handler: () => {
          try {
            canResource()
          } catch (error) {
            errors.push(error)
          }
          return { update: canResource<Project>('projects:update').id, publish: canResource<Project>('projects:publish').id }
        },
      }),
      route({
        method: 'PATCH',
        url: '/plain/:id',
        params: idParams,
        meta: { can: 'projects:update' },
        handler: () => {
          try {
            canResource()
          } catch (error) {
            errors.push(error)
          }
          try {
            canResource('projects:update')
          } catch (error) {
            errors.push(error)
          }
          return {}
        },
      }),
    ])
    try {
      expect((await patch('/two/p-alice', 'alice')).json()).toEqual({ update: 'p-alice', publish: 'other' })
      await patch('/plain/p-alice', 'alice')
      expect(errors).toHaveLength(3)
      for (const error of errors) expect(error).toBeInstanceOf(CanResourceUnavailableError)
      expect(() => canResource()).toThrow(CanResourceUnavailableError)
    } finally {
      await app.shutdown()
    }
  })

  it('onMissingPolicy: "rbac" boots a requirement without a policy, and the guard answers from RBAC (still loading, still 404)', async () => {
    const { load, loads } = harness()
    const { app, patch } = await boot(
      [route({ method: 'PATCH', url: '/projects/:id', params: idParams, meta: { can: { permission: 'reports:read', resource: load } }, handler: () => ({ ok: true }) })],
      { onMissingPolicy: 'rbac' },
    )
    try {
      await app.container.get(GATE).grantToUser('carol', ['reports:read'], GLOBAL_SCOPE)
      expect((await patch('/projects/p-bob', 'carol')).statusCode).toBe(200)
      expect((await patch('/projects/p-bob', 'bob')).statusCode).toBe(403)
      expect((await patch('/projects/none', 'carol')).statusCode).toBe(404)
      expect(loads).toEqual(['p-bob', 'p-bob', 'none'])
    } finally {
      await app.shutdown()
    }
  })

  it('is typed: RouteMeta accepts the requirement form, a string, and a mixed array', () => {
    const one: RouteMeta = { can: { permission: 'projects:update', resource: async () => ({ ownerId: 'x' }) } }
    const mixed: RouteMeta = { can: ['projects:read', { permission: 'projects:update', resource: () => null, notFound: 'deny' }] }
    // @ts-expect-error notFound is 'not-found' | 'deny'
    const wrong: RouteMeta = { can: { permission: 'projects:update', resource: () => null, notFound: 'gone' } }
    expect([one, mixed, wrong]).toHaveLength(3)
  })
})

describe('resource-aware meta.can · boot validation (http:meta-validators)', () => {
  const noop = () => ({})
  const load = async () => ({ ownerId: 'x' })

  async function bootError(meta: Record<string, unknown>, options: Partial<PermissionsPluginOptions> = {}) {
    const routes = [route({ method: 'GET', url: '/r', meta, handler: noop })]
    return createApp({
      plugins: [permissionsPlugin({ store: new MemoryAccessStore(), policies: [OwnerPolicy as never], ...options }), fastifyPlugin({ routes })],
    })
      .boot()
      .then(
        async (app) => {
          await app.shutdown()
          return undefined
        },
        (error: unknown) => error,
      )
  }

  it('refuses a malformed requirement: missing/invalid loader, bad permission, unknown key, bad notFound, bad array entry', async () => {
    const cases: [unknown, RegExp][] = [
      [{ permission: 'projects:update' }, /resource must be a loader function/],
      [{ permission: 'projects:update', resource: 'load' }, /resource must be a loader function/],
      [{ permission: 'projects: update', resource: load }, /permission must be a non-empty string/],
      [{ permission: 'projects:update', resource: load, resolve: load }, /unknown key\(s\) "resolve"/],
      [{ permission: 'projects:update', resource: load, notFound: 'gone' }, /notFound must be/],
      [['projects:read', { permission: 'projects:update', resource: load }, 42], /entry of type number/],
      [['', { permission: 'projects:update', resource: load }], /empty permission string/],
      [[[{ permission: 'projects:update', resource: load }]], /nested array/],
    ]
    for (const [can, message] of cases) {
      const error = await bootError({ can })
      expect(error, JSON.stringify(can)).toBeInstanceOf(InvalidRouteMetaError)
      expect((error as Error).message).toMatch(message)
    }
  })

  it('refuses a requirement whose permission no policy decides — unless onMissingPolicy: "rbac"', async () => {
    const typo = await bootError({ can: { permission: 'projects:updat', resource: load } })
    expect(typo).toBeInstanceOf(InvalidRouteMetaError)
    expect((typo as Error).message).toMatch(/"projects:updat" loads a resource but no policy decides it/)
    expect(await bootError({ can: { permission: 'invoices:update', resource: load } })).toBeInstanceOf(InvalidRouteMetaError)
    expect(await bootError({ can: { permission: 'projects:update:billing', resource: load } })).toBeInstanceOf(InvalidRouteMetaError)
    expect(await bootError({ can: { permission: 'invoices:update', resource: load } }, { onMissingPolicy: 'rbac' })).toBeUndefined()
  })

  it('accepts valid forms, and leaves the string forms to the runtime fail-closed (boots as before)', async () => {
    expect(await bootError({ can: { permission: 'projects:update', resource: load } })).toBeUndefined()
    expect(await bootError({ can: ['projects:read', { permission: 'projects:publish', resource: load, notFound: 'deny' }] })).toBeUndefined()
    expect(await bootError({ can: 'projects:read' })).toBeUndefined()
    expect(await bootError({ can: true })).toBeUndefined()
  })
})

describe('resource-aware meta.can · http:route-visibility never loads', () => {
  it('lists a policy-decided requirement for any authenticated caller, never calls the loader nor the policy, and still gates the plain entries', async () => {
    const store = new MemoryAccessStore()
    await store.grantToUser('alice', ['projects:*'], GLOBAL_SCOPE)
    let policyCalls = 0
    const policy = definePolicy<Project>('projects', {
      update: (user, project) => {
        policyCalls++
        return project.ownerId === user.id
      },
    })
    const app = await createApp({ plugins: [permissionsPlugin({ store, policies: [policy as never] })] }).boot()
    const emitted: string[] = []
    app.hooks.onAny((name) => {
      emitted.push(String(name))
    })
    let loads = 0
    const load = () => {
      loads++
      return { id: 'p', ownerId: 'alice' }
    }
    const visible = (r: BasaltRoute, user?: string) => {
      const context = { ...(user ? { user: { id: user } } : {}), container: app.container } as unknown as RequestContext
      return runWithContext(context, () => isRouteVisible(r, context as Record<string, unknown>, app.container))
    }
    const requirement = route({ method: 'PATCH', url: '/p/:id', meta: { can: { permission: 'projects:update', resource: load } }, handler: () => ({}) })
    const mixed = route({ method: 'PATCH', url: '/m/:id', meta: { can: ['projects:update', { permission: 'projects:update', resource: load }] }, handler: () => ({}) })
    const noPolicy = route({ method: 'PATCH', url: '/n/:id', meta: { can: { permission: 'reports:read', resource: load } }, handler: () => ({}) })
    try {
      expect(await visible(requirement)).toBe(false) // anonymous: the guard would 401
      expect(await visible(requirement, 'bob')).toBe(true) // bob may own a project
      expect(await visible(mixed, 'bob')).toBe(false) // the plain entry needs the grant
      expect(await visible(mixed, 'alice')).toBe(true)
      expect(await visible(noPolicy, 'alice')).toBe(false) // every call would fail (MissingPolicyError)
      expect(loads).toBe(0)
      expect(policyCalls).toBe(0)
      expect(emitted).toEqual([])
    } finally {
      await app.shutdown()
    }
  })

  it('without a policy under onMissingPolicy: "rbac", answers from RBAC like the guard does', async () => {
    const store = new MemoryAccessStore()
    await store.grantToUser('carol', ['reports:read'], GLOBAL_SCOPE)
    const app = await createApp({ plugins: [permissionsPlugin({ store, onMissingPolicy: 'rbac' })] }).boot()
    const r = route({ method: 'GET', url: '/r/:id', meta: { can: { permission: 'reports:read', resource: () => ({}) } }, handler: () => ({}) })
    const visible = (user: string) => {
      const context = { user: { id: user }, container: app.container } as unknown as RequestContext
      return runWithContext(context, () => isRouteVisible(r, context as Record<string, unknown>, app.container))
    }
    try {
      expect(await visible('carol')).toBe(true)
      expect(await visible('dave')).toBe(false)
    } finally {
      await app.shutdown()
    }
  })
})
