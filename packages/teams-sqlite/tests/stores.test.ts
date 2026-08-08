import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  openTeamsDatabase,
  SqliteInvitationStore,
  SqliteMembershipStore,
  sqliteTeamsStores,
} from '../src/index.js'

describe('SqliteMembershipStore', () => {
  it('adds, finds, lists, re-roles and removes', async () => {
    const store = new SqliteMembershipStore(openTeamsDatabase())
    await store.add({ tenantId: 'acme', userId: 'u1', role: 'admin', createdAt: 1 })
    await store.add({ tenantId: 'acme', userId: 'u2', role: 'member', createdAt: 2 })
    await store.add({ tenantId: 'other', userId: 'u1', role: 'member', createdAt: 3 })

    expect((await store.find('acme', 'u1'))?.role).toBe('admin')
    expect(await store.find('acme', 'ghost')).toBeNull()
    expect((await store.list('acme')).map((m) => m.userId).sort()).toEqual(['u1', 'u2'])
    expect((await store.list('other')).length).toBe(1)

    await store.setRole('acme', 'u2', 'admin')
    expect((await store.find('acme', 'u2'))?.role).toBe('admin')

    // add() upserts (matches the in-memory Map.set semantics)
    await store.add({ tenantId: 'acme', userId: 'u1', role: 'owner', createdAt: 9 })
    expect((await store.find('acme', 'u1'))?.role).toBe('owner')

    await store.remove('acme', 'u1')
    expect(await store.find('acme', 'u1')).toBeNull()
    expect((await store.list('acme')).length).toBe(1)
  })
})

describe('SqliteInvitationStore', () => {
  it('creates, looks up, lists pending, accepts and revokes', async () => {
    const store = new SqliteInvitationStore(openTeamsDatabase())
    await store.create({ id: 'i1', tenantId: 'acme', email: 'a@x.com', role: 'member', token: 'tok1', invitedBy: 'admin', expiresAt: 100 })
    await store.create({ id: 'i2', tenantId: 'acme', email: 'b@x.com', role: 'member', token: 'tok2', expiresAt: 100 })
    await store.create({ id: 'i3', tenantId: 'other', email: 'c@x.com', role: 'member', token: 'tok3', expiresAt: 100 })

    expect((await store.findByToken('tok1'))?.id).toBe('i1')
    expect((await store.findByToken('tok1'))?.invitedBy).toBe('admin')
    expect((await store.findById('i2'))?.invitedBy).toBeUndefined()
    expect(await store.findByToken('nope')).toBeNull()
    expect(await store.findById('nope')).toBeNull()

    expect((await store.listPending('acme')).map((i) => i.id).sort()).toEqual(['i1', 'i2'])
    expect((await store.findPending('acme', 'a@x.com'))?.id).toBe('i1')
    expect(await store.findPending('acme', 'missing@x.com')).toBeNull()

    await store.markAccepted('i1', 500)
    expect((await store.findById('i1'))?.acceptedAt).toBe(500)
    expect((await store.listPending('acme')).map((i) => i.id)).toEqual(['i2']) // accepted drops out
    expect(await store.findPending('acme', 'a@x.com')).toBeNull()

    await store.revoke('i2', 600)
    expect((await store.findById('i2'))?.revokedAt).toBe(600)
    expect((await store.listPending('acme')).length).toBe(0) // revoked drops out too
  })

  it('enforces unique tokens', async () => {
    const store = new SqliteInvitationStore(openTeamsDatabase())
    const inv = { id: 'x', tenantId: 't', email: 'e@x.com', role: 'member', token: 'same', expiresAt: 1 }
    await store.create(inv)
    await expect(store.create({ ...inv, id: 'y' })).rejects.toThrow()
  })
})

describe('sqliteTeamsStores + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'machize-teams-'))
  const file = join(dir, 'teams.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles both stores named for teamsPlugin', () => {
    const t = sqliteTeamsStores()
    expect(t.memberships).toBeInstanceOf(SqliteMembershipStore)
    expect(t.invitations).toBeInstanceOf(SqliteInvitationStore)
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openTeamsDatabase()
    const t = sqliteTeamsStores(db)
    expect(t.db).toBe(db)
    await t.memberships.add({ tenantId: 'acme', userId: 'u1', role: 'admin', createdAt: 1 })
    expect(await new SqliteMembershipStore(db).find('acme', 'u1')).not.toBeNull()
  })

  it('survives a process restart (data persists to disk)', async () => {
    const first = sqliteTeamsStores(file)
    await first.memberships.add({ tenantId: 'acme', userId: 'u1', role: 'admin', createdAt: 1 })
    await first.invitations.create({ id: 'i1', tenantId: 'acme', email: 'a@x.com', role: 'member', token: 'tok', expiresAt: 100 })
    first.db.close()

    const second = sqliteTeamsStores(file)
    expect((await second.memberships.find('acme', 'u1'))?.role).toBe('admin')
    expect((await second.invitations.findByToken('tok'))?.id).toBe('i1')
    second.db.close()
  })
})
