import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  applyTenantScope,
  CrossTenantWriteError,
  RawQueryInTenantContextError,
  tenancyExtension,
  TenantClientPool,
  UnscopedOperationError,
} from '../src/index.js'

type Handler = (args: {
  model?: string
  operation: string
  args: unknown
  query: (args: unknown) => Promise<unknown>
}) => Promise<unknown>

/** Runs one operation through the extension the way Prisma dispatches it. */
const dispatch = async (
  operation: string,
  args: unknown,
  { tenant = 'acme', model = 'Project', options = {} }: {
    /** `null` = no tenant in scope. */
    tenant?: string | null
    /** `null` = a client-level operation (Prisma passes no model). */
    model?: string | null
    options?: Parameters<typeof tenancyExtension>[0]
  } = {},
) => {
  const extension = tenancyExtension(options)
  const query = extension.query as unknown as Record<string, unknown> & {
    $allModels: { $allOperations: Handler }
    $allOperations: Handler
  }
  const captured: unknown[] = []
  const next = async (a: unknown) => void captured.push(a)
  // Prisma calls the model-level callback for model operations and the
  // top-level $allOperations for every operation (model is undefined for
  // client-level ones such as raw queries).
  const invoke = async () => {
    if (model !== null) {
      await query.$allModels.$allOperations({ model, operation, args, query: async (a) => {
        await query.$allOperations({ model, operation, args: a, query: next })
      } })
    } else {
      await query.$allOperations({ operation, args, query: next })
    }
  }
  if (tenant) await runWithContext({ tenant: { id: tenant } }, invoke)
  else await invoke()
  return captured
}

describe('tenant scoping fails closed on operations it does not know (F03)', () => {
  it('updateManyAndReturn is scoped to the current tenant (no cross-tenant update + return)', () => {
    expect(
      applyTenantScope('updateManyAndReturn', { where: { id: 'g1' }, data: { name: 'x' } }, 'acme', 'tenantId'),
    ).toEqual({ where: { id: 'g1', tenantId: 'acme' }, data: { name: 'x' } })
  })

  it('an operation the scoper does not handle throws instead of passing through unscoped', () => {
    expect(() => applyTenantScope('someFutureOperation', { where: {} }, 'acme', 'tenantId')).toThrowError(
      UnscopedOperationError,
    )
  })

  it('every Prisma model operation is either scoped or refused inside a tenant context', async () => {
    // Prisma 7 model operations (runtime `Operation` type, model-level subset).
    const operations = [
      'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'findMany',
      'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany',
      'updateManyAndReturn', 'upsert', 'delete', 'deleteMany', 'aggregate', 'count',
      'groupBy', 'findRaw', 'aggregateRaw',
    ]
    for (const operation of operations) {
      let forwarded: unknown[] | undefined
      try {
        forwarded = await dispatch(operation, { where: {}, data: {}, create: {}, update: {} })
      } catch (error) {
        expect(
          error instanceof UnscopedOperationError || error instanceof RawQueryInTenantContextError,
          `${operation} threw an unexpected error: ${String(error)}`,
        ).toBe(true)
        continue
      }
      const args = forwarded[0] as Record<string, unknown>
      const data = args['data']
      const rows = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[]
      const scoped =
        (args['where'] as Record<string, unknown> | undefined)?.['tenantId'] === 'acme' ||
        (rows.length > 0 && rows.every((row) => row?.['tenantId'] === 'acme'))
      expect(scoped, `${operation} ran without the tenant filter: ${JSON.stringify(args)}`).toBe(true)
    }
  })

  it('findRaw / aggregateRaw are refused inside a tenant context (MongoDB raw bypasses scoping)', async () => {
    await expect(dispatch('findRaw', { filter: {} })).rejects.toBeInstanceOf(RawQueryInTenantContextError)
    await expect(dispatch('aggregateRaw', { pipeline: [] })).rejects.toBeInstanceOf(RawQueryInTenantContextError)
    expect(await dispatch('findRaw', { filter: {} }, { options: { onRawInTenant: 'allow' } })).toEqual([
      { filter: {} },
    ])
  })

  for (const method of ['$queryRawTyped', '$runCommandRaw', '$someFutureRaw']) {
    it(`${method} is refused inside a tenant context (client-level raw bypasses scoping)`, async () => {
      await expect(dispatch(method, {}, { model: null })).rejects.toBeInstanceOf(
        RawQueryInTenantContextError,
      )
    })

    it(`${method} still runs outside a tenant context (central/admin code)`, async () => {
      expect(await dispatch(method, { q: 1 }, { model: null, tenant: null })).toEqual([{ q: 1 }])
    })
  }
})

describe('tenant scoping covers the tenant field and nested relation writes (F04)', () => {
  const scope = (operation: string, args: Record<string, unknown>) =>
    applyTenantScope(operation, args, 'acme', 'tenantId')

  for (const operation of ['update', 'updateMany', 'updateManyAndReturn']) {
    it(`${operation} cannot move a row to another tenant through data.tenantId`, () => {
      expect(() => scope(operation, { where: { id: 'a' }, data: { tenantId: 'globex' } })).toThrowError(
        CrossTenantWriteError,
      )
      expect(() =>
        scope(operation, { where: { id: 'a' }, data: { tenantId: { set: 'globex' } } }),
      ).toThrowError(CrossTenantWriteError)
      // writing the CURRENT tenant is harmless and allowed
      expect(scope(operation, { where: { id: 'a' }, data: { tenantId: 'acme', name: 'x' } })).toEqual({
        where: { id: 'a', tenantId: 'acme' },
        data: { tenantId: 'acme', name: 'x' },
      })
    })
  }

  it('upsert.update cannot move the row to another tenant', () => {
    expect(() =>
      scope('upsert', { where: { id: 'a' }, create: {}, update: { tenantId: 'globex' } }),
    ).toThrowError(CrossTenantWriteError)
  })

  it('create cannot plant a row in another tenant (data.tenantId is overridden)', () => {
    expect(scope('create', { data: { name: 'x', tenantId: 'globex' } })).toEqual({
      data: { name: 'x', tenantId: 'acme' },
    })
  })

  it('connect targets are restricted to the current tenant (no linking to a foreign row)', () => {
    expect(scope('create', { data: { title: 't', project: { connect: { id: 'g1' } } } })).toEqual({
      data: { title: 't', tenantId: 'acme', project: { connect: { id: 'g1', tenantId: 'acme' } } },
    })
    expect(
      scope('update', { where: { id: 'p1' }, data: { tasks: { connect: [{ id: 'g1' }, { id: 'g2' }] } } }),
    ).toEqual({
      where: { id: 'p1', tenantId: 'acme' },
      data: { tasks: { connect: [{ id: 'g1', tenantId: 'acme' }, { id: 'g2', tenantId: 'acme' }] } },
    })
  })

  it('nested creates are stamped with the current tenant', () => {
    expect(
      scope('create', {
        data: {
          name: 'p',
          tasks: { create: [{ title: 'a', tenantId: 'globex' }], createMany: { data: [{ title: 'b' }] } },
          owner: { connectOrCreate: { where: { id: 'u1' }, create: { email: 'e' } } },
        },
      }),
    ).toEqual({
      data: {
        name: 'p',
        tenantId: 'acme',
        tasks: {
          create: [{ title: 'a', tenantId: 'acme' }],
          createMany: { data: [{ title: 'b', tenantId: 'acme' }] },
        },
        owner: {
          connectOrCreate: { where: { id: 'u1', tenantId: 'acme' }, create: { email: 'e', tenantId: 'acme' } },
        },
      },
    })
  })

  it('nested update/updateMany/delete/deleteMany/set/disconnect/upsert are filtered to the current tenant', () => {
    expect(
      scope('update', {
        where: { id: 'p1' },
        data: {
          tasks: {
            updateMany: { where: { done: false }, data: { done: true } },
            update: { where: { id: 't1' }, data: { title: 'x' } },
            deleteMany: { done: true },
            delete: { id: 't2' },
            set: [{ id: 't3' }],
            disconnect: [{ id: 't4' }],
            upsert: { where: { id: 't5' }, create: { title: 'c' }, update: { title: 'u' } },
          },
        },
      }),
    ).toEqual({
      where: { id: 'p1', tenantId: 'acme' },
      data: {
        tasks: {
          updateMany: { where: { done: false, tenantId: 'acme' }, data: { done: true } },
          update: { where: { id: 't1', tenantId: 'acme' }, data: { title: 'x' } },
          deleteMany: { done: true, tenantId: 'acme' },
          delete: { id: 't2', tenantId: 'acme' },
          set: [{ id: 't3', tenantId: 'acme' }],
          disconnect: [{ id: 't4', tenantId: 'acme' }],
          upsert: {
            where: { id: 't5', tenantId: 'acme' },
            create: { title: 'c', tenantId: 'acme' },
            update: { title: 'u' },
          },
        },
      },
    })
  })

  it('a nested update cannot move a related row to another tenant', () => {
    expect(() =>
      scope('update', {
        where: { id: 'p1' },
        data: { tasks: { updateMany: { where: {}, data: { tenantId: 'globex' } } } },
      }),
    ).toThrowError(CrossTenantWriteError)
    expect(() =>
      scope('update', { where: { id: 't1' }, data: { project: { update: { tenantId: 'globex' } } } }),
    ).toThrowError(CrossTenantWriteError)
  })

  it('to-one nested update/upsert/delete are filtered to the current tenant (foreign FK target is not modified)', () => {
    expect(
      scope('update', {
        where: { id: 't1' },
        data: { project: { update: { name: 'x' } } },
      }),
    ).toEqual({
      where: { id: 't1', tenantId: 'acme' },
      data: { project: { update: { where: { tenantId: 'acme' }, data: { name: 'x' } } } },
    })
    expect(
      scope('update', {
        where: { id: 't1' },
        data: { project: { upsert: { create: { name: 'c' }, update: { name: 'u' } }, delete: true } },
      }),
    ).toEqual({
      where: { id: 't1', tenantId: 'acme' },
      data: {
        project: {
          upsert: { where: { tenantId: 'acme' }, create: { name: 'c', tenantId: 'acme' }, update: { name: 'u' } },
          delete: { tenantId: 'acme' },
        },
      },
    })
  })

  it('a relation write is still scoped when it carries keys Prisma drops (undefined / Prisma.skip)', () => {
    // Prisma ignores keys whose value is undefined or Prisma.skip, so such a key
    // must not hide a relation write from the scoper (it would then run unscoped).
    class Skip {
      ifUndefined<T>(value: T | undefined): T | Skip {
        return value === undefined ? this : value
      }
    }
    const skip = new Skip()
    expect(
      scope('create', { data: { title: 't', project: { connect: { id: 'g1' }, extra: undefined } } }),
    ).toEqual({
      data: { title: 't', tenantId: 'acme', project: { connect: { id: 'g1', tenantId: 'acme' }, extra: undefined } },
    })
    expect(
      scope('update', { where: { id: 'p1' }, data: { tasks: { connect: { id: 'gt1' }, extra: skip } } }),
    ).toEqual({
      where: { id: 'p1', tenantId: 'acme' },
      data: { tasks: { connect: { id: 'gt1', tenantId: 'acme' }, extra: skip } },
    })
    // the { where, data } form of a nested update is recognised the same way
    expect(
      scope('update', {
        where: { id: 'p1' },
        data: { tasks: { update: { where: { id: 'gt1' }, data: { title: 'x' }, extra: undefined } } },
      }),
    ).toEqual({
      where: { id: 'p1', tenantId: 'acme' },
      data: { tasks: { update: { where: { id: 'gt1', tenantId: 'acme' }, data: { title: 'x' } } } },
    })
    // a key holding only dropped values is not mistaken for a relation write
    expect(scope('update', { where: { id: 'p1' }, data: { meta: { extra: undefined } } })).toEqual({
      where: { id: 'p1', tenantId: 'acme' },
      data: { meta: { extra: undefined } },
    })
  })

  it('to-one disconnect booleans and non-relation values are left untouched', () => {
    expect(
      scope('update', {
        where: { id: 't1' },
        data: { owner: { disconnect: true }, meta: { color: 'red' }, at: new Date(0) },
      }),
    ).toEqual({
      where: { id: 't1', tenantId: 'acme' },
      data: { owner: { disconnect: true }, meta: { color: 'red' }, at: new Date(0) },
    })
  })
})

describe('TenantClientPool concurrency (F67)', () => {
  it('concurrent first use of a tenant creates exactly one client (no leaked connections)', async () => {
    let created = 0
    const pool = new TenantClientPool<{ n: number }>({
      create: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { n: ++created }
      },
    })
    const clients = await Promise.all(Array.from({ length: 50 }, () => pool.get('acme')))
    expect(created).toBe(1)
    expect(new Set(clients).size).toBe(1)
    expect(pool.size).toBe(1)
  })

  it('a failed creation is not cached, so the next call retries', async () => {
    let attempts = 0
    const pool = new TenantClientPool<{ ok: true }>({
      create: async () => {
        attempts++
        if (attempts === 1) throw new Error('boom')
        return { ok: true }
      },
    })
    await expect(pool.get('acme')).rejects.toThrow('boom')
    await expect(pool.get('acme')).resolves.toEqual({ ok: true })
    expect(attempts).toBe(2)
  })

  it('evicted clients are disconnected by default when they expose $disconnect()', async () => {
    const disconnected: string[] = []
    const pool = new TenantClientPool<{ id: string; $disconnect(): Promise<void> }>({
      create: (id) => ({ id, $disconnect: async () => void disconnected.push(id) }),
      max: 1,
    })
    await pool.get('a')
    await pool.get('b')
    expect(disconnected).toEqual(['a'])
    await pool.destroyAll()
    expect(disconnected).toEqual(['a', 'b'])
  })
})
