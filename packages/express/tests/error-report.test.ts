import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { HttpError, route, type HttpErrorReport } from '@basaltkit/http'
import { EXPRESS, expressPlugin } from '../src/index.js'

/**
 * Sibling of the Fastify and Hono suites — same guarantees, same adapter.
 *
 * This adapter reported NOTHING before: a handler that threw returned 500 to
 * the client and left no trace at all on the server. Whether a failure is
 * visible must not depend on which adapter an app happens to mount.
 */

const routes = [
  route({
    method: 'POST',
    url: '/projects',
    body: z.object({ name: z.string().min(3) }),
    async handler({ body }) {
      return { name: body.name }
    },
  }),
  route({
    method: 'GET',
    url: '/boom',
    async handler() {
      throw new Error('handler exploded')
    },
  }),
  route({
    method: 'GET',
    url: '/teapot',
    async handler() {
      throw new HttpError(418, 'IM_A_TEAPOT', 'short and stout')
    },
  }),
]

let app: BasaltApp
let server: Server
let base: string
const seen: HttpErrorReport[] = []

async function boot() {
  seen.length = 0
  app = await createApp({
    plugins: [expressPlugin({ routes, onError: (r) => void seen.push(r) })] as never,
  }).boot()
  server = app.container.get(EXPRESS).listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await app.shutdown()
})

/** `Response.json()` is `unknown` — the adapters' error body shape, typed once. */
const bodyOf = async (r: Response) => (await r.json()) as { error: { code: string; message: string } }

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('HTTP error reporting on Express', () => {
  it('reports a 500 from a throwing handler', async () => {
    await boot()
    const response = await fetch(`${base}/boom`)
    expect(response.status).toBe(500)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe(500)
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.url).toBe('/boom')
    expect((seen[0]!.error as Error).message).toBe('handler exploded')
    expect((await bodyOf(response)).error.message).toBe('Internal server error.')
  })

  it('reports a 400 from body validation — the case that used to be silent', async () => {
    await boot()
    const response = await post('/projects', { name: 'x' })
    expect(response.status).toBe(400)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe(400)
    expect(seen[0]!.code).toBe((await bodyOf(response)).error.code)
  })

  it('reports a deliberate 4xx thrown as HttpError', async () => {
    await boot()
    expect((await fetch(`${base}/teapot`)).status).toBe(418)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.code).toBe('IM_A_TEAPOT')
  })

  it('says nothing about a request that succeeded', async () => {
    await boot()
    expect((await post('/projects', { name: 'fine' })).status).toBe(200)
    expect(seen).toHaveLength(0)
  })
})
