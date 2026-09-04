import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import { MemoryInAppStore, inAppRoutes, notificationsPlugin } from '../src/index.js'

/**
 * F-24 · Reading your own notifications.
 *
 * The package stores in-app notifications and never served them: nothing here
 * mounts a route, so a bell icon had nowhere to read from and every application
 * wrote the same four endpoints.
 *
 * The routing shape is opinionated enough that a package might reasonably leave
 * it out. The **security** decision is not, and is the same everywhere: the
 * recipient is the session, never a parameter. A `?recipientId=` is the
 * shortest path to one employee reading another's deadline alerts — and those
 * alerts name the case.
 */
const montar = async () => {
  const store = new MemoryInAppStore()
  const app = await createApp({ plugins: [notificationsPlugin({ inApp: store })] }).boot()
  const rotas = inAppRoutes()

  const chamar = (url: string, user: { id: string } | undefined, extra: object = {}) => {
    const r = rotas.find((x) => x.url === url)
    if (!r) throw new Error(`sem rota ${url}`)
    return runWithContext(
      { ...(user ? { user } : {}), container: app.container },
      () => (r.handler as (a: unknown) => Promise<unknown>)({ query: {}, params: {}, ...extra }),
    )
  }

  const escrever = (recipientId: string, id: string, title: string) =>
    store.append({ id, recipientId, notification: 'test', title, at: Date.now() })

  return { app, store, chamar, escrever }
}

describe('F-24 · inAppRoutes()', () => {
  it('lists only the caller own notifications', async () => {
    const { app, chamar, escrever } = await montar()
    await escrever('u1', 'n1', 'Prazo no processo 2026/0001')
    await escrever('u2', 'n2', 'Outra coisa')

    const minhas = (await chamar('/me/notifications', { id: 'u1' })) as { id: string }[]
    expect(minhas).toHaveLength(1)
    expect(minhas[0]!.id).toBe('n1')

    await app.shutdown()
  })

  it('ignores a recipient passed in the query', async () => {
    /**
     * The decision the package must not leave to each application. A route that
     * honoured `?recipientId=` would be the shortest way for a trainee to read
     * the partner's deadline alerts — and those name the case number.
     */
    const { app, chamar, escrever } = await montar()
    await escrever('u1', 'n1', 'Do u1')
    await escrever('u2', 'n2', 'Do u2')

    const lista = (await chamar('/me/notifications', { id: 'u2' }, {
      query: { recipientId: 'u1' },
    })) as { id: string }[]

    expect(lista.map((n) => n.id)).toEqual(['n2'])

    await app.shutdown()
  })

  it('counts the unread', async () => {
    const { app, chamar, escrever } = await montar()
    await escrever('u1', 'n1', 'a')
    await escrever('u1', 'n2', 'b')

    expect(await chamar('/me/notifications/unread-count', { id: 'u1' })).toEqual({ count: 2 })

    await app.shutdown()
  })

  it('marks one as read, and only for its owner', async () => {
    const { app, chamar, escrever } = await montar()
    await escrever('u1', 'n1', 'a')

    // Someone else's notification: not found, rather than forbidden.
    // Confirming it exists would already say something about it.
    await expect(chamar('/me/notifications/:id/read', { id: 'u2' }, { params: { id: 'n1' } })).rejects.toThrow()

    await chamar('/me/notifications/:id/read', { id: 'u1' }, { params: { id: 'n1' } })
    expect(await chamar('/me/notifications/unread-count', { id: 'u1' })).toEqual({ count: 0 })

    await app.shutdown()
  })

  it('marks every unread one at once', async () => {
    const { app, chamar, escrever } = await montar()
    await escrever('u1', 'n1', 'a')
    await escrever('u1', 'n2', 'b')
    await escrever('u2', 'n3', 'c')

    expect(await chamar('/me/notifications/read-all', { id: 'u1' })).toEqual({ marked: 2 })
    // And nobody else's.
    expect(await chamar('/me/notifications/unread-count', { id: 'u2' })).toEqual({ count: 1 })

    await app.shutdown()
  })

  it('refuses without a session', async () => {
    const { app, chamar } = await montar()
    await expect(chamar('/me/notifications', undefined)).rejects.toThrow()
    await app.shutdown()
  })
})
