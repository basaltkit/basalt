import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import { MemoryAccessStore, accessRoutes, permissionsPlugin } from '../src/index.js'

/**
 * F-21 · `GET /me/access` — what the caller may do.
 *
 * `/auth/me` answers who you are. Nothing answered what you may do, so every
 * frontend that hides a menu by permission wrote the same twenty lines: read
 * the roles, read the direct grants, read each role's grants, merge, dedupe.
 *
 * Not a security surface — the server still decides on every request. This is
 * so the UI stops offering doors that return 403, and stops hiding doors that
 * would have opened.
 */
const montar = async () => {
  const store = new MemoryAccessStore()
  await store.grantToRole('partner', ['matter:*', 'user:read'], 'acme')
  await store.assignRole('u1', 'partner', 'acme')
  await store.grantToUser('u1', ['reports:export'], 'acme')

  const app = await createApp({ plugins: [permissionsPlugin({ store })] }).boot()
  const [rota] = accessRoutes()

  /**
   * O handler é chamado dentro de um contexto, e não por HTTP.
   *
   * Uma primeira versão deste teste inventou um header `x-test-user` e
   * presumiu que algum plugin o lia — não lê nenhum. O que a rota consome é o
   * `ctx().user`, que é o que o `authPlugin` lá põe; montá-lo aqui testa a
   * rota e não um mecanismo de autenticação imaginado.
   */
  const pedir = (user: { id: string } | undefined, tenant: string) =>
    runWithContext(
      { ...(user ? { user } : {}), tenant: { id: tenant }, container: app.container },
      () => (rota!.handler as (a: unknown) => Promise<unknown>)({}),
    )

  return { app, store, pedir }
}

describe('F-21 · accessRoutes()', () => {
  it('merges direct grants with the ones each role carries', async () => {
    const { app: a, pedir } = await montar()

    const corpo = (await pedir({ id: 'u1' }, 'acme')) as {
      roles: string[]
      permissions: string[]
    }
    expect(corpo.roles).toEqual(['partner'])
    // `matter:*` and `user:read` come from the role, `reports:export` directly.
    // A frontend needs the union; asking it to assemble one is asking it to
    // reimplement the model.
    expect(corpo.permissions).toContain('matter:*')
    expect(corpo.permissions).toContain('user:read')
    expect(corpo.permissions).toContain('reports:export')

    await a.shutdown()
  })

  it('does not repeat a permission granted twice', async () => {
    const { app: a, store, pedir } = await montar()
    await store.grantToUser('u1', ['user:read'], 'acme')

    const corpo = (await pedir({ id: 'u1' }, 'acme')) as { permissions: string[] }
    expect(corpo.permissions.filter((p) => p === 'user:read')).toHaveLength(1)

    await a.shutdown()
  })

  it('answers empty for a caller with no session', async () => {
    // A public page asks this before login. Empty is the honest answer; 401
    // would make the frontend treat "not logged in" as an error.
    const { app: a, pedir } = await montar()

    expect(await pedir(undefined, 'acme')).toEqual({ roles: [], permissions: [] })

    await a.shutdown()
  })

  it('is scoped to the tenant of the request', async () => {
    // The same person can hold different roles in two tenants; answering with
    // the wrong one shows a menu they cannot use.
    const { app: a, store, pedir } = await montar()
    await store.assignRole('u1', 'trainee', 'globex')
    await store.grantToRole('trainee', ['matter:read'], 'globex')

    const corpo = (await pedir({ id: 'u1' }, 'globex')) as {
      roles: string[]
      permissions: string[]
    }
    expect(corpo.roles).toEqual(['trainee'])
    expect(corpo.permissions).toEqual(['matter:read'])

    await a.shutdown()
  })
})
