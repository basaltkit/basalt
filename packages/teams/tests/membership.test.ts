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
