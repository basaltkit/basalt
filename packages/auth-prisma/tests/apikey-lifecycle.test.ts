import { ApiKeys } from '@basaltkit/auth'
import { describe, expect, it } from 'vitest'
import {
  API_KEY_LIFECYCLE_MIGRATION_SQL,
  ApiKeySchemaOutdatedError,
  ColumnLengthError,
  PrismaApiKeyStore,
  type PrismaAuthClient,
} from '../src/index.js'
import { apiKeyStoreContract } from './apikey-store-contract.js'
import { makeFakeClient } from './fake-client.js'

// BK-083 (c)/(e)/(f): API key lifecycle on Prisma (auth-prisma 3.0).
apiKeyStoreContract('PrismaApiKeyStore', () => new PrismaApiKeyStore(makeFakeClient()))

const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => expect.unreachable('expected a rejection'),
    (e: unknown) => e,
  )

const failingStore = (error: unknown): PrismaApiKeyStore => {
  const reject = async (): Promise<never> => {
    throw error
  }
  return new PrismaApiKeyStore({
    authApiKey: { findUnique: reject, findMany: reject, create: reject, updateMany: reject },
  } as unknown as PrismaAuthClient)
}

describe('PrismaApiKeyStore 3.0 schema (BK-083)', () => {
  it('a P2022 for a lifecycle column becomes AUTH_API_KEY_SCHEMA_OUTDATED with the 3.0 migration SQL', async () => {
    const original = Object.assign(new Error('The column `auth_api_keys.previousHash` does not exist in the current database.'), {
      code: 'P2022',
      meta: { modelName: 'AuthApiKey', column: 'auth_api_keys.previousHash' },
    })
    const err = await rejection(failingStore(original).findByHash('h'))
    expect(err).toBeInstanceOf(ApiKeySchemaOutdatedError)
    expect((err as Error).cause).toBe(original)
    const message = (err as Error).message
    expect(message).toContain('3.0.0')
    expect(message).toContain('add_api_key_lifecycle')
    expect(message).toContain(API_KEY_LIFECYCLE_MIGRATION_SQL.postgresql)
    expect(message).toContain(API_KEY_LIFECYCLE_MIGRATION_SQL.mysql)
    expect(message).toContain('basalt tenant:migrate')
  })

  it('a client generated before 3.0 ("Unknown argument `previousHash`") is recognised too', async () => {
    const validation = Object.assign(
      new Error('Invalid `prisma.authApiKey.findUnique()` invocation: Unknown argument `previousHash`. Available options are marked with ?.'),
      { name: 'PrismaClientValidationError' },
    )
    expect(await rejection(failingStore(validation).findByHash('h'))).toBeInstanceOf(ApiKeySchemaOutdatedError)
    const unknownField = new Error('Unknown field `serviceId` for select statement on model `AuthApiKey`.')
    expect(await rejection(failingStore(unknownField).list({ serviceId: 's' }))).toBeInstanceOf(ApiKeySchemaOutdatedError)
    // update goes through the same mapping.
    expect(await rejection(failingStore(validation).update('k', { name: 'x' }))).toBeInstanceOf(ApiKeySchemaOutdatedError)
  })

  it('an unrelated validation error is not relabelled', async () => {
    const other = new Error('Unknown argument `colour`. Did you mean `color`?')
    expect(await rejection(failingStore(other).findById('k'))).toBe(other)
  })

  it('update sends one updateMany with the live-row and compare-and-set conditions', async () => {
    const calls: unknown[] = []
    const client = makeFakeClient()
    const updateMany = client.authApiKey.updateMany.bind(client.authApiKey)
    client.authApiKey.updateMany = async (args: unknown) => {
      calls.push(args)
      return updateMany(args)
    }
    const store = new PrismaApiKeyStore(client)
    await store.create({ id: 'k1', name: 'k', prefix: 'mk_live_aaaaaa', hash: 'h1', scopes: ['*'], createdAt: 1 })
    await store.update('k1', { hash: 'h2', previousHash: 'h1', previousHashExpiresAt: 10, rotatedAt: 5 }, { ifHash: 'h1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      where: { id: 'k1', revokedAt: null, hash: 'h1' },
      data: { hash: 'h2', previousHash: 'h1', previousHashExpiresAt: new Date(10), rotatedAt: new Date(5) },
    })
  })

  it("clears allowedIps/meta with [] and {} (Prisma refuses a bare null for Json)", async () => {
    const client = makeFakeClient()
    const store = new PrismaApiKeyStore(client)
    await store.create({ id: 'k1', name: 'k', prefix: 'mk_live_aaaaaa', hash: 'h1', scopes: ['*'], createdAt: 1, allowedIps: ['10.0.0.1'], meta: { a: 'b' } })
    const updateMany = client.authApiKey.updateMany.bind(client.authApiKey)
    let sent: { data?: Record<string, unknown> } = {}
    client.authApiKey.updateMany = async (args: { data?: Record<string, unknown> }) => {
      sent = args
      return updateMany(args)
    }
    await store.update('k1', { allowedIps: null, meta: null })
    expect(sent.data).toEqual({ allowedIps: [], meta: {} })
  })

  it("columnLimits: 'mysql' bounds serviceId and previousHash", async () => {
    const store = new PrismaApiKeyStore(makeFakeClient(), { columnLimits: 'mysql' })
    const base = { id: 'k1', name: 'k', prefix: 'mk_live_aaaaaa', hash: 'h1', scopes: ['*'], createdAt: 1 }
    await expect(store.create({ ...base, serviceId: 's'.repeat(192) })).rejects.toBeInstanceOf(ColumnLengthError)
    await store.create(base)
    await expect(store.update('k1', { previousHash: 'p'.repeat(192) })).rejects.toBeInstanceOf(ColumnLengthError)
  })

  it('end to end: ApiKeys.rotate keeps the old secret only for the grace window', async () => {
    let now = 1_000_000
    const keys = new ApiKeys({ store: new PrismaApiKeyStore(makeFakeClient()), now: () => now })
    const { record, key: oldKey } = await keys.issue({ name: 'ci' })
    const { key: newKey } = await keys.rotate(record.id, { graceMs: 1_000 })
    expect((await keys.verify(oldKey))?.id).toBe(record.id)
    now += 1_000
    expect(await keys.verify(oldKey)).toBeNull()
    expect((await keys.verify(newKey))?.id).toBe(record.id)
  })
})
