import { describe, expect, it } from 'vitest'
import { createApp, createToken, definePlugin } from '@basaltkit/core'
import { REALTIME_HUB, realtimePlugin } from '../src/index.js'

/**
 * F-23 · The subscription gate can reach the application's services.
 *
 * `authorize(connection, channel)` runs outside any request — there is no
 * `ctx()` when a client opens a stream — and `Connection` carries `id`,
 * `tenantId` and `userId`. Not roles, not permissions, which is exactly what
 * deciding "may this connection hear this channel" needs.
 *
 * So an application had to stash the container in a module-level variable,
 * fill it from a companion plugin's `boot`, and read the access store back out
 * of it. Ugly, and the kind of thing that is quietly wrong when plugin order
 * changes.
 *
 * A third argument is the smaller answer: it does not decide *what* the gate
 * needs — roles, a subscription, a feature flag, a per-tenant setting — only
 * that it can reach whatever that is.
 */
const ACCESS = createToken<{ roles(userId: string): string[] }>('test:access')

/**
 * Uma conexão registada no hub.
 *
 * O `subscribe` recebe um **id**, não a conexão — procura-a no registo e
 * devolve `false` se não a encontrar. A primeira versão deste teste passava a
 * conexão e via `false` sempre, o que teria passado por «o gate recusou» se eu
 * não tivesse ido ler o método.
 */
const registar = (hub: { register: (c: unknown) => void }, userId: string) => {
  const id = `c-${userId}`
  hub.register({ id, tenantId: 'acme', userId, send: () => {}, close: () => {} })
  return id
}

describe('F-23 · authorize receives the container', () => {
  it('can resolve a service from it', async () => {
    let visto: string[] = []

    const app = await createApp({
      plugins: [
        definePlugin({
          name: 'test:access-plugin',
          register({ container }) {
            container.singleton(ACCESS, () => ({
              roles: (userId: string) => (userId === 'u1' ? ['partner'] : ['trainee']),
            }))
          },
        }),
        realtimePlugin({
          authorize: (connection, channel, { container }) => {
            // The whole point: reaching a service without a module-level
            // variable filled from someone else's boot.
            visto = container.get(ACCESS).roles(connection.userId!)
            return channel === 'firm' ? visto.includes('partner') : true
          },
        }),
      ],
    }).boot()

    const hub = app.container.get(REALTIME_HUB)

    const id = registar(hub as never, 'u1')
    expect(await hub.subscribe(id, 'firm')).toBe(true)
    expect(visto).toEqual(['partner'])

    await app.shutdown()
  })

  it('refuses the channel when the service says so', async () => {
    const app = await createApp({
      plugins: [
        definePlugin({
          name: 'test:access-plugin',
          register({ container }) {
            container.singleton(ACCESS, () => ({
              roles: (userId: string) => (userId === 'u1' ? ['partner'] : ['client']),
            }))
          },
        }),
        realtimePlugin({
          authorize: (connection, channel, { container }) =>
            channel !== 'firm' || container.get(ACCESS).roles(connection.userId!).includes('partner'),
        }),
      ],
    }).boot()

    const hub = app.container.get(REALTIME_HUB)
    const permitido = await hub.subscribe(registar(hub as never, 'u2'), 'firm')

    // A portal client listening on the firm channel would hear which cases open
    // and for whom, in real time. This is the check that stops it.
    expect(permitido).toBe(false)

    await app.shutdown()
  })

  it('still works for gates that ignore the third argument', async () => {
    // Every existing `authorize` takes two parameters. Adding a third must not
    // change what they mean.
    const app = await createApp({
      plugins: [realtimePlugin({ authorize: (conn, channel) => channel === `user:${conn.userId}` })],
    }).boot()

    const hub = app.container.get(REALTIME_HUB)
    const id = registar(hub as never, 'u1')
    expect(await hub.subscribe(id, 'user:u1')).toBe(true)
    expect(await hub.subscribe(id, 'firm')).toBe(false)

    await app.shutdown()
  })
})
