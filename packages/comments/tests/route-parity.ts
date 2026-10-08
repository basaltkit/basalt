/**
 * `commentRoutes()` on every adapter: a `meta` guard passed to the factory is
 * enforced (BK-078), an `authorize` that throws `CommentNotFoundError` answers
 * 404 (BK-080), and an `anchor` round-trips. Not a test file on its own — each
 * adapter package runs it against its own driver, the same way it runs the
 * HTTP parity matrix.
 */
import { definePlugin, ensureMetadata } from '@basaltkit/core'
import { GUARDED_META_BUCKET, HttpError, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParityDriver } from '../../http/tests/adapter-parity.js'
import { CommentNotFoundError, commentRoutes, commentsPlugin, type CommentRoutesOptions } from '../src/index.js'

/**
 * Stands in for @basaltkit/auth + @basaltkit/permissions: the user comes from
 * `x-user`, granted permissions from `x-perms` (comma-separated), and the
 * guards enforce `meta.auth` and `meta.can`.
 */
const identity = () =>
  definePlugin({
    name: 'test:identity',
    register({ container }) {
      const metadata = ensureMetadata(container)
      const enricher: RequestEnricher = ({ request, context }) => {
        const user = request.headers['x-user']
        const perms = request.headers['x-perms']
        const scope = context as unknown as Record<string, unknown>
        if (typeof user === 'string' && user) {
          scope['user'] = { id: user, perms: typeof perms === 'string' ? perms.split(',') : [] }
        }
      }
      const guard: RouteGuard = ({ route, context }) => {
        const user = (context as unknown as { user?: { perms: string[] } }).user
        if (route.meta?.['auth'] === true && !user) throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in.')
        const can = route.meta?.['can']
        if (typeof can === 'string' && !user?.perms.includes(can)) throw new HttpError(403, 'FORBIDDEN', 'Missing permission.')
      }
      metadata.add('http:enrichers', enricher)
      metadata.add('http:guards', guard)
      metadata.add(GUARDED_META_BUCKET, 'auth')
      metadata.add(GUARDED_META_BUCKET, 'can')
    },
  })

export function commentRoutesParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: commentRoutes() parity (BK-078, BK-080)`, () => {
    afterEach(() => driver.close())

    const boot = (options: CommentRoutesOptions = {}) =>
      driver.boot(commentRoutes(options), [identity(), commentsPlugin()])

    const post = (headers: Record<string, string>, payload: Record<string, unknown> = {}) => ({
      method: 'POST',
      url: '/comments',
      headers: { 'content-type': 'application/json', ...headers },
      body: Buffer.from(JSON.stringify({ resourceType: 'doc', resourceId: '12', body: 'hello', ...payload })),
    })

    it('enforces a meta guard passed to the factory', async () => {
      const send = await boot({ meta: { can: 'comments:write' } })
      expect((await send(post({}))).status).toBe(401)
      const refused = await send(post({ 'x-user': 'ana' }))
      expect(refused.status).toBe(403)
      expect((refused.json as { error?: { code?: string } }).error?.code).toBe('FORBIDDEN')
      expect((await send(post({ 'x-user': 'ana', 'x-perms': 'comments:write' }))).status).toBe(201)
    })

    it('answers 404 when authorize throws CommentNotFoundError', async () => {
      const send = await boot({
        authorize: (action, target) => {
          if (target.resourceId === 'secret') throw new CommentNotFoundError()
          return action === 'list' || action === 'create'
        },
      })
      const res = await send({ method: 'GET', url: '/comments?resourceType=doc&resourceId=secret', headers: { 'x-user': 'ana' } })
      expect(res.status).toBe(404)
      expect((res.json as { error?: { code?: string } }).error?.code).toBe('COMMENT_NOT_FOUND')
      const open = await send({ method: 'GET', url: '/comments?resourceType=doc&resourceId=12', headers: { 'x-user': 'ana' } })
      expect(open.status).toBe(200)
    })

    it('round-trips an anchor and refuses an oversized one', async () => {
      const send = await boot()
      const anchor = { page: 3, rect: [1, 2, 3, 4] }
      const created = await send(post({ 'x-user': 'ana' }, { anchor }))
      expect(created.status).toBe(201)
      expect((created.json as { anchor?: unknown }).anchor).toEqual(anchor)
      const tooBig = await send(post({ 'x-user': 'ana' }, { anchor: { s: 'x'.repeat(5000) } }))
      expect(tooBig.status).toBe(400)
      expect((tooBig.json as { error?: { code?: string } }).error?.code).toBe('COMMENT_ANCHOR_INVALID')
    })
  })
}
