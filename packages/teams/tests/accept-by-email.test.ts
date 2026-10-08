import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import {
  MemoryInvitationStore,
  Teams,
  TEAMS,
  teamsInviteGate,
  teamsPlugin,
  type Invitation,
} from '../src/index.js'

/** BK-033: accepting a pending invitation once the invited address is proven. */
describe('Teams.acceptByEmail', () => {
  it('enrolls a verified address at the invited role and consumes the invitation', async () => {
    const teams = new Teams()
    const { invitation } = await teams.invite({ tenantId: 'acme', email: 'Bob@Acme.test', role: 'admin' })

    const joined = await teams.acceptByEmail({ tenantId: 'acme', userId: 'bob1', email: ' BOB@acme.TEST', emailVerified: true })
    expect(joined).toEqual([expect.objectContaining({ tenantId: 'acme', userId: 'bob1', role: 'admin' })])
    expect((await teams.invitation(invitation.id))?.acceptedAt).toBeDefined()
    // Consumed: a second call is a no-op.
    expect(await teams.acceptByEmail({ tenantId: 'acme', userId: 'bob1', email: 'bob@acme.test', emailVerified: true })).toEqual([])
  })

  it('does nothing unless the email is verified', async () => {
    const teams = new Teams()
    await teams.invite({ tenantId: 'acme', email: 'bob@acme.test' })
    expect(await teams.acceptByEmail({ tenantId: 'acme', userId: 'bob1', email: 'bob@acme.test', emailVerified: false })).toEqual([])
    expect(await teams.acceptByEmail({ tenantId: 'acme', userId: 'bob1', email: 'bob@acme.test' })).toEqual([])
    expect(await teams.roleOf('acme', 'bob1')).toBeNull()
    expect(await teams.pendingInvites('acme')).toHaveLength(1)
  })

  it('ignores expired and revoked invitations', async () => {
    let now = 1_000_000
    const teams = new Teams({ now: () => now, inviteTtl: '1h' })
    await teams.invite({ tenantId: 'acme', email: 'old@acme.test' })
    const { invitation } = await teams.invite({ tenantId: 'acme', email: 'gone@acme.test' })
    await teams.revokeInvite(invitation.id)
    now += 2 * 60 * 60 * 1000

    expect(await teams.acceptByEmail({ tenantId: 'acme', userId: 'u1', email: 'old@acme.test', emailVerified: true })).toEqual([])
    expect(await teams.acceptByEmail({ tenantId: 'acme', userId: 'u2', email: 'gone@acme.test', emailVerified: true })).toEqual([])
    expect(await teams.roleOf('acme', 'u1')).toBeNull()
    expect(await teams.roleOf('acme', 'u2')).toBeNull()
  })

  it('never demotes an owner through a member invitation', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    await teams.invite({ tenantId: 'acme', email: 'owner@acme.test', role: 'member' })
    const res = await teams.acceptByEmail({ tenantId: 'acme', userId: 'owner1', email: 'owner@acme.test', emailVerified: true })
    expect(res).toEqual([expect.objectContaining({ role: 'owner' })])
    expect(await teams.roleOf('acme', 'owner1')).toBe('owner')
  })

  it('concurrent calls enroll once (compare-and-set on the invitation)', async () => {
    const joined: string[] = []
    const teams = new Teams()
    await teams.invite({ tenantId: 'acme', email: 'bob@acme.test' })
    const results = await Promise.all(
      ['bob1', 'bob2', 'bob3'].map((userId) =>
        teams.acceptByEmail({ tenantId: 'acme', userId, email: 'bob@acme.test', emailVerified: true }).then((r) => {
          if (r.length > 0) joined.push(userId)
          return r
        }),
      ),
    )
    expect(results.flat()).toHaveLength(1)
    expect((await teams.members('acme')).map((m) => m.userId)).toEqual(joined)
  })

  it('is scoped to the given tenant: another tenant’s invitation is untouched', async () => {
    const teams = new Teams()
    await teams.invite({ tenantId: 'globex', email: 'bob@acme.test' })
    expect(await teams.acceptByEmail({ tenantId: 'acme', userId: 'bob1', email: 'bob@acme.test', emailVerified: true })).toEqual([])
    expect(await teams.roleOf('globex', 'bob1')).toBeNull()
    expect(await teams.pendingInvites('globex')).toHaveLength(1)
  })

  it('re-checks what a lax store returns (wrong tenant / address)', async () => {
    const invitations = new MemoryInvitationStore()
    const stray: Invitation = {
      id: 'x',
      tenantId: 'globex',
      email: 'mallory@evil.test',
      role: 'owner',
      token: 'h',
      expiresAt: Date.now() + 60_000,
    }
    await invitations.create(stray)
    invitations.findPending = async () => ({ ...stray })
    const teams = new Teams({ invitations })
    expect(await teams.acceptByEmail({ tenantId: 'acme', userId: 'bob1', email: 'bob@acme.test', emailVerified: true })).toEqual([])
    expect(await teams.pendingInviteFor('acme', 'bob@acme.test')).toBeNull()
  })

  it('accept() keeps its behaviour through the shared path', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    const { token } = await teams.invite({ tenantId: 'acme', email: 'owner@acme.test', role: 'member' })
    // Never demotes, still consumes.
    expect(await teams.accept(token, 'owner1', 'owner@acme.test')).toMatchObject({ role: 'owner' })
    await expect(teams.accept(token, 'owner1')).rejects.toMatchObject({ code: 'TEAM_INVITE_INVALID' })
  })
})

describe('teamsPlugin({ acceptOnVerifiedEmail })', () => {
  const bootApp = async (options: Parameters<typeof teamsPlugin>[0] = { acceptOnVerifiedEmail: true }) => {
    const app = await createApp({ plugins: [teamsPlugin(options)] }).boot()
    return { app, teams: app.container.get(TEAMS), hooks: app.hooks }
  }
  const verified = { id: 'bob1', email: 'bob@acme.test', emailVerified: true }

  it('invite → verify: auth:email_verified on the tenant enrolls', async () => {
    const { teams, hooks } = await bootApp()
    await teams.invite({ tenantId: 'acme', email: 'bob@acme.test', role: 'member' })
    await runWithContext({ tenant: { id: 'acme' } }, () => hooks.emit('auth:email_verified', { user: verified }))
    expect(await teams.roleOf('acme', 'bob1')).toBe('member')
  })

  it('verified user → invite → login: auth:login on the tenant enrolls', async () => {
    const { teams, hooks } = await bootApp()
    await teams.invite({ tenantId: 'acme', email: 'bob@acme.test', role: 'admin' })
    await runWithContext({ tenant: { id: 'acme' } }, () => hooks.emit('auth:login', { user: verified }))
    expect(await teams.roleOf('acme', 'bob1')).toBe('admin')
  })

  it('ignores unverified users, the apex, and is off by default', async () => {
    const { teams, hooks } = await bootApp()
    await teams.invite({ tenantId: 'acme', email: 'bob@acme.test' })
    await runWithContext({ tenant: { id: 'acme' } }, () =>
      hooks.emit('auth:login', { user: { ...verified, emailVerified: false } }),
    )
    await runWithContext({}, () => hooks.emit('auth:login', { user: verified }))
    await hooks.emit('auth:login', { user: verified }) // no context at all
    expect(await teams.roleOf('acme', 'bob1')).toBeNull()

    const off = await bootApp({})
    await off.teams.invite({ tenantId: 'acme', email: 'bob@acme.test' })
    await runWithContext({ tenant: { id: 'acme' } }, () => off.hooks.emit('auth:login', { user: verified }))
    expect(await off.teams.roleOf('acme', 'bob1')).toBeNull()
  })

  it('a store error never fails the login; it is reported through team:auto_accept_failed', async () => {
    const invitations = new MemoryInvitationStore()
    invitations.findPending = async () => {
      throw new Error('db down')
    }
    const { hooks } = await bootApp({ acceptOnVerifiedEmail: true, invitations })
    const failures: unknown[] = []
    hooks.on('team:auto_accept_failed', (p) => {
      failures.push(p)
    })
    await expect(
      runWithContext({ tenant: { id: 'acme' } }, () => hooks.emit('auth:login', { user: verified })),
    ).resolves.toBeUndefined()
    expect(failures).toEqual([{ tenantId: 'acme', userId: 'bob1', error: expect.objectContaining({ message: 'db down' }) }])

    // Even a throwing observer of the failure hook cannot fail the login.
    hooks.on('team:auto_accept_failed', () => {
      throw new Error('observer broke')
    })
    await expect(
      runWithContext({ tenant: { id: 'acme' } }, () => hooks.emit('auth:login', { user: verified })),
    ).resolves.toBeUndefined()
  })
})

describe('teamsInviteGate (BK-044)', () => {
  it('admits the apex and, on a tenant, only a live invitation to that tenant', async () => {
    let now = 1_000_000
    const teams = new Teams({ now: () => now, inviteTtl: '1h' })
    await teams.invite({ tenantId: 'acme', email: 'Ana@Acme.test' })
    await teams.invite({ tenantId: 'globex', email: 'eve@acme.test' })
    const gate = teamsInviteGate(teams)

    expect(await gate({ email: 'anyone@else.test' })).toBe(true)
    expect(await gate({ email: 'ana@acme.test', tenantId: 'acme' })).toBe(true)
    expect(await gate({ email: 'ANA@acme.test ', tenantId: 'acme' })).toBe(true)
    expect(await gate({ email: 'eve@acme.test', tenantId: 'acme' })).toBe(false)
    expect(await gate({ email: 'ana@acme.test', tenantId: '' })).toBe(false)

    now += 2 * 60 * 60 * 1000
    expect(await gate({ email: 'ana@acme.test', tenantId: 'acme' })).toBe(false)
  })

  it('only reads: the invitation stays pending', async () => {
    const teams = new Teams()
    await teams.invite({ tenantId: 'acme', email: 'ana@acme.test' })
    await teamsInviteGate(() => teams)({ email: 'ana@acme.test', tenantId: 'acme' })
    expect(await teams.pendingInvites('acme')).toHaveLength(1)
  })
})
