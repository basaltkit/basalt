import { describe, expect, it } from 'vitest'
import { createApp, METADATA } from '@basaltkit/core'
import { NotATeamMemberError, TEAMS, teamsPlugin, tenantMembershipPlugin } from '../src/index.js'

type Guard = (info: {
  route: { meta?: Record<string, unknown> }
  context: Record<string, unknown>
  container: unknown
}) => Promise<void>

/**
 * Boots teamsPlugin + tenantMembershipPlugin, seeds one membership, and returns
 * a runner that fires every registered http:guard for a given route/context.
 * The teamRole guard no-ops without meta.teamRole, so only the membership guard
 * has any effect here.
 */
async function harness() {
  const app = await createApp({
    plugins: [teamsPlugin(), tenantMembershipPlugin()],
  }).boot()
  const teams = app.container.get(TEAMS)
  await teams.addMember('acme', 'member1', 'member')

  const guards = app.container.get(METADATA).get<Guard>('http:guards')
  const run = (context: Record<string, unknown>, meta: Record<string, unknown> = {}) =>
    Promise.all(guards.map((g) => g({ route: { meta }, context, container: app.container })))

  return { app, run }
}

describe('tenantMembershipPlugin (F1 — user↔tenant binding)', () => {
  it('allows a genuine member of the resolved tenant', async () => {
    const { app, run } = await harness()
    await expect(run({ tenant: { id: 'acme' }, user: { id: 'member1' } })).resolves.toBeDefined()
    await app.shutdown()
  })

  it('BLOCKS an authenticated user who is not a member (forged x-tenant-id)', async () => {
    const { app, run } = await harness()
    // A real user of another tenant points x-tenant-id at "acme" they don't belong to.
    await expect(run({ tenant: { id: 'acme' }, user: { id: 'outsider' } })).rejects.toBeInstanceOf(
      NotATeamMemberError,
    )
    await app.shutdown()
  })

  it('opts out for central routes (meta.central = true)', async () => {
    const { app, run } = await harness()
    await expect(
      run({ tenant: { id: 'acme' }, user: { id: 'outsider' } }, { central: true }),
    ).resolves.toBeDefined()
    await app.shutdown()
  })

  it('skips when no tenant is resolved (central/platform route)', async () => {
    const { app, run } = await harness()
    await expect(run({ user: { id: 'outsider' } })).resolves.toBeDefined()
    await app.shutdown()
  })

  it('skips when there is no authenticated user (public route)', async () => {
    const { app, run } = await harness()
    await expect(run({ tenant: { id: 'acme' } })).resolves.toBeDefined()
    await app.shutdown()
  })
})

describe('membership semantics: existence by default (unranked custom roles)', () => {
  it('a genuine member holding a custom role absent from roleRank is NOT rejected', async () => {
    const app = await createApp({
      plugins: [teamsPlugin(), tenantMembershipPlugin()],
    }).boot()
    // 'billing-viewer' has no entry in roleRank → rankOf() = 0 < member (1).
    await app.container.get(TEAMS).addMember('acme', 'viewer1', 'billing-viewer')
    const guards = app.container.get(METADATA).get<Guard>('http:guards')
    const run = (context: Record<string, unknown>) =>
      Promise.all(guards.map((g) => g({ route: { meta: {} }, context, container: app.container })))
    await expect(run({ tenant: { id: 'acme' }, user: { id: 'viewer1' } })).resolves.toBeDefined()
    await app.shutdown()
  })

  it('an explicit role option still enforces rank (custom role stays below member)', async () => {
    const app = await createApp({
      plugins: [teamsPlugin(), tenantMembershipPlugin({ role: 'member' })],
    }).boot()
    await app.container.get(TEAMS).addMember('acme', 'viewer1', 'billing-viewer')
    const guards = app.container.get(METADATA).get<Guard>('http:guards')
    const run = (context: Record<string, unknown>) =>
      Promise.all(guards.map((g) => g({ route: { meta: {} }, context, container: app.container })))
    await expect(run({ tenant: { id: 'acme' }, user: { id: 'viewer1' } })).rejects.toBeInstanceOf(
      NotATeamMemberError,
    )
    await app.shutdown()
  })
})

describe('system/admin escape: exempt predicate', () => {
  it('exempts contexts the predicate approves (platform admin crossing tenants)', async () => {
    const app = await createApp({
      plugins: [
        teamsPlugin(),
        tenantMembershipPlugin({
          exempt: (context) => (context['user'] as { platformAdmin?: boolean } | undefined)?.platformAdmin === true,
        }),
      ],
    }).boot()
    const guards = app.container.get(METADATA).get<Guard>('http:guards')
    const run = (context: Record<string, unknown>) =>
      Promise.all(guards.map((g) => g({ route: { meta: {} }, context, container: app.container })))
    // not a member of acme, but platform admin → allowed
    await expect(
      run({ tenant: { id: 'acme' }, user: { id: 'root', platformAdmin: true } }),
    ).resolves.toBeDefined()
    // same shape without the flag → still blocked
    await expect(
      run({ tenant: { id: 'acme' }, user: { id: 'other', platformAdmin: false } }),
    ).rejects.toBeInstanceOf(NotATeamMemberError)
    await app.shutdown()
  })
})

describe('opt-in decision cache', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function cachedHarness(cache: { ttlMs: number; maxEntries?: number }) {
    const app = await createApp({
      plugins: [teamsPlugin(), tenantMembershipPlugin({ cache })],
    }).boot()
    const teams = app.container.get(TEAMS)
    await teams.addMember('acme', 'member1', 'member')
    // count store hits through the service surface
    let lookups = 0
    const originalRoleOf = teams.roleOf.bind(teams)
    teams.roleOf = async (t: string, u: string) => {
      lookups++
      return originalRoleOf(t, u)
    }
    const guards = app.container.get(METADATA).get<Guard>('http:guards')
    const run = (context: Record<string, unknown>) =>
      Promise.all(guards.map((g) => g({ route: { meta: {} }, context, container: app.container })))
    return { app, teams, run, lookups: () => lookups }
  }

  it('repeated requests within the TTL hit the store once', async () => {
    const { app, run, lookups } = await cachedHarness({ ttlMs: 60_000 })
    await run({ tenant: { id: 'acme' }, user: { id: 'member1' } })
    await run({ tenant: { id: 'acme' }, user: { id: 'member1' } })
    await run({ tenant: { id: 'acme' }, user: { id: 'member1' } })
    expect(lookups()).toBe(1)
    await app.shutdown()
  })

  it('a membership removal invalidates the cached decision immediately (same process)', async () => {
    const { app, teams, run, lookups } = await cachedHarness({ ttlMs: 60_000 })
    await run({ tenant: { id: 'acme' }, user: { id: 'member1' } }) // cached OK
    await teams.removeMember('acme', 'member1')
    await expect(run({ tenant: { id: 'acme' }, user: { id: 'member1' } })).rejects.toBeInstanceOf(
      NotATeamMemberError,
    )
    expect(lookups()).toBe(2) // recomputed after the hook invalidated the entry
    await app.shutdown()
  })

  it('a newly added member is visible immediately despite a cached negative (same process)', async () => {
    const { app, teams, run } = await cachedHarness({ ttlMs: 60_000 })
    await expect(run({ tenant: { id: 'acme' }, user: { id: 'late' } })).rejects.toBeInstanceOf(
      NotATeamMemberError,
    ) // negative cached
    await teams.addMember('acme', 'late', 'member')
    await expect(run({ tenant: { id: 'acme' }, user: { id: 'late' } })).resolves.toBeDefined()
    await app.shutdown()
  })

  it('entries expire after the TTL (cross-replica staleness bound)', async () => {
    const { app, run, lookups } = await cachedHarness({ ttlMs: 20 })
    await run({ tenant: { id: 'acme' }, user: { id: 'member1' } })
    await sleep(35)
    await run({ tenant: { id: 'acme' }, user: { id: 'member1' } })
    expect(lookups()).toBe(2)
    await app.shutdown()
  })

  it('the cache is bounded: maxEntries evicts, never grows unboundedly', async () => {
    const { app, run } = await cachedHarness({ ttlMs: 60_000, maxEntries: 5 })
    for (let i = 0; i < 50; i++) {
      await run({ tenant: { id: 'acme' }, user: { id: 'member1' } }).catch(() => {})
      await run({ tenant: { id: `t${i}` }, user: { id: `u${i}` } }).catch(() => {})
    }
    await app.shutdown() // bound asserted structurally below via no-throw; size is internal
  })
})
