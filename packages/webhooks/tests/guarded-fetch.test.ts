import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createGuardedFetch,
  GuardedFetchError,
  hostAllowed,
  type GuardedFetchOptions,
  type GuardedTransport,
} from '../src/index.js'

const PUBLIC = '93.184.216.34'
const SECRET_QUERY = 'sig=PRESIGNED_SECRET_TOKEN'

/** Resolves `*.internal.test` to a private address and everything else to a public one. */
const lookup: NonNullable<GuardedFetchOptions['lookup']> = async (host) =>
  host.endsWith('internal.test') ? [{ address: '10.0.0.5', family: 4 }] : [{ address: PUBLIC, family: 4 }]

interface Seen {
  url: string
  headers: Record<string, string>
}

function transportFrom(
  handler: (url: URL) => { status: number; headers?: Record<string, string>; body?: Readable | string },
  seen: Seen[] = [],
): GuardedTransport {
  return async (url, init) => {
    seen.push({ url: url.toString(), headers: init.headers })
    const reply = handler(url)
    const body = reply.body instanceof Readable ? reply.body : Readable.from([Buffer.from(reply.body ?? '')])
    return { status: reply.status, headers: reply.headers ?? {}, body }
  }
}

const base = (overrides: Partial<GuardedFetchOptions> = {}): GuardedFetchOptions => ({
  maxBytes: 1024,
  timeoutMs: 2_000,
  lookup,
  ...overrides,
})

const refusal = async (promise: Promise<unknown>): Promise<GuardedFetchError> => {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal')
    },
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(GuardedFetchError)
  // Never the URL — it is routinely a pre-signed credential.
  expect(JSON.stringify({ m: (error as Error).message, d: (error as GuardedFetchError).details })).not.toContain(
    'PRESIGNED_SECRET_TOKEN',
  )
  return error as GuardedFetchError
}

describe('hostAllowed', () => {
  it('matches a .suffix entry on subdomains only', () => {
    expect(hostAllowed('abc.googleusercontent.com', ['.googleusercontent.com'])).toBe(true)
    expect(hostAllowed('evilgoogleusercontent.com', ['.googleusercontent.com'])).toBe(false)
    expect(hostAllowed('googleusercontent.com', ['.googleusercontent.com'])).toBe(false)
    expect(hostAllowed('API.Dropbox.com.', ['api.dropbox.com'])).toBe(true)
  })
})

describe('createGuardedFetch', () => {
  it('streams a public response and never asks for compression', async () => {
    const seen: Seen[] = []
    const fetch = createGuardedFetch(base({ transport: transportFrom(() => ({ status: 200, body: '{"ok":true}' }), seen) }))
    const response = await fetch('https://files.example.com/a.json')
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ ok: true })
    expect(Object.keys(seen[0]!.headers).map((h) => h.toLowerCase())).not.toContain('accept-encoding')
  })

  it('reads bytes with arrayBuffer()', async () => {
    const fetch = createGuardedFetch(base({ transport: transportFrom(() => ({ status: 200, body: 'abc' })) }))
    const bytes = await (await fetch('https://files.example.com/a')).arrayBuffer()
    expect(Buffer.from(bytes).toString()).toBe('abc')
  })

  it('refuses a host outside the allowlist before resolving it', async () => {
    let resolved = 0
    const fetch = createGuardedFetch(
      base({
        allowedHosts: ['.googleusercontent.com'],
        lookup: async (host) => {
          resolved++
          return lookup(host)
        },
        transport: transportFrom(() => ({ status: 200 })),
      }),
    )
    const error = await refusal(fetch(`https://evilgoogleusercontent.com/x?${SECRET_QUERY}`))
    expect(error.kind).toBe('SSRF_BLOCKED')
    expect(error.code).toBe('OUTBOUND_SSRF_BLOCKED')
    expect(error.info.host).toBe('evilgoogleusercontent.com')
    expect(resolved).toBe(0)
  })

  it('refuses the cloud metadata address and an IPv4-mapped private IPv6 literal', async () => {
    const fetch = createGuardedFetch(base({ transport: transportFrom(() => ({ status: 200 })) }))
    expect((await refusal(fetch(`https://169.254.169.254/latest/meta-data?${SECRET_QUERY}`))).kind).toBe('SSRF_BLOCKED')
    expect((await refusal(fetch('https://[::ffff:10.0.0.1]/'))).kind).toBe('SSRF_BLOCKED')
  })

  it('refuses http: unless the scheme is allowed explicitly', async () => {
    const fetch = createGuardedFetch(base({ transport: transportFrom(() => ({ status: 200 })) }))
    expect((await refusal(fetch('http://files.example.com/'))).kind).toBe('SSRF_BLOCKED')
  })

  it('re-validates every redirect hop and refuses one that lands on a private host', async () => {
    const seen: Seen[] = []
    const fetch = createGuardedFetch(
      base({
        transport: transportFrom(
          (url) =>
            url.hostname === 'files.example.com'
              ? { status: 302, headers: { location: `https://db.internal.test/dump?${SECRET_QUERY}` } }
              : { status: 200, body: 'internal' },
          seen,
        ),
      }),
    )
    const error = await refusal(fetch('https://files.example.com/start'))
    expect(error.kind).toBe('SSRF_BLOCKED')
    expect(error.info.host).toBe('db.internal.test')
    // The private host was never contacted.
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(['files.example.com'])
  })

  it('caps the redirect chain', async () => {
    const fetch = createGuardedFetch(
      base({
        maxRedirects: 2,
        transport: transportFrom((url) => ({ status: 302, headers: { location: `https://a${url.pathname.length}.example.com/x` } })),
      }),
    )
    const error = await refusal(fetch('https://files.example.com/'))
    expect(error.kind).toBe('TOO_MANY_REDIRECTS')
  })

  it('drops credentials on a redirect to another host', async () => {
    const seen: Seen[] = []
    const fetch = createGuardedFetch(
      base({
        transport: transportFrom(
          (url) => (url.hostname === 'api.example.com' ? { status: 302, headers: { location: 'https://cdn.example.com/f' } } : { status: 200, body: 'x' }),
          seen,
        ),
      }),
    )
    await (await fetch('https://api.example.com/f', { headers: { Authorization: 'Bearer t', Cookie: 'c=1', 'x-keep': '1' } })).text()
    expect(seen[0]!.headers['Authorization']).toBe('Bearer t')
    expect(seen[1]!.headers).toEqual({ 'x-keep': '1' })
  })

  it('cuts an oversized body off mid-stream instead of reading it all', async () => {
    let produced = 0
    const endless = new Readable({
      read() {
        produced += 256
        this.push(Buffer.alloc(256))
        if (produced >= 1024 * 1024) this.push(null)
      },
    })
    const fetch = createGuardedFetch(base({ maxBytes: 4096, transport: transportFrom(() => ({ status: 200, body: endless })) }))
    const response = await fetch('https://files.example.com/big')
    const error = await refusal(response.text())
    expect(error.kind).toBe('BODY_TOO_LARGE')
    expect(error.info.maxBytes).toBe(4096)
    expect(produced).toBeLessThan(64 * 1024)
  })

  it('hands every refusal to mapError', async () => {
    class Mine extends Error {}
    const fetch = createGuardedFetch(
      base({ mapError: (e) => new Mine(e.kind), transport: transportFrom(() => ({ status: 200 })) }),
    )
    await expect(fetch('https://169.254.169.254/')).rejects.toThrow(Mine)
  })

  it('times out a hop that never sends headers', async () => {
    const fetch = createGuardedFetch(base({ timeoutMs: 50, transport: () => new Promise(() => {}) }))
    expect((await refusal(fetch('https://files.example.com/slow'))).kind).toBe('TIMEOUT')
  })
})

describe('createGuardedFetch over a real socket', () => {
  let server: http.Server
  let origin: string

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/big') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(Buffer.alloc(200_000))
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`accept-encoding=${request.headers['accept-encoding'] ?? 'none'}`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('refuses loopback by default and reaches it only through the explicit escape hatch', async () => {
    const strict = createGuardedFetch({ maxBytes: 1024, timeoutMs: 2_000, allowedSchemes: ['http'] })
    expect((await refusal(strict(`${origin}/`))).kind).toBe('SSRF_BLOCKED')

    const open = createGuardedFetch({ maxBytes: 1024, timeoutMs: 2_000, allowedSchemes: ['http:'], allowPrivateHosts: true })
    expect(await (await open(`${origin}/`)).text()).toBe('accept-encoding=none')
  })

  it('aborts an oversized download on the wire', async () => {
    const fetch = createGuardedFetch({ maxBytes: 10_000, timeoutMs: 2_000, allowedSchemes: ['http:'], allowPrivateHosts: true })
    const response = await fetch(`${origin}/big`)
    expect((await refusal(response.arrayBuffer())).kind).toBe('BODY_TOO_LARGE')
  })
})
