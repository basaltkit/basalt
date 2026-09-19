import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  MissingTenantError,
  RawQueryInTenantContextError,
  setTenantConfigSql,
  tenancyExtension,
  tenantConfigParams,
  tenantTransaction,
} from '../src/index.js'

type Hook = (params: {
  model?: string
  operation: string
  args: unknown
  query: (args: unknown) => Promise<unknown>
  __internalParams?: unknown
}) => Promise<unknown>

interface Hooks {
  $allModels: { $allOperations: Hook }
  $allOperations: Hook
}

/**
 * A fake Prisma client: records raw statements and batch transactions, and
 * captures the extension `$extends` receives (the function form hands it the
 * client, like Prisma does).
 */
function fakeClient() {
  const calls: unknown[][] = []
  const client = {
    calls,
    extension: undefined as undefined | { name: string; query: Hooks },
    $executeRawUnsafe(sql: string, ...values: unknown[]) {
      calls.push(['$executeRawUnsafe', sql, ...values])
      return Promise.resolve(1)
    },
    async $transaction(arg: unknown, options?: unknown) {
      if (Array.isArray(arg)) {
        calls.push(['$transaction:batch', arg.length])
        return Promise.all(arg)
      }
      calls.push(['$transaction:itx', options])
      return (arg as (tx: unknown) => Promise<unknown>)(client)
    },
    $extends(extension: unknown) {
      if (typeof extension === 'function') return extension(client)
      client.extension = extension as { name: string; query: Hooks }
      return client
    },
  }
  return client
}

/** Dispatches a model operation through both hooks, as Prisma does. */
const dispatch = (hooks: Hooks, operation: string, args: unknown, internal?: unknown) =>
  hooks.$allModels.$allOperations({
    model: 'Project',
    operation,
    args,
    __internalParams: internal,
    query: (a) =>
      hooks.$allOperations({ model: 'Project', operation, args: a, query: async (x) => ({ ran: x }) }),
  })

const raw = (hooks: Hooks, operation: string, args: unknown) =>
  hooks.$allOperations({ operation, args, query: async () => 'raw-ran' })

const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithContext({ tenant: { id } }, fn)

describe('tenancyExtension({ rls }) — BK-011', () => {
  it('without rls it stays the plain extension object (backwards compatible)', () => {
    const ext = tenancyExtension()
    expect(typeof ext).toBe('object')
    expect(ext.name).toBe('basalt-tenancy')
  })

  it('rls: true runs each tenant-scoped operation after set_config, in one batch transaction', async () => {
    const client = fakeClient()
    client.$extends(tenancyExtension({ rls: true }))
    const hooks = client.extension!.query

    const result = await inTenant('acme', () => dispatch(hooks, 'findMany', {}))

    expect(result).toEqual({ ran: { where: { tenantId: 'acme' } } })
    expect(client.calls).toEqual([
      ['$executeRawUnsafe', setTenantConfigSql(), 'app.tenant_id', 'acme'],
      ['$transaction:batch', 2],
    ])
  })

  it('rls: { setting } uses the configured Postgres setting', async () => {
    const client = fakeClient()
    client.$extends(tenancyExtension({ rls: { setting: 'basalt.tenant' } }))
    await inTenant('acme', () => dispatch(client.extension!.query, 'count', {}))
    expect(client.calls[0]).toEqual(['$executeRawUnsafe', setTenantConfigSql(), 'basalt.tenant', 'acme'])
  })

  it('an invalid setting fails when the extension is built, not per query', () => {
    expect(() => tenancyExtension({ rls: { setting: "x'; drop table t; --" } })).toThrow(/Invalid setting/)
  })

  it('an operation already inside a transaction is not wrapped again', async () => {
    const client = fakeClient()
    client.$extends(tenancyExtension({ rls: true }))
    const hooks = client.extension!.query
    await inTenant('acme', () => dispatch(hooks, 'findMany', {}, { transaction: { kind: 'itx', id: 't1' } }))
    await inTenant('acme', () => dispatch(hooks, 'findMany', {}, { transaction: { kind: 'batch', id: 1 } }))
    expect(client.calls).toEqual([])
  })

  it('no tenant: still fails closed; bypass runs unscoped without set_config', async () => {
    const strict = fakeClient()
    strict.$extends(tenancyExtension({ rls: true }))
    await expect(dispatch(strict.extension!.query, 'findMany', {})).rejects.toBeInstanceOf(MissingTenantError)

    const admin = fakeClient()
    admin.$extends(tenancyExtension({ rls: true, onMissingTenant: 'bypass' }))
    expect(await dispatch(admin.extension!.query, 'findMany', {})).toEqual({ ran: {} })
    expect(admin.calls).toEqual([])
  })
})

describe('raw guard and the set_config statement — BK-011', () => {
  const hooks = tenancyExtension().query as unknown as Hooks

  it('lets through set_config for the tenant already in scope (the documented wiring)', async () => {
    const args = [setTenantConfigSql(), ...tenantConfigParams('acme')]
    expect(await inTenant('acme', () => raw(hooks, '$executeRawUnsafe', args))).toBe('raw-ran')
  })

  it('still refuses every other raw query inside a tenant context', async () => {
    await expect(
      inTenant('acme', () => raw(hooks, '$executeRawUnsafe', [setTenantConfigSql(), ...tenantConfigParams('globex')])),
    ).rejects.toBeInstanceOf(RawQueryInTenantContextError)
    await expect(
      inTenant('acme', () => raw(hooks, '$executeRawUnsafe', [setTenantConfigSql(), 'other.setting', 'acme'])),
    ).rejects.toBeInstanceOf(RawQueryInTenantContextError)
    await expect(
      inTenant('acme', () => raw(hooks, '$executeRawUnsafe', [`${setTenantConfigSql()}; delete from t`, 'app.tenant_id', 'acme'])),
    ).rejects.toBeInstanceOf(RawQueryInTenantContextError)
    await expect(
      inTenant('acme', () => raw(hooks, '$queryRawUnsafe', ['select * from projects'])),
    ).rejects.toBeInstanceOf(RawQueryInTenantContextError)
  })

  it('with rls: { setting } only that setting is exempt', async () => {
    const client = fakeClient()
    client.$extends(tenancyExtension({ rls: { setting: 'basalt.tenant' } }))
    const h = client.extension!.query
    expect(await inTenant('acme', () => raw(h, '$executeRawUnsafe', [setTenantConfigSql(), 'basalt.tenant', 'acme']))).toBe('raw-ran')
    await expect(
      inTenant('acme', () => raw(h, '$executeRawUnsafe', [setTenantConfigSql(), 'app.tenant_id', 'acme'])),
    ).rejects.toBeInstanceOf(RawQueryInTenantContextError)
  })
})

describe('tenantTransaction — BK-011', () => {
  it('runs set_config on the transaction first, then fn(tx)', async () => {
    const client = fakeClient()
    const result = await inTenant('acme', () =>
      tenantTransaction(client, async (tx) => {
        expect(tx).toBe(client)
        client.calls.push(['fn'])
        return 'done'
      }, { transaction: { timeout: 10_000 } }),
    )
    expect(result).toBe('done')
    expect(client.calls).toEqual([
      ['$transaction:itx', { timeout: 10_000 }],
      ['$executeRawUnsafe', setTenantConfigSql(), 'app.tenant_id', 'acme'],
      ['fn'],
    ])
  })

  it('takes an explicit tenant and setting', async () => {
    const client = fakeClient()
    await tenantTransaction(client, async () => undefined, { tenantId: 'globex', setting: 'basalt.tenant' })
    expect(client.calls[1]).toEqual(['$executeRawUnsafe', setTenantConfigSql(), 'basalt.tenant', 'globex'])
  })

  it('refuses to open a transaction with no tenant in scope', async () => {
    const client = fakeClient()
    await expect(tenantTransaction(client, async () => undefined)).rejects.toBeInstanceOf(MissingTenantError)
    expect(client.calls).toEqual([])
  })
})
