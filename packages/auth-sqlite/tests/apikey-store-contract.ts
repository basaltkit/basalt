import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiKeyPatch, ApiKeyRecord, ApiKeyStore } from '@basaltkit/auth'

/**
 * The `ApiKeyStore` contract every first-party driver must honour, including
 * the optional `update` and the rotation-grace `findByHash` obligation that
 * comes with it.
 *
 * A copy of `packages/auth/tests/helpers/apikey-store-contract.ts`
 * (test helpers are not shared across packages); keep them in sync.
 */
export function apiKeyStoreContract(name: string, makeStore: () => ApiKeyStore | Promise<ApiKeyStore>): void {
  describe(`${name}: ApiKeyStore contract (lifecycle)`, () => {
    let store: ApiKeyStore
    let update: NonNullable<ApiKeyStore['update']>
    const base = (over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
      id: 'k1',
      name: 'ci',
      prefix: 'mk_live_aaaaaa',
      hash: 'h-current',
      scopes: ['orders:read'],
      createdAt: 1_000,
      tenantId: 't1',
      ...over,
    })

    beforeEach(async () => {
      store = await makeStore()
      expect(typeof store.update).toBe('function')
      update = store.update!.bind(store)
    })

    it('update applies a patch and returns the updated record', async () => {
      await store.create(base())
      const updated = await update('k1', { name: 'renamed', scopes: ['a', 'b'], expiresAt: 9_000 })
      expect(updated).toMatchObject({ id: 'k1', name: 'renamed', scopes: ['a', 'b'], expiresAt: 9_000, tenantId: 't1' })
      expect(await store.findById('k1')).toMatchObject({ name: 'renamed', expiresAt: 9_000 })
      const cleared = await update('k1', { expiresAt: null })
      expect(cleared?.expiresAt).toBeUndefined()
    })

    it('update returns null for an unknown or revoked key and changes nothing', async () => {
      expect(await update('nope', { name: 'x' })).toBeNull()
      await store.create(base())
      await store.revoke('k1', 2_000)
      expect(await update('k1', { name: 'x' })).toBeNull()
      expect((await store.findById('k1'))?.name).toBe('ci')
    })

    it('ifHash is a compare-and-set on the current hash', async () => {
      await store.create(base())
      expect(await update('k1', { hash: 'h-next', prefix: 'mk_live_bbbbbb' }, { ifHash: 'h-stale' })).toBeNull()
      expect((await store.findById('k1'))?.hash).toBe('h-current')
      const rotated = await update(
        'k1',
        { hash: 'h-next', prefix: 'mk_live_bbbbbb', previousHash: 'h-current', previousHashExpiresAt: 5_000, rotatedAt: 3_000 },
        { ifHash: 'h-current' },
      )
      expect(rotated).toMatchObject({ hash: 'h-next', previousHash: 'h-current', previousHashExpiresAt: 5_000, rotatedAt: 3_000 })
      // The loser of a race (same precondition) gets null.
      expect(await update('k1', { hash: 'h-other' }, { ifHash: 'h-current' })).toBeNull()
    })

    it('findByHash also finds a record by its previous hash; clearing it ends that', async () => {
      await store.create(base())
      await update('k1', { hash: 'h-next', previousHash: 'h-current', previousHashExpiresAt: 5_000 })
      expect((await store.findByHash('h-next'))?.id).toBe('k1')
      expect((await store.findByHash('h-current'))?.id).toBe('k1')
      await update('k1', { previousHash: null, previousHashExpiresAt: null })
      expect(await store.findByHash('h-current')).toBeNull()
      const record = await store.findById('k1')
      expect(record?.previousHash).toBeUndefined()
      expect(record?.previousHashExpiresAt).toBeUndefined()
    })

    it('list filters by serviceId', async () => {
      await store.create(base({ id: 'k1', hash: 'h1', serviceId: 'erp-sync' }))
      await store.create(base({ id: 'k2', hash: 'h2', serviceId: 'billing' }))
      await store.create(base({ id: 'k3', hash: 'h3', userId: 'u1' }))
      expect((await store.list({ serviceId: 'erp-sync' })).map((k) => k.id)).toEqual(['k1'])
      expect((await store.findById('k1'))?.serviceId).toBe('erp-sync')
      expect((await store.findById('k3'))?.serviceId).toBeUndefined()
    })

    it('round-trips allowedIps and meta, and null clears them', async () => {
      await store.create(base({ allowedIps: ['10.0.0.0/8', '2001:db8::/32'], meta: { ticket: 'OPS-1', owner: 'ana' } }))
      expect(await store.findById('k1')).toMatchObject({
        allowedIps: ['10.0.0.0/8', '2001:db8::/32'],
        meta: { ticket: 'OPS-1', owner: 'ana' },
      })
      expect(await update('k1', { allowedIps: ['192.0.2.1'], meta: { ticket: 'OPS-2' } })).toMatchObject({
        allowedIps: ['192.0.2.1'],
        meta: { ticket: 'OPS-2' },
      })
      const cleared = await update('k1', { allowedIps: null, meta: null })
      expect(cleared?.allowedIps).toBeUndefined()
      expect(cleared?.meta).toBeUndefined()
      const plain = await store.findById('k1')
      expect(plain?.allowedIps).toBeUndefined()
      expect(plain?.meta).toBeUndefined()
    })

    it('ignores identity fields smuggled into a patch', async () => {
      await store.create(base({ userId: 'u1' }))
      const smuggled = { name: 'x', id: 'k9', tenantId: 't2', userId: 'u2', serviceId: 's', createdAt: 1 } as unknown as ApiKeyPatch
      const updated = await update('k1', smuggled)
      expect(updated).toMatchObject({ id: 'k1', name: 'x', tenantId: 't1', userId: 'u1', createdAt: 1_000 })
      expect(updated?.serviceId).toBeUndefined()
      expect(await store.findById('k9')).toBeNull()
    })
  })
}
