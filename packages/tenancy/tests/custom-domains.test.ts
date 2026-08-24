import { describe, it, expect } from 'vitest'
import { CustomDomains, MemoryDomainStore, DomainTakenError } from '../src/index.js'

const opts = (txts: Record<string, string[][]>) => ({
  store: new MemoryDomainStore(),
  now: () => 1000,
  token: () => 'tok-123',
  resolveTxt: async (host: string) => txts[host] ?? [],
})

describe('CustomDomains', () => {
  it('registers a domain unverified with a DNS record to publish', async () => {
    const cd = new CustomDomains(opts({}))
    const { record, dns } = await cd.add('acme', 'App.Acme.COM')
    expect(record.domain).toBe('app.acme.com') // normalized
    expect(record.verified).toBe(false)
    expect(dns).toEqual({
      type: 'TXT',
      host: '_basalt-verify.app.acme.com',
      value: 'basalt-domain-verify=tok-123',
    })
  })

  it('rejects a domain already registered', async () => {
    const cd = new CustomDomains(opts({}))
    await cd.add('acme', 'app.acme.com')
    await expect(cd.add('other', 'app.acme.com')).rejects.toBeInstanceOf(DomainTakenError)
  })

  it('does not resolve or verify until the TXT record matches', async () => {
    const cd = new CustomDomains(opts({})) // no TXT published
    await cd.add('acme', 'app.acme.com')
    expect(await cd.verify('app.acme.com')).toBe(false)
    expect(await cd.tenantOf('app.acme.com')).toBeNull() // unverified → no resolution
  })

  it('verifies when the TXT record matches, then resolves to the tenant', async () => {
    const cd = new CustomDomains(
      opts({ '_basalt-verify.app.acme.com': [['basalt-domain-verify=tok-123']] }),
    )
    await cd.add('acme', 'app.acme.com')
    expect(await cd.verify('app.acme.com')).toBe(true)
    expect(await cd.tenantOf('APP.acme.com')).toBe('acme') // verified + case-insensitive
    const list = await cd.list('acme')
    expect(list[0]?.verified).toBe(true)
    expect(list[0]?.verifiedAt).toBe(1000)
  })

  it('handles chunked TXT strings (DNS splits long values)', async () => {
    const cd = new CustomDomains(
      opts({ '_basalt-verify.app.acme.com': [['basalt-domain', '-verify=tok-123']] }),
    )
    await cd.add('acme', 'app.acme.com')
    expect(await cd.verify('app.acme.com')).toBe(true)
  })

  it('removes a domain', async () => {
    const cd = new CustomDomains(opts({}))
    await cd.add('acme', 'app.acme.com')
    await cd.remove('app.acme.com')
    expect(await cd.list('acme')).toEqual([])
  })
})
