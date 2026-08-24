import { describe, expect, it } from 'vitest'
import {
  Gate,
  MemoryAccessStore,
  MemoryTemporaryGrantStore,
  MemoryDelegationStore,
} from '../src/index.js'

const build = () => {
  let t = 1000
  const store = new MemoryAccessStore()
  const temporaryGrants = new MemoryTemporaryGrantStore()
  const delegations = new MemoryDelegationStore()
  const gate = new Gate({ store, temporaryGrants, delegations, scope: () => 'global', now: () => t })
  return { gate, store, setNow: (n: number) => (t = n) }
}

describe('temporary grants', () => {
  it('grants extra permissions until they expire', async () => {
    const { gate, setNow } = build()
    const user = { id: 'u1' }
    expect(await gate.can(user, 'reports:read')).toBe(false)

    await gate.grantTemporarily('u1', ['reports:read'], { ttlMs: 500 }) // expires at 1500
    expect(await gate.can(user, 'reports:read')).toBe(true)

    setNow(2000)
    expect(await gate.can(user, 'reports:read')).toBe(false)
  })

  it('throws without a temporaryGrants store', async () => {
    const gate = new Gate({ store: new MemoryAccessStore(), scope: () => 'global' })
    await expect(gate.grantTemporarily('u', ['x'])).rejects.toThrow(/temporaryGrants/)
  })
})

describe('delegation', () => {
  it('lets a delegatee act with delegated permissions, bounded to what was delegated', async () => {
    const { gate, store } = build()
    await store.grantToUser('boss', ['projects:*'], 'global')
    await gate.delegate({ from: 'boss', to: 'temp', permissions: ['projects:read'] })

    expect(await gate.can({ id: 'temp' }, 'projects:read')).toBe(true)
    expect(await gate.can({ id: 'temp' }, 'projects:delete')).toBe(false) // not delegated
  })

  it('never lends more than the delegator actually has, even with *', async () => {
    const { gate, store } = build()
    await store.grantToUser('boss', ['projects:read'], 'global')
    await gate.delegate({ from: 'boss', to: 'temp', permissions: ['*'] })

    expect(await gate.can({ id: 'temp' }, 'projects:read')).toBe(true)
    expect(await gate.can({ id: 'temp' }, 'billing:write')).toBe(false) // boss doesn't have it
  })

  it('expires', async () => {
    const { gate, store, setNow } = build()
    await store.grantToUser('boss', ['x:y'], 'global')
    await gate.delegate({ from: 'boss', to: 'temp', permissions: ['x:y'], expiresAt: 1500 })

    expect(await gate.can({ id: 'temp' }, 'x:y')).toBe(true)
    setNow(2000)
    expect(await gate.can({ id: 'temp' }, 'x:y')).toBe(false)
  })

  it('does not chain: a delegatee cannot re-delegate authority it only holds via delegation', async () => {
    const { gate, store } = build()
    await store.grantToUser('a', ['secret:read'], 'global')
    await gate.delegate({ from: 'a', to: 'b', permissions: ['secret:read'] })
    await gate.delegate({ from: 'b', to: 'c', permissions: ['secret:read'] })

    expect(await gate.can({ id: 'b' }, 'secret:read')).toBe(true) // b via a (a has it directly)
    expect(await gate.can({ id: 'c' }, 'secret:read')).toBe(false) // c via b, but b holds it only by delegation
  })

  it('throws without a delegations store', async () => {
    const gate = new Gate({ store: new MemoryAccessStore(), scope: () => 'global' })
    await expect(gate.delegate({ from: 'a', to: 'b', permissions: ['x'] })).rejects.toThrow(/delegations/)
  })
})
