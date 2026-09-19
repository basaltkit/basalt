import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import {
  InvalidTenantIdError,
  MemoryTenantSource,
  Tenancy,
  TENANCY,
  tenancyPlugin,
  TenantRequiredError,
  isValidTenantId,
  tenantScoped,
} from '../src/index.js'

// Ids that smuggle a namespace delimiter used downstream: cache (':'),
// storage ('/', '..', '\\'), realtime (' '), plus control chars and case.
const HOSTILE_IDS = [
  'globex:user',
  'globex/files',
  '..',
  '.',
  'a\\b',
  'acme x',
  'acme\u0000',
  'acme\n',
  'Acme',
  '',
  '-acme',
  'a'.repeat(64),
  '%2e%2e',
  'global', // reserved: the platform-wide sentinel scope
]

describe('security: tenant ids follow a canonical grammar (no namespace-delimiter smuggling)', () => {
  it('isValidTenantId accepts slugs, uuids and cuids', () => {
    for (const id of ['acme', 'globex-2', 'tenant_1', '0', 'a'.repeat(63), '3f1c2a9e-8f5b-4c1d-9a6e-2b7c1d0e4f5a', 'clx0abc123def']) {
      expect(isValidTenantId(id), id).toBe(true)
    }
  })

  it('isValidTenantId rejects ids containing delimiters, traversal, control chars or upper case', () => {
    for (const id of HOSTILE_IDS) expect(isValidTenantId(id), JSON.stringify(id)).toBe(false)
  })

  it('Tenancy.create refuses a hostile id before anything is persisted', async () => {
    const source = new MemoryTenantSource().add({ id: 'globex' })
    const tenancy = new Tenancy(source, [])
    for (const id of HOSTILE_IDS) {
      await expect(tenancy.create({ id }), JSON.stringify(id)).rejects.toBeInstanceOf(InvalidTenantIdError)
      expect(await source.find(id)).toBeNull()
    }
    await expect(tenancy.create({ id: 'globex:user' })).rejects.toMatchObject({ code: 'TENANT_ID_INVALID', status: 400 })
    await expect(tenancy.create({ id: 'initech' })).resolves.toMatchObject({ id: 'initech' })
  })

  it('the shipped MemoryTenantSource refuses a hostile id on create and save', async () => {
    const source = new MemoryTenantSource()
    await expect(source.create({ id: 'globex/files' })).rejects.toBeInstanceOf(InvalidTenantIdError)
    await expect(source.save({ id: '..' })).rejects.toBeInstanceOf(InvalidTenantIdError)
    expect(await source.list()).toEqual([])
  })

  it('tenancyPlugin accepts a stricter or looser validateTenantId, still enforced by create()', async () => {
    const app = await createApp({
      plugins: [
        tenancyPlugin({
          source: new MemoryTenantSource(),
          resolvers: [],
          validateTenantId: (id) => /^org-[a-z]+$/.test(id),
        }),
      ],
    }).boot()
    const tenancy = app.container.get(TENANCY)
    await expect(tenancy.create({ id: 'acme' })).rejects.toBeInstanceOf(InvalidTenantIdError)
    await expect(tenancy.create({ id: 'org-acme' })).resolves.toMatchObject({ id: 'org-acme' })
  })
})

describe('security: tenantScoped never takes the tenant from client-supplied where.tenantId', () => {
  it('throws with no context tenant even when where carries a tenantId', () => {
    runWithContext({}, () => {
      expect(() => tenantScoped({ tenantId: 'globex' })).toThrowError(TenantRequiredError)
      expect(() => tenantScoped({ tenantId: 'globex', archived: false })).toThrowError(TenantRequiredError)
    })
    expect(() => tenantScoped({ tenantId: 'globex' })).toThrowError(TenantRequiredError)
  })
})
