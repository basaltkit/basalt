import { Auth, MemoryUserSource, SessionIdleConfigError } from '@basaltkit/auth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFakeClient } from './fake-client.js'
import { PrismaSessionStore, prismaAuthStores } from '../src/index.js'

// BK-076: session activity (lastSeenAt) for authPlugin's sessionIdleTtl.
afterEach(() => {
  vi.useRealTimers()
})

describe('PrismaSessionStore session activity (BK-076)', () => {
  it('is off by default: no touch, no lastSeenAt written (unmigrated schemas keep working)', async () => {
    const client = makeFakeClient()
    const create = vi.spyOn(client.authSession, 'create')
    const store = new PrismaSessionStore(client)
    expect(store.touch).toBeUndefined()
    const s = await store.create('u1', 60_000)
    expect(s.lastSeenAt).toBeUndefined()
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty('lastSeenAt')
    // ...so Auth refuses an idle timeout it could not enforce.
    expect(() => new Auth({ users: new MemoryUserSource(), secret: 'x'.repeat(32), sessions: store, sessionIdleTtl: '30m' })).toThrow(
      SessionIdleConfigError,
    )
  })

  it('trackSessionActivity: writes lastSeenAt at creation, returns it from find, updates it on touch', async () => {
    const client = makeFakeClient()
    const store = new PrismaSessionStore(client, { trackSessionActivity: true })
    const s = await store.create('u1', 60_000)
    expect(typeof s.lastSeenAt).toBe('number')
    expect((await store.find(s.id))?.lastSeenAt).toBe(s.lastSeenAt)
    await store.touch!(s.id, 1_234_567)
    expect((await store.find(s.id))?.lastSeenAt).toBe(1_234_567)
    await store.touch!('ghost', 1) // tolerant no-op
  })

  it('prismaAuthStores passes the option through, and Auth enforces the idle timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000_000)
    const stores = prismaAuthStores(makeFakeClient(), { trackSessionActivity: true })
    const auth = new Auth({ users: stores.users, secret: 'x'.repeat(32), sessions: stores.sessions, sessionIdleTtl: '10m' })
    const user = await stores.users.create({ email: 'a@b.com', passwordHash: 'h' })
    const session = await auth.createSession(user.id)
    vi.setSystemTime(1_000_000_000 + 9 * 60_000)
    expect(await auth.sessionUser(session.id)).not.toBeNull()
    vi.setSystemTime(1_000_000_000 + 9 * 60_000 + 11 * 60_000)
    expect(await auth.sessionUser(session.id)).toBeNull()
    expect(await stores.sessions.find(session.id.split('.')[0]!)).toBeNull()
  })
})
