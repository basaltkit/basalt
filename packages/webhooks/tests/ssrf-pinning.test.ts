import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PINNED_ADDRESS,
  pinnedLookup,
  resolveAndValidate,
  WebhookDeliverer,
  WebhookUrlBlockedError,
} from '../src/index.js'
import { pinnedRequest } from '../src/pinned-fetch.js'

const noSleep = async () => {}
const okResponse = (status = 200) => ({ ok: status >= 200 && status < 300, status, type: 'basic' }) as unknown as Response

describe('pinnedLookup', () => {
  it('returns the pinned address for ANY hostname (callback overload), never touching DNS', () => {
    const lookup = pinnedLookup('93.184.216.34', 4)
    const cb = vi.fn()
    // Even asked to resolve a hostname a rebind would point at 127.0.0.1:
    lookup('rebind.attacker.example', {}, cb)
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  })

  it('returns the pinned address as a list when { all: true } is requested', () => {
    const lookup = pinnedLookup('2606:2800:220:1:248:1893:25c8:1946', 6)
    const cb = vi.fn()
    lookup('rebind.attacker.example', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(null, [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }])
  })
})

describe('resolveAndValidate', () => {
  it('pins the first validated public address and returns every checked address', async () => {
    const target = await resolveAndValidate('https://hook.example', {
      lookup: async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
    })
    expect(target.pinned).toEqual({ address: '93.184.216.34', family: 4 })
    expect(target.addresses).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ])
  })

  it('refuses when ANY of multiple A/AAAA records is private (rebind smuggled a second record)', async () => {
    await expect(
      resolveAndValidate('https://hook.example', {
        lookup: async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }],
      }),
    ).rejects.toBeInstanceOf(WebhookUrlBlockedError)
  })

  it('refuses an IPv6 loopback/ULA resolution', async () => {
    await expect(
      resolveAndValidate('https://hook.example', { lookup: async () => [{ address: '::1', family: 6 }] }),
    ).rejects.toThrow(/private address/)
    await expect(
      resolveAndValidate('https://hook.example', { lookup: async () => [{ address: 'fd00::1', family: 6 }] }),
    ).rejects.toThrow(/private address/)
  })

  it('pins an IP-literal host to itself, and refuses a private literal', async () => {
    const target = await resolveAndValidate('https://93.184.216.34/hook')
    expect(target.pinned).toEqual({ address: '93.184.216.34', family: 4 })
    await expect(resolveAndValidate('http://169.254.169.254/latest')).rejects.toThrow(/private or reserved/)
  })

  it('skips pinning for allowPrivateHosts (trusted internal delivery)', async () => {
    const target = await resolveAndValidate('http://10.0.0.5/hook', { allowPrivateHosts: true })
    expect(target.pinned).toBeNull()
  })
})

describe('pinnedRequest — connection follows the pin, not the hostname', () => {
  let server: Server
  let port: number
  let hostHeaderSeen: string | undefined

  beforeEach(async () => {
    hostHeaderSeen = undefined
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hostHeaderSeen = req.headers.host
      req.resume()
      res.statusCode = 200
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('connects to the pinned IP even though the URL hostname is different', async () => {
    // The URL names a host that is NOT an IP and would never resolve here; the
    // pin forces the socket to the local server. This is exactly the rebind case:
    // whatever the hostname resolves to is ignored — only the pin is dialed.
    const url = new URL(`http://webhook.customer.example:${port}/hook`)
    const res = await pinnedRequest(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
      { address: '127.0.0.1', family: 4 },
    )
    expect(res.status).toBe(200)
    // Host header (and thus SNI/vhost) preserved the original hostname.
    expect(hostHeaderSeen).toBe(`webhook.customer.example:${port}`)
  })
})

describe('WebhookDeliverer — rebind is defeated by pinning', () => {
  it('pins the socket to the VALIDATED public IP, never a rebound internal IP', async () => {
    const pins: unknown[] = []
    // fetchImpl stands in for the transport; it records the pin the deliverer
    // hands it. The built-in transport (tested via pinnedRequest) dials exactly
    // this address, so a second, attacker-controlled resolution can't intervene.
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => {
      pins.push((init as unknown as Record<symbol, unknown>)[PINNED_ADDRESS])
      return Promise.resolve(okResponse(200))
    })
    const deliverer = new WebhookDeliverer({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      // Validation-time DNS returns a public IP...
      ssrf: { lookup: async () => [{ address: '93.184.216.34' }] },
    })
    const result = await deliverer.deliver({ id: 'x', url: 'https://rebind.example/hook', events: ['*'] }, 'e', {})
    expect(result.ok).toBe(true)
    // ...and that public IP is exactly what the connection is pinned to. Never 127.0.0.1.
    expect(pins[0]).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('refuses when the resolver hands back a metadata/loopback address, without connecting', async () => {
    const fetchImpl = vi.fn(async () => okResponse(200))
    for (const address of ['169.254.169.254', '127.0.0.1', 'fd00::1']) {
      const deliverer = new WebhookDeliverer({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
        ssrf: { lookup: async () => [{ address }] },
      })
      const result = await deliverer.deliver({ id: 'x', url: 'https://rebind.example/hook', events: ['*'] }, 'e', {})
      expect(result.ok).toBe(false)
      expect(result.attempts).toBe(0)
      expect(result.error).toMatch(/private address/)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
