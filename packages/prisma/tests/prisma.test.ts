import { describe, expect, it } from 'vitest'
import { createApp, ctx, METADATA, runWithContext } from '@machize/core'
import {
  applyTenantScope,
  db,
  DB_POOL,
  DbUnavailableError,
  MissingTenantError,
  prismaPlugin,
  TenantClientPool,
  tenancyExtension,
} from '../src/index.js'

describe('applyTenantScope', () => {
  it('forces the tenant filter into where for list operations', () => {
    expect(
      applyTenantScope('findMany', { where: { status: 'open' } }, 't1', 'tenantId'),
    ).toEqual({ where: { status: 'open', tenantId: 't1' } })
    expect(applyTenantScope('count', undefined, 't1', 'tenantId')).toEqual({
      where: { tenantId: 't1' },
    })
    // a caller trying to escape the scope is overridden
    expect(
      applyTenantScope('deleteMany', { where: { tenantId: 'other' } }, 't1', 'tenantId'),
    ).toEqual({ where: { tenantId: 't1' } })
  })

  it('stamps the tenant into create data', () => {
    expect(applyTenantScope('create', { data: { name: 'x' } }, 't1', 'tenantId')).toEqual({
      data: { name: 'x', tenantId: 't1' },
    })
    expect(
      applyTenantScope('createMany', { data: [{ name: 'a' }, { name: 'b' }] }, 't1', 'tenantId'),
    ).toEqual({ data: [{ name: 'a', tenantId: 't1' }, { name: 'b', tenantId: 't1' }] })
  })

  it('leaves unique-where operations untouched (documented v0 limitation)', () => {
    const args = { where: { id: 'p1' } }
    expect(applyTenantScope('findUnique', args, 't1', 'tenantId')).toEqual(args)
    expect(applyTenantScope('delete', args, 't1', 'tenantId')).toEqual(args)
  })
})

describe('tenancyExtension', () => {
  const run = async (contextTenant: string | undefined, options = {}) => {
    const captured: unknown[] = []
    const extension = tenancyExtension(options)
    const operations = extension.query.$allModels
    const invoke = () =>
      operations.$allOperations({
        operation: 'findMany',
        args: { where: { status: 'open' } },
        query: async (args) => void captured.push(args),
      })
    if (contextTenant) {
      await runWithContext({ tenant: { id: contextTenant } }, invoke)
    } else {
      await invoke()
    }
    return captured
  }

  it('scopes queries to ctx().tenant at call time', async () => {
    const captured = await run('acme')
    expect(captured).toEqual([{ where: { status: 'open', tenantId: 'acme' } }])
  })

  it('bypasses without a tenant by default; strict mode throws', async () => {
    const captured = await run(undefined)
    expect(captured).toEqual([{ where: { status: 'open' } }])
    await expect(run(undefined, { onMissingTenant: 'error' })).rejects.toBeInstanceOf(
      MissingTenantError,
    )
  })
})

describe('TenantClientPool', () => {
  const makePool = (max: number) => {
    const destroyed: string[] = []
    let created = 0
    const pool = new TenantClientPool<{ tenant: string; n: number }>({
      create: (tenantId) => ({ tenant: tenantId, n: ++created }),
      destroy: (_client, tenantId) => void destroyed.push(tenantId),
      max,
    })
    return { pool, destroyed }
  }

  it('reuses clients per tenant', async () => {
    const { pool } = makePool(5)
    const a1 = await pool.get('acme')
    const a2 = await pool.get('acme')
    const b = await pool.get('globex')
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
    expect(pool.size).toBe(2)
  })

  it('evicts least-recently-used clients above max, destroying them', async () => {
    const { pool, destroyed } = makePool(2)
    await pool.get('a')
    await pool.get('b')
    await pool.get('a') // bump 'a' — 'b' is now the oldest
    await pool.get('c') // evicts 'b'
    expect(destroyed).toEqual(['b'])
    expect(pool.has('a')).toBe(true)
    expect(pool.has('b')).toBe(false)
  })

  it('destroyAll disconnects everything', async () => {
    const { pool, destroyed } = makePool(5)
    await pool.get('a')
    await pool.get('b')
    await pool.destroyAll()
    expect(destroyed.sort()).toEqual(['a', 'b'])
    expect(pool.size).toBe(0)
  })
})

describe('prismaPlugin', () => {
  it('shared mode: enricher attaches the client; db() reads it', async () => {
    const fakeClient = { name: 'shared' }
    const app = await createApp({ plugins: [prismaPlugin({ client: fakeClient })] }).boot()
    const enricher = app.container.get(METADATA).get<Function>('http:enrichers')[0] as (info: {
      context: Record<string, unknown>
    }) => Promise<void>

    const context: Record<string, unknown> = {}
    await enricher({ context })
    expect(context['db']).toBe(fakeClient)

    await runWithContext(context, () => {
      expect(db<typeof fakeClient>()).toBe(fakeClient)
    })
    expect(() => db()).toThrowError(DbUnavailableError)
    await app.shutdown()
  })

  it('per-tenant mode: each tenant gets its own client via the pool', async () => {
    const app = await createApp({
      plugins: [prismaPlugin({ forTenant: (tenantId) => ({ tenantId }) })],
    }).boot()
    const enricher = app.container.get(METADATA).get<Function>('http:enrichers')[0] as (info: {
      context: Record<string, unknown>
    }) => Promise<void>

    const acme: Record<string, unknown> = { tenant: { id: 'acme' } }
    const globex: Record<string, unknown> = { tenant: { id: 'globex' } }
    await enricher({ context: acme })
    await enricher({ context: globex })
    expect(acme['db']).toEqual({ tenantId: 'acme' })
    expect(globex['db']).toEqual({ tenantId: 'globex' })
    expect(app.container.get(DB_POOL).size).toBe(2)
    await app.shutdown()
    expect(app.container.get(DB_POOL).size).toBe(0)
  })

  it('tenancy:switched hook attaches the client inside tenancy.run-style contexts', async () => {
    const fakeClient = { name: 'shared' }
    const app = await createApp({ plugins: [prismaPlugin({ client: fakeClient })] }).boot()

    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      await app.hooks.emit('tenancy:switched', { tenant: { id: 'acme' } } as never)
      expect(ctx().db).toBe(fakeClient)
    })
    await app.shutdown()
  })
})
