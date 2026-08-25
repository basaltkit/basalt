import { describe, expect, it } from 'vitest'
import { assertDeliverableUrl, isPrivateIp, resolveAndValidate, WebhookUrlBlockedError } from '../src/index.js'

/**
 * Exhaustive branch coverage for the pure SSRF validators. No network/DNS: every
 * check here is over IP literals or an injected `lookup`, so it is deterministic.
 */
describe('isPrivateIp — IPv4 private/reserved ranges', () => {
  it.each([
    ['0.0.0.0', 'this-network 0/8'],
    ['0.1.2.3', 'this-network 0/8'],
    ['10.0.0.1', 'private 10/8'],
    ['10.255.255.255', 'private 10/8'],
    ['127.0.0.1', 'loopback 127/8'],
    ['127.255.255.254', 'loopback 127/8'],
    ['169.254.0.1', 'link-local 169.254/16'],
    ['169.254.169.254', 'cloud metadata'],
    ['172.16.0.1', 'private 172.16/12 (low)'],
    ['172.31.255.255', 'private 172.16/12 (high)'],
    ['192.168.0.1', 'private 192.168/16'],
    ['192.168.255.255', 'private 192.168/16'],
    ['100.64.0.1', 'CGNAT 100.64/10 (low)'],
    ['100.127.255.255', 'CGNAT 100.64/10 (high)'],
    ['192.0.0.1', 'IETF protocol assignments 192.0.0/24'],
    ['198.18.0.1', 'benchmarking 198.18/16'],
    ['198.19.255.255', 'benchmarking 198.19/16'],
    ['224.0.0.1', 'multicast 224/4'],
    ['239.255.255.255', 'multicast 224/4'],
    ['240.0.0.1', 'reserved 240/4'],
    ['255.255.255.255', 'broadcast'],
  ])('treats %s as private (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it.each([
    ['8.8.8.8', 'public DNS'],
    ['93.184.216.34', 'example.com'],
    ['1.1.1.1', 'public DNS'],
    ['172.15.0.1', 'just below the 172.16/12 block'],
    ['172.32.0.1', 'just above the 172.16/12 block'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.1', 'just above CGNAT'],
    ['192.0.1.1', 'just outside 192.0.0/24'],
    ['198.17.0.1', 'just below benchmarking'],
    ['198.20.0.1', 'just above benchmarking'],
    ['169.253.0.1', 'just below link-local'],
    ['223.255.255.255', 'just below multicast'],
    ['11.0.0.1', 'ordinary public'],
  ])('treats %s as public (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(false)
  })
})

describe('isPrivateIp — IPv6 private/reserved ranges', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'ULA fc00::/7 (fc)'],
    ['fd00::1', 'ULA fc00::/7 (fd)'],
    ['fe80::1', 'link-local fe80::/10'],
    ['fe80::1%eth0', 'link-local with zone id stripped'],
    ['feb0::1', 'link-local high end feb'],
    ['fea0::1', 'link-local fea'],
    ['fe90::1', 'link-local fe9'],
    ['ff02::1', 'multicast ff00::/8'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ])('treats %s as private (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it.each([
    ['2606:2800:220:1:248:1893:25c8:1946', 'public (example.com AAAA)'],
    ['2001:4860:4860::8888', 'public DNS'],
    ['::ffff:8.8.8.8', 'IPv4-mapped public'],
    ['::ffff:93.184.216.34', 'IPv4-mapped public example'],
  ])('treats %s as public (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(false)
  })
})

describe('isPrivateIp — non-literals and malformed input are unsafe', () => {
  it.each([
    ['example.com', 'a hostname is not an IP literal'],
    ['not-an-ip', 'garbage'],
    ['', 'empty string'],
    ['1.2.3', 'too few octets'],
    ['1.2.3.4.5', 'too many octets'],
    ['256.0.0.1', 'octet out of range'],
    ['-1.0.0.0', 'negative octet'],
    ['1.5.0.0.', 'trailing dot / non-integer'],
    ['a.b.c.d', 'non-numeric octets'],
    ['999.999.999.999', 'all octets out of range'],
  ])('treats %s as unsafe (%s)', (value) => {
    expect(isPrivateIp(value)).toBe(true)
  })
})

describe('resolveAndValidate — URL and scheme guards', () => {
  it('rejects a value that is not an absolute URL', async () => {
    await expect(resolveAndValidate('not a url')).rejects.toThrow(/not a valid absolute URL/)
    await expect(resolveAndValidate('/relative/path')).rejects.toBeInstanceOf(WebhookUrlBlockedError)
  })

  it('rejects a disallowed scheme (default allows only http/https)', async () => {
    await expect(resolveAndValidate('ftp://hook.example/x')).rejects.toThrow(/scheme "ftp:" is not allowed/)
    await expect(resolveAndValidate('file:///etc/passwd')).rejects.toThrow(/is not allowed/)
  })

  it('honours a custom allowedSchemes list', async () => {
    await expect(
      resolveAndValidate('http://hook.example', { allowedSchemes: ['https:'], lookup: async () => [{ address: '8.8.8.8' }] }),
    ).rejects.toThrow(/scheme "http:" is not allowed/)
    const ok = await resolveAndValidate('https://hook.example', {
      allowedSchemes: ['https:'],
      lookup: async () => [{ address: '8.8.8.8' }],
    })
    expect(ok.pinned).toEqual({ address: '8.8.8.8', family: 4 })
  })
})

describe('resolveAndValidate — IP-literal hosts', () => {
  it('accepts a public IPv6 literal in brackets and pins it (family 6)', async () => {
    const target = await resolveAndValidate('https://[2606:2800:220:1:248:1893:25c8:1946]/hook')
    expect(target.pinned).toEqual({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 })
  })

  it('refuses a private IPv6 literal in brackets', async () => {
    await expect(resolveAndValidate('https://[::1]/hook')).rejects.toThrow(/private or reserved/)
  })

  it('refuses a private IPv4 literal host', async () => {
    await expect(resolveAndValidate('http://10.0.0.5/hook')).rejects.toThrow(/private or reserved/)
  })
})

describe('resolveAndValidate — DNS resolution failures', () => {
  it('refuses when the resolver throws', async () => {
    await expect(
      resolveAndValidate('https://hook.example', {
        lookup: async () => {
          throw new Error('ENOTFOUND')
        },
      }),
    ).rejects.toThrow(/could not be resolved/)
  })

  it('refuses when the resolver returns no addresses', async () => {
    await expect(resolveAndValidate('https://hook.example', { lookup: async () => [] })).rejects.toThrow(/did not resolve/)
  })

  it('derives the family when the resolver omits it', async () => {
    const target = await resolveAndValidate('https://hook.example', {
      lookup: async () => [{ address: '2001:4860:4860::8888' }],
    })
    expect(target.pinned).toEqual({ address: '2001:4860:4860::8888', family: 6 })
  })
})

describe('assertDeliverableUrl — pass/fail wrapper', () => {
  it('resolves for a public target', async () => {
    await expect(
      assertDeliverableUrl('https://hook.example', { lookup: async () => [{ address: '8.8.8.8' }] }),
    ).resolves.toBeUndefined()
  })

  it('rejects for a private target', async () => {
    await expect(
      assertDeliverableUrl('https://hook.example', { lookup: async () => [{ address: '127.0.0.1' }] }),
    ).rejects.toBeInstanceOf(WebhookUrlBlockedError)
  })
})
