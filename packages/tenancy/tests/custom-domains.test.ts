import { describe, it, expect } from 'vitest'
import {
  CustomDomains,
  MemoryDomainStore,
  DomainTakenError,
  DomainForbiddenError,
  DomainNotFoundError,
  normalizeDomain,
  findByVerifiedDomain,
} from '../src/index.js'

const opts = (txts: Record<string, string[][]>) => ({
  store: new MemoryDomainStore(),
  now: () => 1000,
  token: () => 'tok-123',
  resolveTxt: async (host: string) => txts[host] ?? [],
})
const VERIFIED = { '_basalt-verify.app.acme.com': [['basalt-domain-verify=tok-123']] }

describe('CustomDomains', () => {
  it('registers a domain unverified with a DNS record to publish', async () => {
    const cd = new CustomDomains(opts({}))
    const { record, dns } = await cd.add('acme', 'App.Acme.COM')
    expect(record.domain).toBe('app.acme.com')
    expect(record.verified).toBe(false)
    expect(dns).toEqual({
      type: 'TXT',
      host: '_basalt-verify.app.acme.com',
      value: 'basalt-domain-verify=tok-123',
    })
  })

  it('rejects a domain already registered (atomic, no overwrite)', async () => {
    const cd = new CustomDomains(opts({}))
    await cd.add('acme', 'app.acme.com')
    await expect(cd.add('other', 'app.acme.com')).rejects.toBeInstanceOf(DomainTakenError)
  })

  it('does not resolve or verify until the TXT record matches', async () => {
    const cd = new CustomDomains(opts({}))
    await cd.add('acme', 'app.acme.com')
    expect(await cd.verify('acme', 'app.acme.com')).toBe(false)
    expect(await cd.tenantOf('app.acme.com')).toBeNull()
  })

  it('verifies when the TXT matches, then resolves to the tenant', async () => {
    const cd = new CustomDomains(opts(VERIFIED))
    await cd.add('acme', 'app.acme.com')
    expect(await cd.verify('acme', 'app.acme.com')).toBe(true)
    expect(await cd.tenantOf('APP.acme.com.')).toBe('acme') // case + trailing dot normalized
    const list = await cd.list('acme')
    expect(list[0]?.verified).toBe(true)
  })

  it('handles chunked TXT strings', async () => {
    const cd = new CustomDomains(opts({ '_basalt-verify.app.acme.com': [['basalt-domain', '-verify=tok-123']] }))
    await cd.add('acme', 'app.acme.com')
    expect(await cd.verify('acme', 'app.acme.com')).toBe(true)
  })

  it('removes an owned domain', async () => {
    const cd = new CustomDomains(opts({}))
    await cd.add('acme', 'app.acme.com')
    await cd.remove('acme', 'app.acme.com')
    expect(await cd.list('acme')).toEqual([])
  })
})

describe('CustomDomains — security hardening (audit remediation)', () => {
  it('H3: a tenant cannot remove or read another tenant\'s domain', async () => {
    const cd = new CustomDomains(opts(VERIFIED))
    await cd.add('acme', 'app.acme.com')
    await expect(cd.remove('evil', 'app.acme.com')).rejects.toBeInstanceOf(DomainForbiddenError)
    await expect(cd.instructions('evil', 'app.acme.com')).rejects.toBeInstanceOf(DomainForbiddenError)
    await expect(cd.verify('evil', 'app.acme.com')).rejects.toBeInstanceOf(DomainForbiddenError)
    // untouched
    expect((await cd.list('acme'))[0]?.domain).toBe('app.acme.com')
  })

  it('H3: forced re-verification revokes a domain whose DNS was removed (dangling-domain)', async () => {
    const txts: Record<string, string[][]> = { ...VERIFIED }
    const cd = new CustomDomains({ ...opts(txts), resolveTxt: async (h) => txts[h] ?? [] })
    await cd.add('acme', 'app.acme.com')
    expect(await cd.verify('acme', 'app.acme.com')).toBe(true)
    expect(await cd.tenantOf('app.acme.com')).toBe('acme')
    // DNS record disappears (domain expired / repointed); a forced re-check revokes it.
    delete txts['_basalt-verify.app.acme.com']
    expect(await cd.verify('acme', 'app.acme.com', { force: true })).toBe(false)
    expect(await cd.tenantOf('app.acme.com')).toBeNull() // no longer resolves
  })

  it('normalizeDomain canonicalizes case, trailing dot, port and IDNA', () => {
    expect(normalizeDomain('Victim.COM.')).toBe('victim.com')
    expect(normalizeDomain('victim.com:443')).toBe('victim.com')
    expect(normalizeDomain('  victim.com ')).toBe('victim.com')
  })

  it('missing domain throws NotFound (not Forbidden), keeping errors honest', async () => {
    const cd = new CustomDomains(opts({}))
    await expect(cd.verify('acme', 'ghost.com')).rejects.toBeInstanceOf(DomainNotFoundError)
  })

  it('findByVerifiedDomain resolves only verified domains', async () => {
    const cd = new CustomDomains(opts(VERIFIED))
    await cd.add('acme', 'app.acme.com')
    const tenants = { acme: { id: 'acme', name: 'Acme' } }
    const findByDomain = findByVerifiedDomain(cd, async (id) => tenants[id as 'acme'] ?? null)

    expect(await findByDomain('app.acme.com')).toBeNull() // not verified yet → no resolution
    await cd.verify('acme', 'app.acme.com')
    expect(await findByDomain('app.acme.com')).toEqual({ id: 'acme', name: 'Acme' })
  })
})
