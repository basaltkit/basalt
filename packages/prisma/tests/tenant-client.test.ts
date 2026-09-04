import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { DbUnavailableError, db, tenantClient } from '../src/index.js'

/**
 * F-15 · A client stand-in that resolves per call.
 *
 * The `-prisma` stores (`auth-prisma`, `permissions-prisma`, `audit-prisma`,
 * and three more) take a client at construction time and validate it there.
 * In schema-per-tenant mode the right client is only known per request — it
 * comes from `db()`, which reads the context and throws outside one.
 *
 * The framework already tolerates a lazy client: `ensureModel` in
 * `permissions-prisma` catches exactly this case, commented "lazy/proxy client
 * (e.g. database-per-tenant) — validated at first use". The pattern was
 * tolerated but never supplied, so every application wrote its own proxy.
 *
 * Getting that proxy wrong does not raise an error. It sends every tenant's
 * users to the `public` schema — data from the wrong tenant, silently. That is
 * why this belongs in the package where `db()` lives rather than in each app.
 */
describe('F-15 · tenantClient()', () => {
  it('resolves the context client on every property access', () => {
    const client = tenantClient<{ marca: string }>()

    const a = runWithContext({ db: { marca: 'tenant-a' } }, () => client.marca)
    const b = runWithContext({ db: { marca: 'tenant-b' } }, () => client.marca)

    // The same object, two contexts, two answers — which is the whole point:
    // the stores hold this once, at boot, and still reach the right database.
    expect(a).toBe('tenant-a')
    expect(b).toBe('tenant-b')
  })

  it('can be built outside any context', () => {
    // Stores are constructed at boot, long before the first request. Resolving
    // eagerly here is what made the hand-written proxies necessary.
    expect(() => tenantClient()).not.toThrow()
  })

  it('throws the same error as db() when used outside a context', () => {
    const client = tenantClient<{ user: unknown }>()
    expect(() => client.user).toThrow(DbUnavailableError)
  })

  it('forwards method calls with the right receiver', async () => {
    // A store calls `client.user.findMany()`. If the proxy loses `this`, the
    // call reaches the model with the wrong receiver and fails deep inside
    // Prisma, far from here.
    const modelo = {
      nome: 'users',
      async findMany() {
        return [this.nome]
      },
    }
    const client = tenantClient<{ user: typeof modelo }>()

    await runWithContext({ db: { user: modelo } }, async () => {
      await expect(client.user.findMany()).resolves.toEqual(['users'])
    })
  })

  it('reports properties the context client has', () => {
    // `in` and `Object.keys` are how the stores probe for a model before using
    // it — see `ensureModel`. A proxy that answers "no" to everything makes
    // those checks fail in a way that looks like a missing schema.
    const client = tenantClient<Record<string, unknown>>()

    runWithContext({ db: { user: {}, session: {} } }, () => {
      expect('user' in client).toBe(true)
      expect('missing' in client).toBe(false)
      expect(Object.keys(client).sort()).toEqual(['session', 'user'])
    })
  })

  it('is the same client db() would return', () => {
    const client = tenantClient<{ marca: string }>()
    runWithContext({ db: { marca: 'x' } }, () => {
      expect(client.marca).toBe(db<{ marca: string }>().marca)
    })
  })
})

describe('F-15 · a store built at boot reaches the right tenant', () => {
  it('routes the same store to two different clients', async () => {
    /**
     * The shape of the bug, without importing a store package: something built
     * once, holding the client, used later inside two different contexts.
     *
     * The hand-written proxies this replaces used a bare property read. That
     * works until a store calls a method — `client.user.findMany()` — where a
     * lost receiver fails deep inside Prisma, far from the proxy.
     */
    const clienteA = { permUserRole: { async findMany() { return [{ role: 'partner' }] } } }
    const clienteB = { permUserRole: { async findMany() { return [{ role: 'trainee' }] } } }

    // Built once, at "boot", outside any context.
    const client = tenantClient<typeof clienteA>()
    const store = { roles: () => client.permUserRole.findMany() }

    const a = await runWithContext({ db: clienteA }, () => store.roles())
    const b = await runWithContext({ db: clienteB }, () => store.roles())

    expect(a).toEqual([{ role: 'partner' }])
    expect(b).toEqual([{ role: 'trainee' }])
  })

  it('survives the model probe the stores do before using a client', () => {
    // `ensureModel` checks the model exists before touching it. Under a proxy
    // that answers nothing, that check reads as "schema missing" — which is a
    // confusing way to be told the proxy is wrong.
    const client = tenantClient<Record<string, unknown>>()
    runWithContext({ db: { permUserRole: {} } }, () => {
      expect(client['permUserRole']).toBeDefined()
      expect(client['permRolePermission']).toBeUndefined()
    })
  })
})
