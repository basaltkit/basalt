import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDriveFetch } from '../src/fetch.js'
import { DriveContentTooLargeError } from '../src/errors.js'

/**
 * Exercises the REAL transport — node's http client with the pinned agent
 * lookup — against a loopback server, rather than the injected fake used
 * everywhere else.
 *
 * Loopback is a private address, so these tests necessarily run with
 * `allowPrivateHosts`. That is the point twice over: it proves the production
 * request path works end to end, and it proves the escape hatch is the only
 * way to reach a private host (every other test in `fetch.test.ts` shows the
 * guard refusing one).
 */

let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ hello: 'world' }))
      return
    }
    if (url.pathname === '/echo-method') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ method: request.method, auth: request.headers['authorization'] ?? null }))
      return
    }
    if (url.pathname === '/big') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.alloc(200_000))
      return
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: `${base}/json` })
      response.end()
      return
    }
    if (url.pathname === '/limited') {
      response.writeHead(429, { 'retry-after': '3' })
      response.end()
      return
    }
    if (url.pathname === '/slow') {
      // Accepts the connection, then never finishes: the case a connect-only
      // timeout would miss entirely.
      response.writeHead(200)
      response.write('start')
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const guarded = (overrides: Partial<Parameters<typeof createDriveFetch>[0]> = {}) =>
  createDriveFetch({
    allowedHosts: ['127.0.0.1'],
    provider: 'local',
    // Required to reach loopback at all — see the note above. Cleartext is a
    // separate, explicit opt-in, not a side effect of allowing a private IP.
    allowPrivateHosts: true,
    allowedSchemes: ['http:'],
    ...overrides,
  })

describe('production transport', () => {
  it('performs a real request and parses JSON', async () => {
    const response = await guarded()(`${base}/json`)
    expect(response.ok).toBe(true)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ hello: 'world' })
  })

  it('exposes response headers lowercased', async () => {
    const response = await guarded()(`${base}/json`)
    expect(response.headers['content-type']).toContain('application/json')
    response.destroy()
  })

  it('sends the method and headers it was given', async () => {
    const response = await guarded()(`${base}/echo-method`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-value' },
      body: '{}',
    })
    await expect(response.json()).resolves.toEqual({ method: 'POST', auth: 'Bearer token-value' })
  })

  it('streams a body rather than buffering it', async () => {
    const response = await guarded()(`${base}/big`, { maxBytes: 1_000_000 })
    let total = 0
    for await (const chunk of response.body) total += (chunk as Buffer).length
    expect(total).toBe(200_000)
  })

  it('abandons a real oversized body mid-stream', async () => {
    const response = await guarded()(`${base}/big`, { maxBytes: 1000 })
    await expect(response.text()).rejects.toThrow(DriveContentTooLargeError)
  })

  it('follows a redirect within the allowlist', async () => {
    const response = await guarded()(`${base}/redirect`)
    await expect(response.json()).resolves.toEqual({ hello: 'world' })
  })

  it('reports a real 429 with its Retry-After', async () => {
    await expect(guarded()(`${base}/limited`)).rejects.toMatchObject({
      code: 'DRIVE_RATE_LIMITED',
      retryAfterMs: 3000,
    })
  })

  it('times out a response that never finishes', async () => {
    await expect(async () => {
      const response = await guarded({ timeoutMs: 150 })(`${base}/slow`)
      await response.text()
    }).rejects.toThrow()
  })

  it('still refuses a host outside the allowlist, even with allowPrivateHosts', async () => {
    // The escape hatch relaxes the IP check, NOT the allowlist.
    await expect(guarded()('https://somewhere.else.test/x')).rejects.toMatchObject({
      code: 'DRIVE_HOST_NOT_ALLOWED',
    })
  })
})
