import { describe, expect, it } from 'vitest'
import express, { type Express } from 'express'
import { serve } from '@hono/node-server'
import { Hono, type Context, type Next } from 'hono'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { captureRawBody, EXPRESS, expressPlugin } from '@basaltkit/express'
import { HONO, honoPlugin } from '@basaltkit/hono'
import { driveRoutes } from '../src/routes.js'
import { watchConnection } from '../src/notifications.js'
import type { DriveConnection } from '../src/store.js'
import { connect, harness, type Harness } from './helpers.js'

/**
 * Adapter parity for the drive routes.
 *
 * The routes are built once with `route()` and mounted unchanged on Fastify,
 * Express and Hono. What this suite really checks is the part that used to be
 * *not* neutral: the raw request body. The delivery endpoint declares
 * `rawBody()`, so all three adapters now hand it the exact bytes a signature
 * was computed over — with no wiring at all (BK-029). Each adapter is booted
 * twice: bare, and with an app that brought its own body parsers, because both
 * have to verify the same untouched message. A route that reconstructed the
 * body by re-serialising would pass against one adapter and fail against a
 * real provider on all three.
 */

interface Live {
  url: string
  close: () => Promise<void>
}

async function setup(): Promise<{ h: Harness; routes: ReturnType<typeof driveRoutes>; synced: DriveConnection[][]; notification: ReturnType<Harness['fake']['notificationFor']> }> {
  const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
  const view = await connect(h, { tenantId: 'acme' })
  const watch = await watchConnection(h.drives, view.id, {
    tenantId: 'acme',
    notificationUrl: 'https://app.test/drives/fake/notifications',
  })
  const connections = [(await h.store.find('acme', view.id))!]
  const synced: DriveConnection[][] = []
  const routes = driveRoutes({
    drives: h.drives,
    redirectUri: 'https://app.test/drives/fake/callback',
    meta: {},
    notifications: {
      connections,
      onChange: (matched) => void synced.push([...matched]),
    },
  })
  return { h, routes, synced, notification: h.fake.notificationFor(watch.id) }
}

async function fastifyLive(routes: ReturnType<typeof driveRoutes>): Promise<Live> {
  // No content-type wiring whatsoever: `rawBody()` puts the delivery route in
  // its own parser scope, and the app's JSON parser still serves every other.
  const app = await createApp({ plugins: [fastifyPlugin({ routes })] }).boot()
  const server = app.container.get(FASTIFY)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const address = server.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, close: () => app.shutdown() }
}

async function expressLive(routes: ReturnType<typeof driveRoutes>): Promise<Live> {
  // The plugin builds the app and its parsers, which step aside for the
  // delivery path — nothing to configure.
  const app = await createApp({ plugins: [expressPlugin({ routes })] }).boot()
  const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function honoLive(routes: ReturnType<typeof driveRoutes>): Promise<Live> {
  // Neither the bounded pre-read nor the pre-hooks touch a rawBody() path, so
  // the web Request's own stream still carries the untouched octets.
  const app = await createApp({ plugins: [honoPlugin({ routes })] }).boot()
  const { server, port } = await new Promise<{ server: { close: (cb: () => void) => void }; port: number }>((resolve) => {
    const instance = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
      resolve({ server: instance as unknown as { close: (cb: () => void) => void }, port: info.port }),
    )
  })
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/**
 * Express, on an app that brought its own `express.json()`. Body-parser then
 * consumes the stream before any route runs, so the adapter's `verify` capture
 * is the only place the bytes survive — the one honest per-adapter caveat, and
 * it is a one-liner.
 */
async function expressOwnParserLive(routes: ReturnType<typeof driveRoutes>): Promise<Live> {
  const own: Express = express()
  own.use(express.json({ verify: captureRawBody }))
  const app = await createApp({ plugins: [expressPlugin({ app: own, routes })] }).boot()
  const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * Hono, on an app whose own middleware re-frames the body (a bounded read that
 * puts an equivalent body back). The bytes must still arrive intact.
 */
async function honoOwnMiddlewareLive(routes: ReturnType<typeof driveRoutes>): Promise<Live> {
  const own = new Hono()
  own.use('/drives/*', async (context: Context, next: Next) => {
    if (context.req.method === 'POST') {
      const bytes = new Uint8Array(await context.req.raw.arrayBuffer())
      context.req.raw = new Request(context.req.raw, { body: bytes })
    }
    await next()
  })
  const app = await createApp({ plugins: [honoPlugin({ app: own, routes })] }).boot()
  const { server, port } = await new Promise<{ server: { close: (cb: () => void) => void }; port: number }>((resolve) => {
    const instance = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
      resolve({ server: instance as unknown as { close: (cb: () => void) => void }, port: info.port }),
    )
  })
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const adapters: [string, (routes: ReturnType<typeof driveRoutes>) => Promise<Live>][] = [
  ['fastify', fastifyLive],
  ['express', expressLive],
  ['express (app-supplied parsers)', expressOwnParserLive],
  ['hono', honoLive],
  ['hono (app-supplied middleware)', honoOwnMiddlewareLive],
]

describe.each(adapters)('driveRoutes on the %s adapter', (_name, start) => {
  it('starts the connect flow with the same redirect and the same cookie', async () => {
    const { routes } = await setup()
    const live = await start(routes)
    try {
      const response = await fetch(`${live.url}/drives/fake/connect?label=Drive%20Finance`, { redirect: 'manual' })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toContain('https://fake-drive.test/oauth/authorize')
      const cookie = response.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Secure')
    } finally {
      await live.close()
    }
  })

  it('answers the Dropbox-style challenge as inert text/plain', async () => {
    const { routes } = await setup()
    const live = await start(routes)
    try {
      const response = await fetch(`${live.url}/drives/fake/notifications?challenge=abc123`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('abc123')
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      await live.close()
    }
  })

  it('verifies a notification against the RAW bytes and schedules a sync', async () => {
    const { routes, synced, notification } = await setup()
    const live = await start(routes)
    try {
      const response = await fetch(`${live.url}/drives/fake/notifications`, {
        method: 'POST',
        headers: { ...(notification.headers as Record<string, string>), 'content-type': 'application/json' },
        body: notification.body,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ received: true })
      expect(synced.flat()).toHaveLength(1)
    } finally {
      await live.close()
    }
  })

  it('answers a Graph-style POST validation handshake that carries no body', async () => {
    const { routes, synced } = await setup()
    const live = await start(routes)
    try {
      // Microsoft Graph validates a subscription URL with a POST whose token
      // is in the query and whose body is empty — the subscription does not
      // exist yet, so there is nothing to sign and nothing to look up. The
      // route must answer it without ever asking for bytes.
      const response = await fetch(`${live.url}/drives/fake/notifications?challenge=validation-token-123`, {
        method: 'POST',
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('validation-token-123')
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(synced).toEqual([])
    } finally {
      await live.close()
    }
  })

  it('answers the same handshake when the request declares an empty JSON body', async () => {
    const { routes } = await setup()
    const live = await start(routes)
    try {
      // The same shape with `Content-Length: 0` and a content type, which is
      // what a real Graph validation request looks like on the wire.
      const response = await fetch(`${live.url}/drives/fake/notifications?challenge=tok-2`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'content-length': '0' },
        body: '',
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('tok-2')
    } finally {
      await live.close()
    }
  })

  it('rejects a forged notification with the same flat 400 everywhere', async () => {
    const { routes, synced, notification } = await setup()
    const live = await start(routes)
    try {
      const response = await fetch(`${live.url}/drives/fake/notifications`, {
        method: 'POST',
        headers: {
          ...(notification.headers as Record<string, string>),
          'x-fake-channel-token': 'guessed',
          'content-type': 'application/json',
        },
        body: notification.body,
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('DRIVE_NOTIFICATION_INVALID')
      expect(synced).toEqual([])
    } finally {
      await live.close()
    }
  })
})

describe('with no raw-body wiring at all (BK-029)', () => {
  it('verifies against the untouched bytes on a bare fastifyPlugin', async () => {
    const { routes, synced, notification } = await setup()
    // This is the regression BK-029 closed. Before `rawBody()`, a bare
    // adapter parsed the delivery and the bytes were gone, so the route had
    // to fail closed; now it verifies, and a body whose whitespace and key
    // order no re-serialisation would reproduce still matches.
    const app = await createApp({ plugins: [fastifyPlugin({ routes })] }).boot()
    const server = app.container.get(FASTIFY)
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const response = await fetch(`http://127.0.0.1:${port}/drives/fake/notifications`, {
        method: 'POST',
        headers: { ...(notification.headers as Record<string, string>), 'content-type': 'application/json' },
        body: notification.body,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ received: true })
      expect(synced.flat()).toHaveLength(1)
    } finally {
      await app.shutdown()
    }
  })

  it('answers a Graph handshake even where an app-supplied parser ate the body', async () => {
    const { routes, synced } = await setup()
    // The worst case for the raw body: the app mounted a catch-all parser, so
    // for a *delivery* the bytes are gone. A handshake carries none, so it
    // must be answered anyway — otherwise `watch()` fails with
    // `subscriptionValidationFailed` and the operator hunts the wrong bug.
    const own: Express = express()
    own.use(express.text({ type: () => true }))
    const app = await createApp({ plugins: [expressPlugin({ app: own, routes, onError: () => {} })] }).boot()
    const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/drives/fake/notifications?challenge=tok-3`,
        { method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '0' }, body: '' },
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('tok-3')
      expect(synced).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await app.shutdown()
    }
  })

  it('fails closed when an app-supplied parser ate the bytes and captured nothing', async () => {
    const { routes, synced, notification } = await setup()
    // The residual Express caveat, stated honestly: the app mounted its own
    // `express.json()` with no verify hook, so nothing holds the octets. The
    // route refuses rather than verifying a message nobody sent.
    const own: Express = express()
    own.use(express.json())
    const app = await createApp({ plugins: [expressPlugin({ app: own, routes, onError: () => {} })] }).boot()
    const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const response = await fetch(`http://127.0.0.1:${port}/drives/fake/notifications`, {
        method: 'POST',
        headers: { ...(notification.headers as Record<string, string>), 'content-type': 'application/json' },
        body: notification.body,
      })
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('RAW_BODY_UNAVAILABLE')
      expect(synced).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await app.shutdown()
    }
  })
})
