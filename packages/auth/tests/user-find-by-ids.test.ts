import { describe, expect, it } from 'vitest'
import { MemoryUserSource, type AuthUser } from '../src/index.js'

/**
 * `UserSource.findByIds` — the bulk counterpart of `findById`. It exists so a
 * caller that needs the contact details of a known set of accounts (e.g. every
 * admin of a tenant) makes ONE lookup instead of N, without reaching into the
 * auth tables itself.
 */
describe('UserSource.findByIds', () => {
  const seed = async () => {
    const users = new MemoryUserSource()
    const ada = await users.create({ email: 'ada@acme.test', passwordHash: 'hash-ada' })
    const bob = await users.create({ email: 'bob@acme.test', passwordHash: 'hash-bob' })
    const cy = await users.create({ email: 'cy@acme.test', passwordHash: 'hash-cy' })
    return { users, ada, bob, cy }
  }

  it('returns the contacts in the order of the requested ids', async () => {
    const { users, ada, bob, cy } = await seed()
    const found = await users.findByIds!([cy.id, ada.id, bob.id])
    expect(found.map((u) => u.email)).toEqual(['cy@acme.test', 'ada@acme.test', 'bob@acme.test'])
  })

  it('omits ids with no account instead of returning holes', async () => {
    const { users, ada, bob } = await seed()
    const found = await users.findByIds!([ada.id, 'does-not-exist', bob.id])
    expect(found.map((u) => u.id)).toEqual([ada.id, bob.id])
  })

  it('de-duplicates repeated ids', async () => {
    const { users, ada } = await seed()
    expect(await users.findByIds!([ada.id, ada.id, ada.id])).toHaveLength(1)
  })

  it('returns an empty list for no ids', async () => {
    const { users } = await seed()
    expect(await users.findByIds!([])).toEqual([])
  })

  it('never returns a password hash or any other credential field', async () => {
    const { users, ada } = await seed()
    const [contact] = await users.findByIds!([ada.id])
    expect(contact).toEqual({ id: ada.id, email: 'ada@acme.test', emailVerified: false })
    expect(Object.keys(contact!).sort()).toEqual(['email', 'emailVerified', 'id'])
    expect(JSON.stringify(contact)).not.toContain('hash-ada')
  })

  it('does not hand back a live reference to the stored record', async () => {
    const { users, ada } = await seed()
    const [contact] = await users.findByIds!([ada.id])
    ;(contact as unknown as AuthUser).email = 'attacker@evil.test'
    expect((await users.findById(ada.id))?.email).toBe('ada@acme.test')
  })

  it('reports verified accounts as verified', async () => {
    const { users, ada } = await seed()
    await users.update(ada.id, { emailVerified: true })
    const [contact] = await users.findByIds!([ada.id])
    expect(contact?.emailVerified).toBe(true)
  })
})
