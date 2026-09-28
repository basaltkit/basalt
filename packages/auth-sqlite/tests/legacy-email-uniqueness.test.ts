import { DatabaseSync } from 'node:sqlite'
import { EmailTakenError } from '@basaltkit/auth'
import { describe, expect, it } from 'vitest'
import { sqliteAuthStores } from '../src/index.js'

// FA-070 / D9: a database created before emails were case-insensitive may
// already hold case-variant duplicates, so the NOCASE unique index cannot be
// built — and migrate() skipped it silently. From then on nothing but the
// (case-sensitive) column constraint stood between a new case variant and a
// second account for the same person.
describe('email uniqueness holds on a legacy database without the NOCASE index (FA-070/D9)', () => {
  const legacy = (): DatabaseSync => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE auth_users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0)`)
    db.exec(`INSERT INTO auth_users VALUES ('u1', 'Dup@acme.test', 'x', 0), ('u2', 'dup@acme.test', 'y', 0),
                                           ('u3', 'carol@acme.test', 'z', 0)`)
    return db
  }

  it('the index could not be built (the precondition of this test)', () => {
    const s = sqliteAuthStores(legacy())
    const index = s.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_auth_users_email_nocase'")
      .get()
    expect(index).toBeUndefined()
  })

  it('a new case variant of an existing email is refused with EmailTakenError', async () => {
    const s = sqliteAuthStores(legacy())
    await expect(s.users.create({ email: 'CAROL@acme.test', passwordHash: 'p' })).rejects.toBeInstanceOf(EmailTakenError)
    await expect(s.users.create({ email: 'DUP@ACME.TEST', passwordHash: 'p' })).rejects.toBeInstanceOf(EmailTakenError)
    const count = s.db.prepare("SELECT count(*) AS n FROM auth_users WHERE email = 'carol@acme.test' COLLATE NOCASE").get() as {
      n: number
    }
    expect(Number(count.n)).toBe(1)
  })

  it('a genuinely new email is still created', async () => {
    const s = sqliteAuthStores(legacy())
    const user = await s.users.create({ email: 'new@acme.test', passwordHash: 'p' })
    expect((await s.users.findByEmail('NEW@acme.test'))?.id).toBe(user.id)
  })
})
