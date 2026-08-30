import { describe, expect, it } from 'vitest'
import { Gate, GLOBAL_SCOPE, MemoryAccessStore, MissingPolicyError, definePolicy } from '../src/index.js'

const DocPolicy = definePolicy<{ ownerId: string }>('doc', {
  update: (user, doc) => doc.ownerId === user.id,
})

const gate = (over: Record<string, unknown> = {}) => {
  const store = new MemoryAccessStore()
  return { store, gate: new Gate({ store, policies: [DocPolicy], ...over }) }
}

const user = { id: 'u1' }

describe('F-4 · a resource with no policy must not degrade to RBAC', () => {
  it('a typo in the ACTION no longer skips the ownership check', async () => {
    const { store, gate: g } = gate()
    await store.grantToUser('u1', ['doc:*'], GLOBAL_SCOPE) // broad RBAC grant

    // `updat` has no check on DocPolicy — the ownership rule would never run.
    await expect(g.can(user, 'doc:updat', { ownerId: 'someone-else' })).rejects.toBeInstanceOf(
      MissingPolicyError,
    )
  })

  it('a typo in the RESOURCE no longer skips the ownership check', async () => {
    const { store, gate: g } = gate()
    await store.grantToUser('u1', ['*'], GLOBAL_SCOPE)

    await expect(g.can(user, 'docs:update', { ownerId: 'someone-else' })).rejects.toBeInstanceOf(
      MissingPolicyError,
    )
  })

  it('names the resource and the registered policies in the error', async () => {
    const { gate: g } = gate()
    const error = await g.can(user, 'docs:update', {}).catch((e: unknown) => e)
    expect((error as MissingPolicyError).code).toBe('PERMISSION_POLICY_MISSING')
    expect((error as Error).message).toContain('docs:update')
    expect((error as Error).message).toContain('doc')
  })

  it('a registered policy still decides — allow and deny', async () => {
    const { gate: g } = gate()
    expect(await g.can(user, 'doc:update', { ownerId: 'u1' })).toBe(true)
    expect(await g.can(user, 'doc:update', { ownerId: 'u2' })).toBe(false)
  })

  it('plain RBAC (no resource) is untouched', async () => {
    const { store, gate: g } = gate()
    await store.grantToUser('u1', ['doc:update'], GLOBAL_SCOPE)
    expect(await g.can(user, 'doc:update')).toBe(true)
    expect(await g.can(user, 'doc:delete')).toBe(false)
  })

  it("onMissingPolicy:'rbac' is the documented opt-out", async () => {
    const { store, gate: g } = gate({ onMissingPolicy: 'rbac' })
    await store.grantToUser('u1', ['docs:update'], GLOBAL_SCOPE)
    expect(await g.can(user, 'docs:update', { ownerId: 'u2' })).toBe(true)
  })

  it('superAdmin still short-circuits before the policy lookup', async () => {
    const { gate: g } = gate({ superAdmin: () => true })
    expect(await g.can(user, 'docs:update', {})).toBe(true)
  })
})
