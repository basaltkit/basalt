import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { rawBody, route, type BasaltRoute } from '@basaltkit/http'
import express, { type Express, type Request, type Response } from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { captureRawBody, EXPRESS, expressPlugin } from '../src/index.js'

/**
 * Express is the adapter where the neutral marker alone cannot win.
 *
 * `expressPlugin` mounts `express.json()` on the whole app, so by the time a
 * route runs the body may already have been read. What the adapter does about
 * it — a `type` filter that steps aside for rawBody() paths, and a `verify`
 * capture as a second line — is what this file pins down, including the one
 * case that still fails closed.
 */

const hook = (): BasaltRoute =>
  route({
    method: 'POST',
    url: '/hook',
    body: rawBody({ maxBytes: 1024 }),
    handler: ({ body }) => ({ hex: body.bytes.toString('hex'), type: body.contentType ?? null }),
  })

const json = (): BasaltRoute =>
  route({ method: 'POST', url: '/json', body: z.object({ a: z.number() }), handler: ({ body }) => body })

let app: BasaltApp | undefined
let server: Server | undefined

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  await app?.shutdown()
  server = undefined
  app = undefined
})

async function boot(routes: BasaltRoute[], own?: Express): Promise<string> {
  app = await createApp({
    plugins: [expressPlugin({ routes, onError: () => {}, ...(own ? { app: own } : {}) })],
  }).boot()
  server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const AWKWARD = '{  "z" : 1.50,\n\t"a":"x" }'

const post = (base: string, path: string, body: string, type = 'application/json') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': type }, body })

describe('rawBody() on the app expressPlugin builds', () => {
  it('leaves the body unread, so the handler sees the exact bytes', async () => {
    const base = await boot([hook(), json()])
    const res = await post(base, '/hook', AWKWARD)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      hex: Buffer.from(AWKWARD, 'utf8').toString('hex'),
      type: 'application/json',
    })
  })

  it('still parses and validates every other route', async () => {
    const base = await boot([hook(), json()])
    expect(await (await post(base, '/json', '{"a":1}')).json()).toEqual({ a: 1 })
    expect((await post(base, '/json', '{"a":"x"}')).status).toBe(400)
  })

  it('steps aside for urlencoded on a rawBody() route, and keeps parsing it elsewhere', async () => {
    const form = route({
      method: 'POST',
      url: '/form',
      body: z.object({ a: z.string() }),
      handler: ({ body }) => body,
    })
    const base = await boot([hook(), form])
    const raw = await post(base, '/hook', 'a=1&b=2', 'application/x-www-form-urlencoded')
    expect(await raw.json()).toEqual({
      hex: Buffer.from('a=1&b=2').toString('hex'),
      type: 'application/x-www-form-urlencoded',
    })
    const parsed = await post(base, '/form', 'a=1', 'application/x-www-form-urlencoded')
    expect(await parsed.json()).toEqual({ a: '1' })
  })

  it('does not mount the rawBody machinery at all when no route asks for it', async () => {
    // The parsers stay exactly as they were: same behaviour, no per-request
    // path matching, no buffer kept alive past parsing.
    const base = await boot([json()])
    expect(await (await post(base, '/json', '{"a":1}')).json()).toEqual({ a: 1 })
  })
})

describe('rawBody() on an app that brought its own parsers', () => {
  it('works when the app used captureRawBody as its verify hook', async () => {
    const own = express()
    own.use(express.json({ verify: captureRawBody }))
    const base = await boot([hook()], own)
    expect(await (await post(base, '/hook', AWKWARD)).json()).toEqual({
      hex: Buffer.from(AWKWARD, 'utf8').toString('hex'),
      type: 'application/json',
    })
  })

  it('works with the plain `req.rawBody` convention many apps already use', async () => {
    const own = express()
    own.use(
      express.json({
        verify: (req: Request & { rawBody?: Buffer }, _res: Response, buf: Buffer) => {
          req.rawBody = buf
        },
      }),
    )
    const base = await boot([hook()], own)
    expect(await (await post(base, '/hook', AWKWARD)).json()).toEqual({
      hex: Buffer.from(AWKWARD, 'utf8').toString('hex'),
      type: 'application/json',
    })
  })

  it('fails closed — never with reconstructed bytes — when nothing captured them', async () => {
    // The honest caveat: an app-supplied `express.json()` with no verify hook
    // consumes the body before any Basalt route runs, and the bytes are gone.
    // The route must say so; a re-serialised body would verify a message
    // nobody sent.
    const own = express()
    own.use(express.json())
    const base = await boot([hook()], own)
    const res = await post(base, '/hook', AWKWARD)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('RAW_BODY_UNAVAILABLE')
    expect(body.error.message).toContain('body parser')
  })
})
