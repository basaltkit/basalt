import { describe, expect, it, vi } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { Gate, MemoryAccessStore, definePolicy } from '../src/index.js'

/**
 * F-20 · The actor, with its roles already on it.
 *
 * What lands in `ctx().user` is `PublicUser` — `{ id, email, emailVerified }`.
 * No roles, by design: `@basaltkit/auth` does not know `@basaltkit/permissions`
 * exists.
 *
 * But policies receive exactly that object, and `PolicyUser` is
 * `{ id: string; [key: string]: unknown }` — so `user.roles?.includes('partner')`
 * reads `undefined` and the policy denies. That is the right failure mode and
 * an invisible one: a partner treated as a stranger in their own firm, with no
 * error anywhere.
 *
 * Nothing filled the gap, so every service wrote the same hydration by hand,
 * each memoising under a private context key it had to invent. Two copies in
 * one application, and a third waiting to be forgotten.
 */
const store = () => {
  const s = new MemoryAccessStore()
  return s
}

describe('F-20 · gate.actor()', () => {
  it('returns the context user with roles attached', async () => {
    const s = store()
    await s.assignRole('u1', 'partner', 'acme')
    const gate = new Gate({ store: s })

    const actor = await runWithContext(
      { user: { id: 'u1', email: 'a@b.pt' }, tenant: { id: 'acme' } },
      () => gate.actor(),
    )

    expect(actor).toMatchObject({ id: 'u1', email: 'a@b.pt', roles: ['partner'] })
  })

  it('resolves once per request, not once per check', async () => {
    // A listing runs the policy over N records. Without memoisation that is N
    // identical queries to answer "who is asking" — which is why every hand
    // written copy memoised, and why it belongs here instead.
    const s = store()
    await s.assignRole('u1', 'lawyer', 'acme')
    const espia = vi.spyOn(s, 'getUserRoles')
    const gate = new Gate({ store: s })

    await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, async () => {
      await gate.actor()
      await gate.actor()
      await gate.actor()
    })

    expect(espia).toHaveBeenCalledTimes(1)
  })

  it('does not leak the memo between requests', async () => {
    const s = store()
    await s.assignRole('u1', 'partner', 'acme')
    await s.assignRole('u2', 'trainee', 'acme')
    const gate = new Gate({ store: s })

    const a = await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, () => gate.actor())
    const b = await runWithContext({ user: { id: 'u2' }, tenant: { id: 'acme' } }, () => gate.actor())

    expect(a?.roles).toEqual(['partner'])
    expect(b?.roles).toEqual(['trainee'])
  })

  it('reads roles from the scope of the request', async () => {
    // The same person can hold different roles in two tenants. Caching by user
    // alone would carry one firm's roles into another.
    const s = store()
    await s.assignRole('u1', 'partner', 'acme')
    await s.assignRole('u1', 'trainee', 'globex')
    const gate = new Gate({ store: s })

    const acme = await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, () => gate.actor())
    const globex = await runWithContext({ user: { id: 'u1' }, tenant: { id: 'globex' } }, () => gate.actor())

    expect(acme?.roles).toEqual(['partner'])
    expect(globex?.roles).toEqual(['trainee'])
  })

  it('returns null with no user in context', async () => {
    // A background job or a public route has no actor. `null` says so; an
    // object with an empty id would be an actor that fails every check for a
    // reason nobody can read.
    const gate = new Gate({ store: store() })
    const actor = await runWithContext({ tenant: { id: 'acme' } }, () => gate.actor())
    expect(actor).toBeNull()
  })

  it('feeds a policy that reads roles', async () => {
    // The whole point, end to end.
    const s = store()
    await s.assignRole('u1', 'partner', 'acme')

    const CaseAccess = definePolicy<{ confidential: boolean }>('matter', {
      read: (user, matter) =>
        !matter.confidential || ((user['roles'] as string[]) ?? []).includes('partner'),
    })
    const gate = new Gate({ store: s, policies: [CaseAccess as never] })

    await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, async () => {
      const actor = await gate.actor()
      expect(await gate.can(actor!, 'matter:read', { confidential: true })).toBe(true)
    })

    // And without the roles — the shape the bug produced — it denies.
    await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, async () => {
      expect(await gate.can({ id: 'u1' }, 'matter:read', { confidential: true })).toBe(false)
    })
  })
})
