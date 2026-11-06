import { describe, expect, it } from 'vitest'
import { HookBus, tryCtx } from '@basaltkit/core'
import {
  MemoryTenantSource,
  Tenancy,
  TenantNotReadyError,
  TenantStatusUnknownError,
  TenantSuspendedError,
  type Tenant,
  type TenantStatus,
} from '../src/index.js'

// BK-018: outside a request nothing ran the serving check, so a job, a
// command or a refresh by cookie entered suspended / deleting / provisioning
// tenants. `run(id, fn, { serving: true })` refuses them with the enricher's errors.

const setup = (tenants: Tenant[]) => {
  const source = new MemoryTenantSource()
  for (const tenant of tenants) source.add(tenant)
  const hooks = new HookBus()
  const switched: string[] = []
  hooks.on('tenancy:switched', ({ tenant }) => void switched.push(tenant.id))
  return { tenancy: new Tenancy({ source, resolvers: [], hooks }), switched }
}

const refusals: Array<[TenantStatus | 'unknown', new (...args: never[]) => Error]> = [
  ['provisioning', TenantNotReadyError],
  ['failed', TenantNotReadyError],
  ['deleting', TenantNotReadyError],
  ['suspended', TenantSuspendedError],
  ['unknown', TenantStatusUnknownError],
]

describe('tenancy.run({ serving: true })', () => {
  it.each(refusals)('refuses a %s tenant, before entering it or emitting hooks', async (status, ErrorType) => {
    const { tenancy, switched } = setup([{ id: 'acme', name: 'Acme', status: status as TenantStatus }])
    let ran = false
    const attempt = tenancy.run('acme', () => void (ran = true), { serving: true })
    await expect(attempt).rejects.toBeInstanceOf(ErrorType)
    expect(ran).toBe(false)
    expect(switched).toEqual([])
  })

  it('checks a tenant object by its own status too', async () => {
    const { tenancy } = setup([])
    await expect(
      tenancy.run({ id: 'acme', name: 'Acme', status: 'suspended' }, () => 1, { serving: true }),
    ).rejects.toBeInstanceOf(TenantSuspendedError)
  })

  it.each<[string, TenantStatus | undefined]>([
    ['ready', 'ready'],
    ['without a status (pre-status records)', undefined],
  ])('enters a %s tenant', async (_label, status) => {
    const { tenancy, switched } = setup([{ id: 'acme', name: 'Acme', ...(status ? { status } : {}) }])
    const id = await tenancy.run('acme', () => tryCtx()?.tenant?.id, { serving: true })
    expect(id).toBe('acme')
    expect(switched).toEqual(['acme'])
  })

  it.each(refusals)('without the option (default) still enters a %s tenant — the old behaviour', async (status) => {
    const { tenancy } = setup([{ id: 'acme', name: 'Acme', status: status as TenantStatus }])
    await expect(tenancy.run('acme', () => tryCtx()?.tenant?.id)).resolves.toBe('acme')
    await expect(tenancy.run('acme', () => tryCtx()?.tenant?.id, { serving: false })).resolves.toBe('acme')
  })
})
