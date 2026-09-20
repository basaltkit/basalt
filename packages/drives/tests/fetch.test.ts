import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { capStream, createDriveFetch, hostAllowed, parseRetryAfter, type Transport } from '../src/fetch.js'
import { DriveContentTooLargeError, DriveHostNotAllowedError, DriveRateLimitedError } from '../src/errors.js'

/** Every host resolves to one public address unless a test says otherwise. */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

const ok = (body: string, headers: Record<string, string> = {}): ReturnType<Transport> =>
  Promise.resolve({ status: 200, headers, body: Readable.from([Buffer.from(body)]) })

const fetchWith = (transport: Transport, overrides: Partial<Parameters<typeof createDriveFetch>[0]> = {}) =>
  createDriveFetch({
    allowedHosts: ['api.provider.test', '.cdn.provider.test'],
    provider: 'fake',
    lookup: publicLookup,
    transport,
    ...overrides,
  })

describe('hostAllowed', () => {
  it('matches an exact host', () => {
    expect(hostAllowed('api.provider.test', ['api.provider.test'])).toBe(true)
    expect(hostAllowed('other.provider.test', ['api.provider.test'])).toBe(false)
  })

  it('matches subdomains for a dotted entry but not the bare parent', () => {
    expect(hostAllowed('a.cdn.provider.test', ['.cdn.provider.test'])).toBe(true)
    expect(hostAllowed('cdn.provider.test', ['.cdn.provider.test'])).toBe(false)
  })

  it('does not fall for a suffix that is not a subdomain', () => {
    // The bug a naive endsWith() produces: evilcdn.provider.test would pass.
    expect(hostAllowed('evilcdn.provider.test', ['.cdn.provider.test'])).toBe(false)
  })

  it('is case-insensitive and tolerates a trailing root dot', () => {
    expect(hostAllowed('API.Provider.TEST.', ['api.provider.test'])).toBe(true)
  })
})

describe('parseRetryAfter', () => {
  it('reads a seconds value', () => {
    expect(parseRetryAfter('42')).toBe(42_000)
  })

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000)
  })

  it('never reports a negative wait for a date in the past', () => {
    const now = Date.parse('2026-01-01T00:01:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0)
  })

  it('ignores an absent or unparseable value', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
  })
})

describe('capStream', () => {
  it('passes a body under the cap through intact', async () => {
    const chunks: Buffer[] = []
    for await (const chunk of capStream(Readable.from([Buffer.from('hello')]), 100)) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe('hello')
  })

  it('errors past the cap instead of delivering the bytes', async () => {
    const source = Readable.from([Buffer.alloc(10), Buffer.alloc(10)])
    const capped = capStream(source, 15)
    await expect(async () => {
      for await (const _chunk of capped) {
        /* drain */
      }
    }).rejects.toThrow(DriveContentTooLargeError)
  })

  it('destroys the source when it trips, so the socket is released', async () => {
    const source = Readable.from([Buffer.alloc(50)])
    const capped = capStream(source, 10)
    await expect(async () => {
      for await (const _chunk of capped) {
        /* drain */
      }
    }).rejects.toThrow(DriveContentTooLargeError)
    expect(source.destroyed).toBe(true)
  })
})

describe('createDriveFetch — host allowlist', () => {
  it('allows a listed host', async () => {
    const guarded = fetchWith(() => ok('{"ok":true}'))
    await expect(guarded('https://api.provider.test/files').then((r) => r.json())).resolves.toEqual({ ok: true })
  })

  it('refuses an unlisted host before any DNS lookup', async () => {
    const lookup = vi.fn(publicLookup)
    const guarded = fetchWith(() => ok('{}'), { lookup })
    await expect(guarded('https://evil.test/steal')).rejects.toThrow(DriveHostNotAllowedError)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses plain http even for a listed host', async () => {
    const guarded = fetchWith(() => ok('{}'))
    await expect(guarded('http://api.provider.test/files')).rejects.toThrow(DriveHostNotAllowedError)
  })
})

describe('createDriveFetch — SSRF', () => {
  it('refuses a listed host that resolves to a private address', async () => {
    const guarded = fetchWith(() => ok('{}'), { lookup: async () => [{ address: '10.0.0.5', family: 4 }] })
    await expect(guarded('https://api.provider.test/files')).rejects.toThrow(DriveHostNotAllowedError)
  })

  it('reports the refusal as this package’s error, never the guard’s URL-quoting one', async () => {
    // `@basaltkit/webhooks` names the URL it refused, which is right for an
    // endpoint an operator configured and wrong here: the URL being validated
    // is routinely a pre-signed download URL, and this message reaches
    // `drive:sync_failed`, an app's logger and the audit trail.
    const guarded = fetchWith(() => ok('{}'), { lookup: async () => [{ address: '10.0.0.5', family: 4 }] })
    const error = (await guarded('https://api.provider.test/files?sig=SECRET').catch((e: unknown) => e)) as Error
    expect(error.message).not.toContain('SECRET')
    expect(error.message).not.toContain('/files')
    // The host is the diagnostic, and it is not a credential.
    expect(error.message).toContain('api.provider.test')
  })

  it('refuses the cloud metadata address', async () => {
    const guarded = fetchWith(() => ok('{}'), { lookup: async () => [{ address: '169.254.169.254', family: 4 }] })
    await expect(guarded('https://api.provider.test/files')).rejects.toThrow(DriveHostNotAllowedError)
  })

  it('refuses when ANY resolved address is private, not just the first', async () => {
    const guarded = fetchWith(() => ok('{}'), {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    })
    await expect(guarded('https://api.provider.test/files')).rejects.toThrow(DriveHostNotAllowedError)
  })

  it('pins the socket to the validated address', async () => {
    const transport = vi.fn<Transport>(() => ok('{}'))
    const guarded = fetchWith(transport)
    await guarded('https://api.provider.test/files')
    expect(transport.mock.calls[0]?.[2]).toEqual({ address: '93.184.216.34', family: 4 })
  })
})

describe('createDriveFetch — redirects', () => {
  it('re-validates the host at every hop', async () => {
    // The Graph/Drive case: the API answers 302 to a CDN host. A hop to a host
    // outside the allowlist must be refused, not followed.
    const transport: Transport = (url) =>
      url.hostname === 'api.provider.test'
        ? Promise.resolve({ status: 302, headers: { location: 'https://exfil.test/x' }, body: Readable.from([]) })
        : ok('{}')
    await expect(fetchWith(transport)('https://api.provider.test/content')).rejects.toThrow(DriveHostNotAllowedError)
  })

  it('follows a redirect that stays inside the allowlist', async () => {
    const transport: Transport = (url) =>
      url.hostname === 'api.provider.test'
        ? Promise.resolve({
            status: 302,
            headers: { location: 'https://files.cdn.provider.test/blob' },
            body: Readable.from([]),
          })
        : ok('the bytes')
    const response = await fetchWith(transport)('https://api.provider.test/content')
    await expect(response.text()).resolves.toBe('the bytes')
  })

  it('refuses a redirect to a private address even on an allowed host', async () => {
    const transport: Transport = (url) =>
      url.hostname === 'api.provider.test'
        ? Promise.resolve({
            status: 302,
            headers: { location: 'https://inner.cdn.provider.test/blob' },
            body: Readable.from([]),
          })
        : ok('{}')
    const guarded = fetchWith(transport, {
      lookup: async (host) =>
        host === 'api.provider.test' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
    })
    await expect(guarded('https://api.provider.test/content')).rejects.toThrow(DriveHostNotAllowedError)
  })

  it('caps the redirect chain', async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 302,
        headers: { location: 'https://api.provider.test/loop' },
        body: Readable.from([]),
      })
    await expect(fetchWith(transport, { maxRedirects: 2 })('https://api.provider.test/loop')).rejects.toThrow(
      DriveHostNotAllowedError,
    )
  })

  it('does not carry the request body across a redirect', async () => {
    const seen: (string | Buffer | Readable | undefined)[] = []
    const transport: Transport = (url, init) => {
      seen.push(init.body)
      return url.pathname === '/start'
        ? Promise.resolve({ status: 303, headers: { location: 'https://api.provider.test/done' }, body: Readable.from([]) })
        : ok('{}')
    }
    await fetchWith(transport)('https://api.provider.test/start', { method: 'POST', body: 'secret=1' })
    expect(seen).toEqual(['secret=1', undefined])
  })
})

describe('createDriveFetch — rate limiting and caps', () => {
  it('turns 429 into a typed error carrying Retry-After', async () => {
    const transport: Transport = () =>
      Promise.resolve({ status: 429, headers: { 'retry-after': '7' }, body: Readable.from([]) })
    await expect(fetchWith(transport)('https://api.provider.test/files')).rejects.toMatchObject({
      code: 'DRIVE_RATE_LIMITED',
      retryAfterMs: 7000,
    })
  })

  it('treats 503 as rate limiting too', async () => {
    const transport: Transport = () => Promise.resolve({ status: 503, headers: {}, body: Readable.from([]) })
    await expect(fetchWith(transport)('https://api.provider.test/files')).rejects.toThrow(DriveRateLimitedError)
  })

  it('abandons an oversized body mid-stream', async () => {
    const transport: Transport = () => ok('x'.repeat(5000))
    const response = await fetchWith(transport)('https://api.provider.test/big', { maxBytes: 100 })
    await expect(response.text()).rejects.toThrow(DriveContentTooLargeError)
  })

  it('never sends accept-encoding, so a body cannot be a decompression bomb', async () => {
    const transport = vi.fn<Transport>(() => ok('{}'))
    await fetchWith(transport)('https://api.provider.test/files')
    const headers = transport.mock.calls[0]?.[1].headers ?? {}
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('accept-encoding')
  })

  it('passes the timeout down to the transport', async () => {
    const transport = vi.fn<Transport>(() => ok('{}'))
    await fetchWith(transport, { timeoutMs: 1234 })('https://api.provider.test/files')
    expect(transport.mock.calls[0]?.[1].timeoutMs).toBe(1234)
  })
})
