import { DatabaseSync } from 'node:sqlite'
import {
  AccountEmailAmbiguousError,
  AccountLinkConflictError,
  Auth,
  MemoryWebAuthnChallengeStore,
  PasskeyClonedError,
  WebAuthnService,
  type PasswordHasher,
  type WebAuthnVerifier,
} from '@basaltkit/auth'
import { describe, expect, it } from 'vitest'
import { normalizeAuthUserEmails, sqliteAuthStores } from '../src/index.js'

const secret = 'x'.repeat(32)
const hasher: PasswordHasher = { hash: async (p) => `h:${p}`, verify: async (p, h) => h === `h:${p}` }

/** A database created before emails were canonicalised, holding case-variant twins. */
const legacy = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0)`)
  db.exec(`INSERT INTO auth_users VALUES ('u1', 'Dup@acme.test', 'x', 0), ('u2', 'dup@acme.test', 'y', 0),
                                         ('u3', 'Carol@Acme.test', 'z', 0)`)
  return db
}

const nocaseIndex = (db: DatabaseSync) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_auth_users_email_nocase'").get()

describe('legacy mixed-case emails (FA-070 / D9)', () => {
  it('a lookup of a duplicated email is ambiguous instead of resolving to the oldest row', async () => {
    const s = sqliteAuthStores(legacy())
    await expect(s.users.findByEmail('dup@acme.test')).rejects.toBeInstanceOf(AccountEmailAmbiguousError)
    expect((await s.users.findByEmail('carol@acme.test'))?.id).toBe('u3')
  })

  it('normalizeAuthUserEmails rewrites lone rows, reports twins, and builds the index once they are gone', async () => {
    const db = legacy()
    const s = sqliteAuthStores(db)
    const preview = normalizeAuthUserEmails(db, { dryRun: true })
    expect(preview).toEqual({
      normalized: [{ id: 'u3', from: 'Carol@Acme.test', to: 'carol@acme.test' }],
      conflicts: [{ email: 'dup@acme.test', ids: ['u1', 'u2'] }],
    })
    expect(normalizeAuthUserEmails(db)).toEqual(preview)
    expect((db.prepare("SELECT email FROM auth_users WHERE id = 'u3'").get() as { email: string }).email).toBe('carol@acme.test')
    expect(nocaseIndex(db)).toBeUndefined()

    // The operator resolves the twins; the next run builds the index.
    db.exec("DELETE FROM auth_users WHERE id = 'u1'")
    expect(normalizeAuthUserEmails(db)).toEqual({ normalized: [], conflicts: [] })
    expect(nocaseIndex(db)).toBeDefined()
    expect((await s.users.findByEmail('DUP@acme.test'))?.id).toBe('u2')
  })
})

describe('SqliteAccountLinkStore (FA-058)', () => {
  it('links are unique per (provider, subject) and drive Auth.socialLogin', async () => {
    const s = sqliteAuthStores()
    const link = { provider: 'google', subject: 'g-1', userId: 'u1', email: 'a@x.test', createdAt: 1 }
    expect(await s.accountLinks.create(link)).toBe(true)
    expect(await s.accountLinks.create({ ...link, userId: 'u2' })).toBe(false)
    expect(await s.accountLinks.find('google', 'g-1')).toEqual(link)
    expect(await s.accountLinks.forUser('u1')).toEqual([link])
    await s.accountLinks.remove('google', 'g-1')
    expect(await s.accountLinks.find('google', 'g-1')).toBeNull()

    const auth = new Auth({ secret, users: s.users, accountLinks: s.accountLinks, hasher, loginThrottle: false, ipLoginThrottle: false })
    const first = await auth.socialLogin('dev@corp.test', { emailVerified: true, identity: { provider: 'okta', subject: '00u1' } })
    expect((await auth.socialLogin('new@corp.test', { emailVerified: true, identity: { provider: 'okta', subject: '00u1' } })).user.id).toBe(
      first.user.id,
    )
    await expect(
      auth.socialLogin('dev@corp.test', { emailVerified: true, identity: { provider: 'okta', subject: '00u2' } }),
    ).rejects.toBeInstanceOf(AccountLinkConflictError)
    await s.accountLinks.deleteAllForUser(first.user.id)
    expect(await s.accountLinks.forUser(first.user.id)).toEqual([])
  })
})

describe('SqlitePasskeyStore (FA-059)', () => {
  it('round-trips a credential and compare-and-sets the counter', async () => {
    const { passkeys } = sqliteAuthStores()
    const credential = { id: 'cred', userId: 'u1', publicKey: 'pk', counter: 4_000_000_000, transports: ['usb'], deviceName: 'Key', createdAt: 1 }
    await passkeys.add(credential)
    expect(await passkeys.get('cred')).toEqual(credential)
    expect(await passkeys.compareAndSetCounter('cred', 1, 2, 5)).toBe(false)
    expect(await passkeys.compareAndSetCounter('cred', 4_000_000_000, 4_000_000_001, 5)).toBe(true)
    expect(await passkeys.get('cred')).toMatchObject({ counter: 4_000_000_001, lastUsedAt: 5 })
    expect(await passkeys.forUser('u1')).toHaveLength(1)
    await passkeys.remove('cred')
    expect(await passkeys.get('cred')).toBeNull()
  })

  it('two concurrent assertions of a cloned authenticator: only one passes', async () => {
    const { passkeys } = sqliteAuthStores()
    await passkeys.add({ id: 'cred-1', userId: 'u1', publicKey: 'pk', counter: 5, createdAt: 0 })
    const verifier: WebAuthnVerifier = {
      async verifyRegistration() {
        return { verified: false }
      },
      async verifyAuthentication() {
        await new Promise((r) => setTimeout(r, 5))
        return { verified: true, newCounter: 6 }
      },
    }
    let n = 0
    const service = new WebAuthnService({
      config: { rpId: 'example.com', rpName: 'Example', origin: 'https://example.com' },
      credentials: passkeys,
      challenges: new MemoryWebAuthnChallengeStore(),
      verifier,
      randomChallenge: () => `c-${++n}`,
    })
    await service.startAuthentication('a', 'u1')
    await service.startAuthentication('b', 'u1')
    const results = await Promise.allSettled([
      service.finishAuthentication('a', { id: 'cred-1' }),
      service.finishAuthentication('b', { id: 'cred-1' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(PasskeyClonedError)
  })
})
