import { describe, expect, it } from 'vitest'
import { HookBus, createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { MemoryUserSource, authPlugin, authRoutes } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { COMMENTS, CommentTenantRequiredError, Comments, SINGLE_TENANT_SCOPE, commentRoutes, commentsPlugin } from '../src/index.js'
import type { Comment } from '../src/index.js'

describe('beyond-SaaS: comments does not require tenancy', () => {
  /** Stands in for @basaltkit/tenancy: its only cross-package signal. */
  const fakeTenancyMarker = definePlugin({
    name: 'fake-tenancy-marker',
    register({ container }) {
      ensureMetadata(container).add('tenancy:active', true)
    },
  })

  it('with NO tenancy, the whole thread lifecycle works unscoped', async () => {
    const comments = new Comments()
    const thread = comments.on('note', '1')

    const c = await thread.add({ authorId: 'u1', body: 'first' })
    expect(c.tenantId).toBe(SINGLE_TENANT_SCOPE)
    expect(await thread.list()).toHaveLength(1)
    expect(await thread.tree()).toHaveLength(1)
    expect((await comments.get(c.id))?.body).toBe('first')
    expect((await comments.edit(c.id, 'edited')).body).toBe('edited')
    expect((await comments.resolve(c.id, 'u1')).resolvedBy).toBe('u1')
    expect((await comments.reopen(c.id)).resolvedAt).toBeUndefined()
    await comments.remove(c.id)
    expect(await thread.list()).toHaveLength(0)
  })

  it('with tenancy ACTIVE and no resolvable tenant, it still fails closed', async () => {
    const multiTenant = new Comments({}, () => true)
    expect(() => multiTenant.on('note', '1')).toThrow(CommentTenantRequiredError)
  })

  it('commentsPlugin wires the tenancy signal from the container marker', async () => {
    const single = await createApp({ plugins: [commentsPlugin()] }).boot()
    expect(await single.container.get(COMMENTS).on('note', '1').list()).toEqual([])
    await single.shutdown()

    const multi = await createApp({ plugins: [fakeTenancyMarker, commentsPlugin()] }).boot()
    expect(() => multi.container.get(COMMENTS).on('note', '1')).toThrow(CommentTenantRequiredError)
    await multi.shutdown()
  })
})

describe('Comments service', () => {
  it('adds comments, extracts mentions, and emits events', async () => {
    const hooks = new HookBus()
    const created: Comment[] = []
    const mentioned: string[] = []
    hooks.on('comment:created', (p) => {
      created.push((p as { comment: Comment }).comment)
    })
    hooks.on('comment:mentioned', (p) => {
      mentioned.push((p as { userId: string }).userId)
    })

    const comments = new Comments({ hooks })
    const c = await comments.on('note', '1', 'acme').add({ authorId: 'u1', body: 'hey @u2 and @u3-dev' })

    expect(c.mentions).toEqual(['u2', 'u3-dev'])
    expect(created).toHaveLength(1)
    expect(mentioned).toEqual(['u2', 'u3-dev'])
  })

  it('nests replies into a thread tree', async () => {
    const comments = new Comments()
    const root = await comments.on('note', '1', 'acme').add({ authorId: 'u1', body: 'root' })
    await comments.on('note', '1', 'acme').add({ authorId: 'u2', body: 'reply', parentId: root.id })

    const tree = await comments.on('note', '1', 'acme').tree()
    expect(tree).toHaveLength(1)
    expect(tree[0]!.body).toBe('root')
    expect(tree[0]!.replies.map((r) => r.body)).toEqual(['reply'])
  })

  it('edits (re-extracting mentions), resolves and reopens', async () => {
    const hooks = new HookBus()
    const events: string[] = []
    for (const e of ['comment:updated', 'comment:resolved', 'comment:reopened'] as const)
      hooks.on(e, () => {
        events.push(e)
      })
    const comments = new Comments({ hooks })
    const c = await comments.on('note', '1', 'acme').add({ authorId: 'u1', body: 'first' })

    const edited = await comments.edit(c.id, 'now with @u9', 'acme')
    expect(edited.body).toBe('now with @u9')
    expect(edited.mentions).toEqual(['u9'])
    expect(edited.editedAt).toBeTypeOf('number')

    const resolved = await comments.resolve(c.id, 'u1', 'acme')
    expect(resolved.resolvedAt).toBeTypeOf('number')
    expect(resolved.resolvedBy).toBe('u1')

    const reopened = await comments.reopen(c.id, 'acme')
    expect(reopened.resolvedAt).toBeUndefined()
    expect(events).toEqual(['comment:updated', 'comment:resolved', 'comment:reopened'])
  })

  it('removes a comment and isolates by tenant', async () => {
    const hooks = new HookBus()
    let deleted = false
    hooks.on('comment:deleted', () => {
      deleted = true
    })
    const comments = new Comments({ hooks })
    const acme = await comments.on('note', '1', 'acme').add({ authorId: 'u1', body: 'a' })
    await comments.on('note', '1', 'globex').add({ authorId: 'u9', body: 'b' })

    expect((await comments.on('note', '1', 'acme').list()).map((c) => c.id)).toEqual([acme.id])
    await comments.remove(acme.id, 'acme')
    expect(await comments.get(acme.id, 'acme')).toBeNull()
    expect(deleted).toBe(true)
  })
})

async function makeApp() {
  const source = new MemoryTenantSource().add({ id: 'acme' })
  const app = await createApp({
    plugins: [
      tenancyPlugin({ source, resolvers: [headerResolver()] }),
      authPlugin({ users: new MemoryUserSource(), secret: 'test-secret-value-123456', loginThrottle: false }),
      commentsPlugin(),
      fastifyPlugin({ routes: [...authRoutes(), ...commentRoutes()] }),
    ],
  }).boot()
  return { app, server: app.container.get(FASTIFY) }
}
const tenant = { 'x-tenant-id': 'acme' }
async function login(server: Awaited<ReturnType<typeof makeApp>>['server'], email: string) {
  await server.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } })
  const res = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } })
  return res.json().accessToken as string
}

describe('Comment HTTP flow', () => {
  it('creates, lists, and restricts edits to the author', async () => {
    const { app, server } = await makeApp()
    const ada = await login(server, 'ada@acme.test')
    const bob = await login(server, 'bob@acme.test')

    const created = await server.inject({
      method: 'POST',
      url: '/comments',
      headers: { authorization: `Bearer ${ada}`, ...tenant },
      payload: { resourceType: 'note', resourceId: '1', body: 'hello' },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id as string

    // list returns the thread
    const list = await server.inject({ method: 'GET', url: '/comments?resourceType=note&resourceId=1', headers: { authorization: `Bearer ${ada}`, ...tenant } })
    expect((list.json() as unknown[]).length).toBe(1)

    // bob cannot edit ada's comment
    const denied = await server.inject({ method: 'PATCH', url: `/comments/${id}`, headers: { authorization: `Bearer ${bob}`, ...tenant }, payload: { body: 'hacked' } })
    expect(denied.statusCode).toBe(403)

    // ada can, and can resolve
    expect((await server.inject({ method: 'PATCH', url: `/comments/${id}`, headers: { authorization: `Bearer ${ada}`, ...tenant }, payload: { body: 'edited' } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: `/comments/${id}/resolve`, headers: { authorization: `Bearer ${ada}`, ...tenant } })).json().resolvedBy).toBeTruthy()

    await app.shutdown()
  })
})
