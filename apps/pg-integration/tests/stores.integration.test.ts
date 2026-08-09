import { beforeAll, describe, expect, it } from 'vitest'
import { prismaActivityStore } from '@machize/activity-prisma'
import { prismaAuditStore } from '@machize/audit-prisma'
import { prismaAuthStores } from '@machize/auth-prisma'
import { prismaCommentsStore } from '@machize/comments-prisma'
import { prismaInAppStore } from '@machize/notifications-prisma'
import { prismaAccessStore } from '@machize/permissions-prisma'
import { prismaSubscriptionsStores } from '@machize/subscriptions-prisma'
import { prismaTeamsStores } from '@machize/teams-prisma'
import { prismaTenantSource } from '@machize/tenancy-prisma'
import { prismaOutboxStore } from '@machize/events-prisma'
import { prismaWebhookStore } from '@machize/webhooks-prisma'

// Real-PostgreSQL round-trips for every @machize/*-prisma store. Gated on
// TEST_DATABASE_URL so the default suite stays green when no database is set;
// CI (and `docker run postgres` locally) provides it. Proves the Prisma
// backends work against a real database — compound ids, String[] columns,
// createMany({ skipDuplicates }), and the atomic conditional consume() — not
// just against the typed in-memory fakes the unit tests use.
const url = process.env['TEST_DATABASE_URL']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any

describe.skipIf(!url)('@machize/*-prisma stores against real PostgreSQL', () => {
  beforeAll(async () => {
    // Dynamic specifier (typed as string) so tsc doesn't need the generated client.
    const clientModule: string = '../generated/client/index.js'
    const { PrismaClient } = (await import(clientModule)) as { PrismaClient: new () => unknown }
    prisma = new PrismaClient()
    // Clean every store table so the assertions are deterministic.
    await Promise.all([
      prisma.authUser.deleteMany(), prisma.authSession.deleteMany(), prisma.authRefreshToken.deleteMany(),
      prisma.authToken.deleteMany(), prisma.authApiKey.deleteMany(), prisma.authMfa.deleteMany(),
      prisma.teamMembership.deleteMany(), prisma.teamInvitation.deleteMany(),
      prisma.subscription.deleteMany(), prisma.usageCounter.deleteMany(), prisma.webhookEvent.deleteMany(),
      prisma.comment.deleteMany(), prisma.auditEntry.deleteMany(), prisma.activityRecord.deleteMany(),
      prisma.inAppNotification.deleteMany(), prisma.permUserRole.deleteMany(),
      prisma.permUserPermission.deleteMany(), prisma.permRolePermission.deleteMany(),
      prisma.tenantDomain.deleteMany(), prisma.tenant.deleteMany(),
      prisma.outboxEntry.deleteMany(), prisma.webhookEndpoint.deleteMany(),
    ])
  })

  it('auth: users, sessions, refresh tokens, API keys, MFA', async () => {
    const s = prismaAuthStores(prisma)
    const user = await s.users.create({ email: 'a@b.com', passwordHash: 'h' })
    expect((await s.users.findByEmail('a@b.com'))?.id).toBe(user.id)
    expect((await s.users.update(user.id, { emailVerified: true }))?.emailVerified).toBe(true)

    const session = await s.sessions.create(user.id, 60_000)
    expect((await s.sessions.find(session.id))?.userId).toBe(user.id)
    expect(await s.sessions.delete(session.id)).toBe(true)

    await s.refreshTokens.create({ token: 'r1', familyId: 'f1', userId: user.id, expiresAt: Date.now() + 1000 })
    await s.refreshTokens.revokeFamily('f1')
    expect(await s.refreshTokens.find('r1')).toBeNull()

    await s.apiKeys.create({ id: 'k1', name: 'ci', prefix: 'mk_x', hash: 'h1', tenantId: 't1', scopes: ['*'], createdAt: Date.now() })
    expect((await s.apiKeys.findByHash('h1'))?.id).toBe('k1')
    expect((await s.apiKeys.list({ tenantId: 't1' })).length).toBe(1)

    await s.mfa.set(user.id, { secret: 's', enabled: true, recoveryCodes: ['a', 'b'] })
    expect((await s.mfa.get(user.id))?.recoveryCodes).toEqual(['a', 'b'])
  })

  it('teams: memberships (compound id upsert) and invitations', async () => {
    const t = prismaTeamsStores(prisma)
    await t.memberships.add({ tenantId: 'acme', userId: 'u1', role: 'admin', createdAt: 1 })
    await t.memberships.add({ tenantId: 'acme', userId: 'u1', role: 'owner', createdAt: 2 }) // upsert
    expect((await t.memberships.find('acme', 'u1'))?.role).toBe('owner')
    expect((await t.memberships.list('acme')).length).toBe(1)

    await t.invitations.create({ id: 'i1', tenantId: 'acme', email: 'x@y.com', role: 'member', token: 'tok', expiresAt: 100 })
    expect((await t.invitations.findByToken('tok'))?.id).toBe('i1')
    await t.invitations.markAccepted('i1', 500)
    expect((await t.invitations.listPending('acme')).length).toBe(0)
  })

  it('subscriptions: record, webhook idempotency, and ATOMIC consume under concurrency', async () => {
    const s = prismaSubscriptionsStores(prisma)
    await s.store.save({ billableId: 'acme', plan: 'pro', period: 'monthly', status: 'active' })
    expect((await s.store.get('acme'))?.plan).toBe('pro')

    expect(await s.webhooks.markProcessed('evt_1')).toBe(true)
    expect(await s.webhooks.markProcessed('evt_1')).toBe(false)

    // 20 concurrent consumers, limit 5 → the row lock must let exactly 5 through.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => s.usage.consume('acme', 'seats', 'lifetime', 1, 5)),
    )
    expect(results.filter((r) => r.applied).length).toBe(5)
    expect(await s.usage.get('acme', 'seats', 'lifetime')).toBe(5)
  })

  it('permissions: role grants as sets (createMany skipDuplicates)', async () => {
    const p = prismaAccessStore(prisma).store
    await p.assignRole('u1', 'admin', 't1')
    await p.assignRole('u1', 'admin', 't1') // duplicate is a no-op
    expect(await p.getUserRoles('u1', 't1')).toEqual(['admin'])
    await p.grantToRole('admin', ['projects:read', 'projects:write'], 't1')
    await p.grantToRole('admin', ['projects:write', 'projects:delete'], 't1')
    expect((await p.getRolePermissions('admin', 't1')).sort()).toEqual(['projects:delete', 'projects:read', 'projects:write'])
  })

  it('comments: thread with String[] mentions, resolve then reopen', async () => {
    const c = prismaCommentsStore(prisma).store
    await c.create({ id: 'c1', tenantId: 'acme', resourceType: 'issue', resourceId: '1', authorId: 'u1', body: 'hi', mentions: ['u2', 'u3'], createdAt: 1 })
    expect((await c.find('acme', 'c1'))?.mentions).toEqual(['u2', 'u3'])
    expect((await c.update('acme', 'c1', { resolvedAt: 100, resolvedBy: 'u9' }))?.resolvedAt).toBe(100)
    expect((await c.update('acme', 'c1', { resolvedAt: undefined, resolvedBy: undefined }))?.resolvedAt).toBeUndefined()
    expect((await c.list('acme', 'issue', '1')).length).toBe(1)
  })

  it('audit: append-only trail with the event wildcard', async () => {
    const a = prismaAuditStore(prisma).store
    await a.append({ id: 'a1', source: 'hook', event: 'auth:login', payload: { ip: '1' }, at: 10 })
    await a.append({ id: 'a2', source: 'hook', event: 'order:created', payload: undefined, at: 20 })
    expect((await a.query({})).map((e) => e.id)).toEqual(['a2', 'a1']) // newest first
    expect((await a.query({ event: 'auth:**' })).map((e) => e.id)).toEqual(['a1'])
    expect((await a.query({})).find((e) => e.id === 'a1')?.payload).toEqual({ ip: '1' })
  })

  it('activity: feed newest-first with filters', async () => {
    const a = prismaActivityStore(prisma).store
    await a.append({ id: 'r1', log: 'default', description: 'created', tenantId: 't1', at: 10, properties: { to: 'draft' } })
    await a.append({ id: 'r2', log: 'default', description: 'other', tenantId: 't2', at: 20 })
    expect((await a.query({ tenantId: 't1' })).map((r) => r.id)).toEqual(['r1'])
    expect((await a.query({ tenantId: 't1' }))[0]?.properties).toEqual({ to: 'draft' })
  })

  it('notifications: inbox, idempotent markRead, unread count', async () => {
    const n = prismaInAppStore(prisma).store
    await n.append({ id: 'n1', recipientId: 'u1', notification: 'welcome', title: 'Hi', at: 10 })
    expect(await n.unreadCount('u1')).toBe(1)
    expect(await n.markRead('u1', 'n1')).toBe(true)
    expect(await n.markRead('u1', 'n1')).toBe(false) // already read
    expect(await n.unreadCount('u1')).toBe(0)
  })

  it('tenancy: open JSON records + unique custom-domain lookup', async () => {
    const tenants = prismaTenantSource(prisma)
    await tenants.save({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })
    // round-trips the open record through the Json column
    expect(await tenants.find('acme')).toEqual({
      id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'],
    })
    expect((await tenants.findByDomain('app.acme.com'))?.id).toBe('acme')
    // re-save replaces the domain set (drop old, add new)
    await tenants.save({ id: 'acme', domains: ['new.acme.com'] })
    expect(await tenants.findByDomain('app.acme.com')).toBeNull()
    expect((await tenants.findByDomain('new.acme.com'))?.id).toBe('acme')
    // a domain owned by another tenant is rejected up front
    await expect(tenants.save({ id: 'globex', domains: ['new.acme.com'] })).rejects.toThrow()
    expect(await tenants.find('globex')).toBeNull()
    // remove cascades domains
    expect(await tenants.remove('acme')).toBe(true)
    expect(await tenants.findByDomain('new.acme.com')).toBeNull()
  })

  it('events outbox: enqueue, pending order, publish/fail lifecycle', async () => {
    const outbox = prismaOutboxStore(prisma).store
    await outbox.enqueue({ id: 'a', event: 'order.created', payload: { id: 1 }, tenantId: 't1', createdAt: 30 })
    await outbox.enqueue({ id: 'b', event: 'order.paid', payload: { id: 2 }, createdAt: 10 })

    // oldest first; JSON payload round-trips through the text column
    const pending = await outbox.pending(10, 5)
    expect(pending.map((e) => e.id)).toEqual(['b', 'a'])
    expect(pending.find((e) => e.id === 'a')?.payload).toEqual({ id: 1 })
    expect(pending.find((e) => e.id === 'a')?.tenantId).toBe('t1')

    // publish removes from pending; failing bumps attempts past the ceiling
    await outbox.markPublished('b', 99)
    await outbox.markFailed('a', 'boom')
    expect((await outbox.pending(10, 1)).length).toBe(0) // a: attempts 1 >= 1, b: published
    const a = (await outbox.all()).find((e) => e.id === 'a')
    expect(a?.attempts).toBe(1)
    expect(a?.lastError).toBe('boom')
  })

  it('webhooks: endpoint subscriptions, pattern + tenant matching', async () => {
    const webhooks = prismaWebhookStore(prisma).store
    await webhooks.add({ id: 'global', url: 'https://g.test', events: ['invoice.*'], secret: 's' })
    await webhooks.add({ id: 'acme', url: 'https://a.test', events: ['*'], tenantId: 'acme' })
    await webhooks.add({ id: 'off', url: 'https://o.test', events: ['invoice.paid'], active: false })

    // round-trips the JSON events array + secret
    expect((await webhooks.list()).find((e) => e.id === 'global')).toEqual({
      id: 'global', url: 'https://g.test', events: ['invoice.*'], secret: 's',
    })
    // active + prefix match, tenant-agnostic 'global' matches acme; inactive 'off' excluded
    expect((await webhooks.forEvent('invoice.paid', 'acme')).map((e) => e.id).sort()).toEqual(['acme', 'global'])
    await webhooks.remove('acme')
    expect((await webhooks.forEvent('invoice.paid', 'acme')).map((e) => e.id)).toEqual(['global'])
  })
})
