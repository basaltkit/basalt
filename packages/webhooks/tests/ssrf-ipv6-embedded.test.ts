import { describe, expect, it, vi } from 'vitest'
import { isPrivateIp, resolveAndValidate, WebhookDeliverer, WebhookUrlBlockedError } from '../src/index.js'

/**
 * SECURITY INVARIANT: an IPv6 literal that embeds or maps onto a private IPv4
 * address (IPv4-mapped, IPv4-compatible, IPv4-translated, NAT64, 6to4) — in any
 * spelling, including the hex form WHATWG URL canonicalises to — is treated as
 * private, so the SSRF guard cannot be bypassed through an IPv6 literal.
 */
describe('SSRF guard — IPv6 forms that embed a private IPv4 are refused', () => {
  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
    'http://[0000:0000:0000:0000:0000:FFFF:0A00:0001]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[64:ff9b::127.0.0.1]/',
    'http://[64:ff9b:1::1]/',
    'http://[::127.0.0.1]/',
    'http://[::7f00:1]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[2002:7f00:1::]/',
    'http://[2002:a9fe:a9fe::1]/',
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
    'http://[100::1]/',
    'http://[fec0::1]/',
    'http://[2001:db8::1]/',
  ])('refuses %s', async (url) => {
    await expect(resolveAndValidate(url)).rejects.toBeInstanceOf(WebhookUrlBlockedError)
  })

  it.each([
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::ffff:a00:1',
    '::ffff:c0a8:101',
    '64:ff9b::a9fe:a9fe',
    '2002:c0a8:101::',
    '::a00:1',
  ])('isPrivateIp(%s) is true', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it.each(['::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'])(
    'still accepts the public address %s',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false)
    },
  )

  it('refuses a hostname whose AAAA record is an IPv4-mapped loopback in hex form', async () => {
    await expect(
      resolveAndValidate('https://hook.example', { lookup: async () => [{ address: '::ffff:7f00:1', family: 6 }] }),
    ).rejects.toThrow(/private address/)
  })

  it('the deliverer never connects to an IPv4-mapped metadata literal', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response)
    const deliverer = new WebhookDeliverer({ fetchImpl, sleep: async () => {}, secret: 'whsec_0123456789abcdef0123' })
    const result = await deliverer.deliver(
      { id: 'x', url: 'http://[::ffff:169.254.169.254]/latest/meta-data/', events: ['*'] },
      'e',
      {},
    )
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
