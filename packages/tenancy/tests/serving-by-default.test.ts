import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, HookBus, runWithContext, tryCtx } from '@basaltkit/core'
import {
  MemoryTenantSource,
  Tenancy,
  TENANCY,
  tenancyPlugin,
  TenantNotReadyError,
  TenantStatusUnknownError,
  TenantSuspendedError,
  type TenancyOptions,
  type Tenant,
  type TenantRunner,
  type TenantStatus,
} from '../src/index.js'

// BK-018 as a minor: `servingByDefault: true`, set once at the composition
// root, makes every `run()` refuse a tenant that cannot serve. The framework's
// own lifecycle paths keep entering such tenants with `{ serving: false }`.

const strict = (tenants: Tenant[]) => {
  const source = new MemoryTenantSource()
  for (const tenant of tenants) source.add(tenant)
  const hooks = new HookBus()
  const switched: string[] = []
  hooks.on('tenancy:switched', ({ tenant }) => void switched.push(tenant.id))
  return { source, switched, tenancy: (more: Partial<TenancyOptions> = {}) =>
    new Tenancy({ source, resolvers: [], hooks, servingByDefault: true, ...more }) }
}

const refusals: Array<[TenantStatus | 'unknown', new (...args: never[]) => Error]> = [
  ['provisioning', TenantNotReadyError],
  ['failed', TenantNotReadyError],
  ['deleting', TenantNotReadyError],
  ['suspended', TenantSuspendedError],
  ['unknown', TenantStatusUnknownError],
]

describe('servingByDefault: true', () => {
  it.each(refusals)('run() without options refuses a %s tenant before entering it', async (status, ErrorType) => {
    const { tenancy, switched } = strict([{ id: 'acme', name: 'Acme', status: status as TenantStatus }])
    let ran = false
    await expect(tenancy().run('acme', () => void (ran = true))).rejects.toBeInstanceOf(ErrorType)
    expect(ran).toBe(false)
    expect(switched).toEqual([])
  })

  it.each(refusals)('{ serving: false } still enters a %s tenant', async (status) => {
    const { tenancy } = strict([{ id: 'acme', name: 'Acme', status: status as TenantStatus }])
    await expect(tenancy().run('acme', () => tryCtx()?.tenant?.id, { serving: false })).resolves.toBe('acme')
  })

  it('enters a ready tenant and one without a status', async () => {
    const { tenancy } = strict([
      { id: 'acme', name: 'Acme', status: 'ready' },
      { id: 'legacy', name: 'Legacy' },
    ])
    await expect(tenancy().run('acme', () => tryCtx()?.tenant?.id)).resolves.toBe('acme')
    await expect(tenancy().run('legacy', () => tryCtx()?.tenant?.id)).resolves.toBe('legacy')
  })

  it('provision() runs onProvision inside a tenant that is not ready yet', async () => {
    const { tenancy, source } = strict([])
    const seen: Array<string | undefined> = []
    const t = tenancy({ onProvision: () => void seen.push(tryCtx()?.tenant?.id) })
    const created = await t.create({ id: 'acme', name: 'Acme' })
    expect(seen).toEqual(['acme'])
    expect(created['status']).toBe('ready')
    expect((await source.find('acme'))?.['status']).toBe('ready')
  })

  it('destroy() runs onDeprovision inside the tenant it just marked deleting', async () => {
    const { tenancy, source } = strict([{ id: 'acme', name: 'Acme', status: 'suspended' }])
    const seen: Array<string | undefined> = []
    await tenancy({ onDeprovision: () => void seen.push(tryCtx()?.tenant?.id) }).destroy('acme')
    expect(seen).toEqual(['acme'])
    expect(await source.find('acme')).toBeNull()
  })

  it('forEach() enters every tenant whatever its status', async () => {
    const { tenancy } = strict([
      { id: 'acme', name: 'Acme', status: 'ready' },
      { id: 'globex', name: 'Globex', status: 'suspended' },
      { id: 'initech', name: 'Initech', status: 'provisioning' },
    ])
    const seen: string[] = []
    await tenancy().forEach((tenant) => void seen.push(`${tenant.id}:${tryCtx()?.tenant?.id}`))
    expect(seen.sort()).toEqual(['acme:acme', 'globex:globex', 'initech:initech'])
  })
})

describe('tenancyPlugin({ servingByDefault: true })', () => {
  let probed: string | undefined
  const probe = definePlugin({
    name: 'probe',
    register({ container }) {
      ensureMetadata(container).add('commands', {
        name: 'probe',
        description: 'probe',
        handle: () => void (probed = tryCtx()?.tenant?.id),
      })
    },
  })

  const boot = async () => {
    const source = new MemoryTenantSource()
      .add({ id: 'acme', name: 'Acme', status: 'ready' })
      .add({ id: 'globex', name: 'Globex', status: 'suspended' })
    const migrated: string[] = []
    const app = await createApp({
      plugins: [
        tenancyPlugin({
          source,
          resolvers: [],
          servingByDefault: true,
          onMigrate: (tenant) => void migrated.push(tenant.id),
        }),
        probe,
      ],
    }).boot()
    const meta = ensureMetadata(app.container)
    const commands = meta.get<{ name: string; handle: (ctx: unknown) => unknown }>('commands')
    const io = { logs: [] as string[], errors: [] as string[], log(m: string) { this.logs.push(m) }, error(m: string) { this.errors.push(m) }, table() {} }
    const command = (name: string, args: string[] = [], flags: Record<string, unknown> = {}) =>
      commands.find((c) => c.name === name)!.handle({ container: app.container, io, args, flags })
    return { app, migrated, command, run: meta.get<TenantRunner>('tenancy:run')[0]! }
  }

  it('passes the option to the TENANCY singleton', async () => {
    const { app } = await boot()
    await expect(app.container.get(TENANCY).run('globex', () => 1)).rejects.toBeInstanceOf(TenantSuspendedError)
    await app.shutdown()
  })

  it("the 'tenancy:run' signal (jobs, webhook deliveries) refuses a suspended tenant", async () => {
    const { app, run } = await boot()
    let ran = false
    await expect(runWithContext({}, () => run('globex', () => (ran = true)))).rejects.toBeInstanceOf(TenantSuspendedError)
    expect(ran).toBe(false)
    await expect(runWithContext({}, () => run('acme', () => tryCtx()?.tenant?.id))).resolves.toBe('acme')
    await app.shutdown()
  })

  it('tenant:migrate still reaches every tenant, one by one or all', async () => {
    const { app, migrated, command } = await boot()
    await command('tenant:migrate', [], { tenant: 'globex' })
    await command('tenant:migrate')
    expect(migrated.sort()).toEqual(['acme', 'globex', 'globex'])
    await app.shutdown()
  })

  it('tenant:run enters a suspended tenant the operator names', async () => {
    const { app, command } = await boot()
    probed = undefined
    await command('tenant:run', ['globex', 'probe'])
    expect(probed).toBe('globex')
    await app.shutdown()
  })
})
