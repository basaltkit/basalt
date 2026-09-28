import { describe, expect, it } from 'vitest'
import { CustomDomains, DomainTakenError, MemoryDomainStore, type CustomDomain, type DomainStore } from '../src/index.js'

/**
 * Framework audit residual: a verified custom-domain claim never expired, and
 * only the operator's `verify(…, { force: true })` — which needs the stale
 * owner's tenant id — could displace it. When a domain lapses and is bought by
 * someone else, the new owner could not take it over through any supported
 * path. Now: `reverify()` / `reverifyAll()` for a schedule, and a verified
 * claim whose TXT is gone yields to a challenger who proves DNS control.
 */
type Txts = Record<string, string[][] | Error>

function setup(txts: Txts, store: DomainStore = new MemoryDomainStore()) {
  let clock = 1000
  let n = 0
  const cd = new CustomDomains({
    store,
    now: () => clock,
    token: () => `tok-${++n}`,
    challengeSecret: 'challenge-secret-for-tests',
    resolveTxt: async (host) => {
      const value = txts[host]
      if (value instanceof Error) throw value
      return value ?? []
    },
  })
  return { cd, store, txts, tick: (ms: number) => (clock += ms) }
}

const HOST = '_basalt-verify.shop.example.com'
const dnsError = (code: string) => Object.assign(new Error(code), { code })

async function verifiedForOld(txts: Txts, store?: DomainStore) {
  const s = setup(txts, store)
  const { dns } = await s.cd.add('old', 'shop.example.com')
  txts[HOST] = [[dns.value]]
  expect(await s.cd.verify('old', 'shop.example.com')).toBe(true)
  return s
}

describe('stale verified claims', () => {
  it('a challenger that proves DNS control takes over a verified claim whose TXT is gone', async () => {
    const txts: Txts = {}
    const { cd } = await verifiedForOld(txts)
    // The domain lapses; the new owner replaces the DNS with its own challenge.
    txts[HOST] = [[cd.challenge('new', 'shop.example.com').value]]
    const { record } = await cd.add('new', 'shop.example.com')
    expect(record).toMatchObject({ tenantId: 'new', verified: true })
    expect(await cd.tenantOf('shop.example.com')).toBe('new')
  })

  it('the verified owner keeps the domain while its own TXT still validates', async () => {
    const txts: Txts = {}
    const { cd } = await verifiedForOld(txts)
    const old = txts[HOST] as string[][]
    txts[HOST] = [...old, [cd.challenge('new', 'shop.example.com').value]]
    await expect(cd.add('new', 'shop.example.com')).rejects.toBeInstanceOf(DomainTakenError)
    expect(await cd.tenantOf('shop.example.com')).toBe('old')
  })

  it('a failed DNS lookup never hands a verified domain over', async () => {
    const txts: Txts = {}
    const { cd } = await verifiedForOld(txts)
    txts[HOST] = dnsError('ESERVFAIL')
    await expect(cd.add('new', 'shop.example.com')).rejects.toBeInstanceOf(DomainTakenError)
    expect(await cd.tenantOf('shop.example.com')).toBe('old')
  })

  it('without a challenge record, a verified claim never expires', async () => {
    const txts: Txts = {}
    const { cd, tick } = await verifiedForOld(txts)
    delete txts[HOST]
    tick(365 * 24 * 60 * 60 * 1000)
    await expect(cd.add('new', 'shop.example.com')).rejects.toBeInstanceOf(DomainTakenError)
  })
})

describe('CustomDomains.reverify()', () => {
  it('un-verifies a claim whose TXT no longer validates', async () => {
    const txts: Txts = {}
    const { cd } = await verifiedForOld(txts)
    delete txts[HOST]
    expect(await cd.reverify('shop.example.com')).toMatchObject({ domain: 'shop.example.com', tenantId: 'old', status: 'revoked' })
    expect(await cd.tenantOf('shop.example.com')).toBeNull()
  })

  it('keeps a claim whose TXT still validates', async () => {
    const txts: Txts = {}
    const { cd } = await verifiedForOld(txts)
    expect(await cd.reverify('shop.example.com')).toMatchObject({ status: 'valid' })
    expect(await cd.tenantOf('shop.example.com')).toBe('old')
  })

  it('NXDOMAIN / NODATA revoke; any other DNS error leaves the claim alone and reports it', async () => {
    const txts: Txts = {}
    const { cd } = await verifiedForOld(txts)
    txts[HOST] = dnsError('ETIMEOUT')
    expect(await cd.reverify('shop.example.com')).toMatchObject({ status: 'dns-error' })
    expect(await cd.tenantOf('shop.example.com')).toBe('old')
    txts[HOST] = dnsError('ENOTFOUND')
    expect(await cd.reverify('shop.example.com')).toMatchObject({ status: 'revoked' })
  })

  it('returns null for an unknown domain and skips unverified claims', async () => {
    const txts: Txts = {}
    const { cd } = setup(txts)
    expect(await cd.reverify('nope.example.com')).toBeNull()
    await cd.add('t', 'shop.example.com')
    expect(await cd.reverify('shop.example.com')).toMatchObject({ status: 'unverified' })
  })

  it('does not revoke a claim that changed hands while DNS was being checked', async () => {
    const txts: Txts = {}
    const store = new MemoryDomainStore()
    const { cd } = await verifiedForOld(txts, store)
    delete txts[HOST]
    // Swap the record between the read and the write, as a concurrent takeover would.
    const current = (await store.get('shop.example.com'))!
    const next: CustomDomain = { ...current, tenantId: 'new', verificationToken: 'other' }
    const racing: DomainStore = Object.assign(Object.create(store) as DomainStore, {
      get: async (d: string) => {
        const r = await store.get(d)
        if (r) await store.replace(current, next)
        return r
      },
    })
    const cd2 = new CustomDomains({ store: racing, resolveTxt: async () => [] })
    expect(await cd2.reverify('shop.example.com')).toMatchObject({ status: 'changed' })
    expect(await store.get('shop.example.com')).toMatchObject({ tenantId: 'new', verified: true })
    void cd
  })
})

describe('CustomDomains.reverifyAll()', () => {
  it('re-checks every verified domain of the store and reports a summary', async () => {
    const txts: Txts = {}
    const { cd } = await verifiedForOld(txts)
    const { dns } = await cd.add('b', 'b.example.com')
    txts['_basalt-verify.b.example.com'] = [[dns.value]]
    await cd.verify('b', 'b.example.com')
    await cd.add('c', 'c.example.com') // unverified: not visited
    delete txts[HOST]
    const summary = await cd.reverifyAll()
    expect(summary).toMatchObject({ checked: 2, revoked: ['shop.example.com'], errors: [] })
    expect(await cd.tenantOf('b.example.com')).toBe('b')
  })

  it('takes an explicit domain list for a store without listVerified()', async () => {
    const txts: Txts = {}
    const inner = new MemoryDomainStore()
    const bare: DomainStore = {
      add: (d) => inner.add(d),
      get: (d) => inner.get(d),
      forTenant: (t) => inner.forTenant(t),
      markVerified: (d, at) => inner.markVerified(d, at),
      markUnverified: (d) => inner.markUnverified(d),
      remove: (d) => inner.remove(d),
    }
    const { cd } = await verifiedForOld(txts, bare)
    await expect(cd.reverifyAll()).rejects.toThrow(TypeError)
    delete txts[HOST]
    expect(await cd.reverifyAll({ domains: ['shop.example.com'] })).toMatchObject({ checked: 1, revoked: ['shop.example.com'] })
  })
})
