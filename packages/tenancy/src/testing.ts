import assert from 'node:assert/strict'
import { CustomDomains, DomainTakenError, type CustomDomain, type DomainStore } from './custom-domains.js'

/**
 * Test-only helpers for `@basaltkit/tenancy`, shipped on the `./testing`
 * subpath so they never reach an app's production bundle.
 */

/** One case of {@link domainStoreContract}: a name and a function that throws on failure. */
export interface DomainStoreContractCase {
  name: string
  run(): Promise<void>
}

/**
 * The behaviour every {@link DomainStore} must have, as framework-neutral test
 * cases (they throw an `AssertionError` on failure, using `node:assert`). Run
 * them with any test runner:
 *
 * ```ts
 * import { domainStoreContract } from '@basaltkit/tenancy/testing'
 *
 * describe('MyDomainStore', () => {
 *   for (const c of domainStoreContract(() => new MyDomainStore(db))) it(c.name, c.run)
 * })
 * ```
 *
 * `makeStore` is called once per case and must return an EMPTY store. The cases
 * use the tenant ids `acme` and `globex`: a store whose table references the
 * tenants table must have both rows in place before it returns.
 *
 * The one rule most worth the suite: `add()` of a domain already present
 * throws {@link DomainTakenError}. `CustomDomains.add()` deliberately does no
 * check-then-act — the store's uniqueness gate is the only thing that stops two
 * tenants claiming one domain, and anything else escaping (a raw driver error
 * for the unique violation) surfaces as a 500 instead of a 409.
 */
export function domainStoreContract(
  makeStore: () => DomainStore | Promise<DomainStore>,
): DomainStoreContractCase[] {
  const claim = (domain: string, tenantId: string, extra: Partial<CustomDomain> = {}): CustomDomain => ({
    domain,
    tenantId,
    verified: false,
    verificationToken: `token-${tenantId}-${domain}`,
    createdAt: 1_700_000_000_000,
    ...extra,
  })

  const cases: [string, () => Promise<void>][] = [
    [
      'add() stores a claim that get() returns unchanged',
      async () => {
        const store = await makeStore()
        const record = claim('app.acme.com', 'acme')
        await store.add(record)
        assert.deepEqual(await store.get('app.acme.com'), record)
        assert.equal(await store.get('unknown.example'), null)
      },
    ],
    [
      'add() of a domain already present throws DomainTakenError',
      async () => {
        const store = await makeStore()
        await store.add(claim('shared.example', 'acme'))
        await assert.rejects(store.add(claim('shared.example', 'globex')), DomainTakenError)
        await assert.rejects(store.add(claim('shared.example', 'acme')), DomainTakenError)
        assert.equal((await store.get('shared.example'))?.tenantId, 'acme')
      },
    ],
    [
      'CustomDomains.add() answers a taken domain with a 409, not a raw driver error',
      async () => {
        const store = await makeStore()
        const domains = new CustomDomains({ store, claimTtlMs: Number.POSITIVE_INFINITY })
        await domains.add('acme', 'taken.example')
        const error = await domains.add('globex', 'taken.example').then(
          () => assert.fail('a second claim on the same domain must be refused'),
          (e: unknown) => e,
        )
        assert.ok(error instanceof DomainTakenError)
        assert.equal(error.status, 409)
      },
    ],
    [
      "forTenant() returns only that tenant's claims",
      async () => {
        const store = await makeStore()
        await store.add(claim('a.acme.com', 'acme'))
        await store.add(claim('b.acme.com', 'acme'))
        await store.add(claim('globex.example', 'globex'))
        const mine = (await store.forTenant('acme')).map((d) => d.domain).sort()
        assert.deepEqual(mine, ['a.acme.com', 'b.acme.com'])
        assert.deepEqual(await store.forTenant('nobody'), [])
      },
    ],
    [
      'markVerified() / markUnverified() set and clear the proof',
      async () => {
        const store = await makeStore()
        await store.add(claim('app.acme.com', 'acme'))
        await store.markVerified('app.acme.com', 1_700_000_100_000)
        assert.deepEqual(await store.get('app.acme.com'), claim('app.acme.com', 'acme', { verified: true, verifiedAt: 1_700_000_100_000 }))
        if (store.listVerified) {
          assert.deepEqual((await store.listVerified()).map((d) => d.domain), ['app.acme.com'])
        }
        await store.markUnverified('app.acme.com')
        assert.deepEqual(await store.get('app.acme.com'), claim('app.acme.com', 'acme'))
        if (store.listVerified) assert.deepEqual(await store.listVerified(), [])
      },
    ],
    [
      'remove() deletes the claim',
      async () => {
        const store = await makeStore()
        await store.add(claim('app.acme.com', 'acme'))
        await store.remove('app.acme.com')
        assert.equal(await store.get('app.acme.com'), null)
        await store.add(claim('app.acme.com', 'globex'))
        assert.equal((await store.get('app.acme.com'))?.tenantId, 'globex')
      },
    ],
    [
      'replace() swaps a claim only while it is still the expected one',
      async () => {
        const store = await makeStore()
        if (!store.replace) return
        const original = claim('contested.example', 'acme')
        await store.add(original)
        const next = claim('contested.example', 'globex', { verified: true, verifiedAt: 1_700_000_200_000 })
        assert.equal(await store.replace(original, next), true)
        assert.deepEqual(await store.get('contested.example'), next)
        // The loser of a race read `original` too; the record moved on, so it must lose.
        assert.equal(await store.replace(original, claim('contested.example', 'acme', { verificationToken: 'late' })), false)
        assert.deepEqual(await store.get('contested.example'), next)
        assert.equal(await store.replace(claim('absent.example', 'acme'), claim('absent.example', 'globex')), false)
        assert.equal(await store.get('absent.example'), null)
      },
    ],
    [
      'returned records are copies',
      async () => {
        const store = await makeStore()
        await store.add(claim('app.acme.com', 'acme'))
        const first = await store.get('app.acme.com')
        assert.ok(first)
        first.tenantId = 'globex'
        first.verified = true
        assert.deepEqual(await store.get('app.acme.com'), claim('app.acme.com', 'acme'))
      },
    ],
  ]
  return cases.map(([name, run]) => ({ name, run }))
}
