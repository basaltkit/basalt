import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { MemoryTenantSource, TENANCY, tenancyPlugin, type Tenant } from '../src/index.js'

interface Io {
  logs: string[]
  errors: string[]
  tables: Record<string, unknown>[][]
  log(m: string): void
  error(m: string): void
  table(r: Record<string, unknown>[]): void
}
const fakeIo = (): Io => {
  const logs: string[] = []
  const errors: string[] = []
  const tables: Record<string, unknown>[][] = []
  return { logs, errors, tables, log: (m) => logs.push(m), error: (m) => errors.push(m), table: (r) => tables.push(r) }
}

const source = () => {
  const s = new MemoryTenantSource()
  s.add({ id: 'acme', name: 'Acme' })
  s.add({ id: 'globex', name: 'Globex' })
  return s
}

async function boot(options: Parameters<typeof tenancyPlugin>[0], extra = [] as ReturnType<typeof definePlugin>[]) {
  const app = await createApp({ plugins: [tenancyPlugin(options), ...extra] }).boot()
  const list = ensureMetadata(app.container).get<{
    name: string
    handle: (ctx: unknown) => unknown
  }>('commands')
  return { app, run: (name: string, ctx: Partial<{ io: Io; args: string[]; flags: Record<string, unknown> }>) => {
    const cmd = list.find((c) => c.name === name)!
    return cmd.handle({ container: app.container, io: ctx.io, args: ctx.args ?? [], flags: ctx.flags ?? {} })
  } }
}

describe('tenant CLI commands', () => {
  it('tenant:list prints every tenant', async () => {
    const { run } = await boot({ source: source(), resolvers: [] })
    const io = fakeIo()
    await run('tenant:list', { io })
    expect(io.tables[0]!.map((r) => r['id'])).toEqual(['acme', 'globex'])
    expect(io.tables[0]![0]).toMatchObject({ id: 'acme', name: 'Acme' })
  })

  it('tenant:create persists a tenant with flag fields', async () => {
    const src = source()
    const { run } = await boot({ source: src, resolvers: [] })
    const io = fakeIo()
    await run('tenant:create', { io, args: ['initech'], flags: { name: 'Initech' } })
    expect(io.logs[0]).toContain('Created tenant "initech"')
    expect(await src.find('initech')).toMatchObject({ id: 'initech', name: 'Initech' })
  })

  it('tenant:create refuses an existing id with a clean error, leaving it unchanged', async () => {
    const src = source()
    const { run } = await boot({ source: src, resolvers: [] })
    const io = fakeIo()
    const code = await run('tenant:create', { io, args: ['acme'], flags: { name: 'Overwritten' } })
    expect(code).toBe(1)
    expect(io.errors[0]).toMatch(/Tenant "acme" already exists/)
    expect(await src.find('acme')).toMatchObject({ name: 'Acme' })
  })

  it('tenant:create in deferred mode says it is not provisioned yet', async () => {
    const src = source()
    const { run } = await boot({ source: src, resolvers: [], onProvision: () => {}, provision: 'deferred' })
    const io = fakeIo()
    await run('tenant:create', { io, args: ['initech'] })
    expect(io.logs[0]).toContain('provisioning is deferred')
    expect(io.logs[0]).toContain('basalt tenant:provision initech')
    expect(io.logs[0]).not.toContain('Created and provisioned')
    expect((await src.find('initech'))?.['status']).toBe('provisioning')
  })

  it('tenant:provision finishes a deferred tenant and emits tenancy:created', async () => {
    const src = source()
    const provisioned: string[] = []
    const { app, run } = await boot({
      source: src,
      resolvers: [],
      onProvision: (t: Tenant) => void provisioned.push(t.id),
      provision: 'deferred',
    })
    const announced: string[] = []
    app.hooks.on('tenancy:created', ({ tenant }: { tenant: Tenant }) => void announced.push(tenant.id))
    await run('tenant:create', { io: fakeIo(), args: ['initech'] })
    const io = fakeIo()
    expect(await run('tenant:provision', { io, args: ['initech'] })).toBeUndefined()
    expect(io.logs).toEqual(['Provisioned tenant "initech".'])
    expect(provisioned).toEqual(['initech'])
    expect(announced).toEqual(['initech'])
    expect((await src.find('initech'))?.['status']).toBe('ready')
  })

  it('tenant:provision reports a failing hook and leaves the tenant failed', async () => {
    const src = source()
    const { run } = await boot({
      source: src,
      resolvers: [],
      onProvision: () => {
        throw new Error('CREATE SCHEMA denied')
      },
    })
    const io = fakeIo()
    expect(await run('tenant:provision', { io, args: ['acme'] })).toBe(1)
    expect(io.errors[0]).toMatch(/Provisioning tenant "acme" failed, and it is marked "failed": CREATE SCHEMA denied/)
    expect((await src.find('acme'))?.['status']).toBe('failed')
  })

  it('tenant:provision refuses a missing id, an unknown tenant and a missing hook', async () => {
    const withHook = await boot({ source: source(), resolvers: [], onProvision: () => {} })
    let io = fakeIo()
    expect(await withHook.run('tenant:provision', { io })).toBe(1)
    expect(io.errors[0]).toBe('Usage: basalt tenant:provision <id>')
    io = fakeIo()
    expect(await withHook.run('tenant:provision', { io, args: ['nope'] })).toBe(1)
    expect(io.errors[0]).toMatch(/nope/)
    const without = await boot({ source: source(), resolvers: [] })
    io = fakeIo()
    expect(await without.run('tenant:provision', { io, args: ['acme'] })).toBe(1)
    expect(io.errors[0]).toMatch(/No provision hook configured/)
  })

  it.each(['suspended', 'deleting'] as const)('tenant:provision refuses a %s tenant and leaves it so', async (status) => {
    const src = new MemoryTenantSource()
    src.add({ id: 'acme', status })
    let ran = false
    const { run } = await boot({ source: src, resolvers: [], onProvision: () => void (ran = true) })
    const io = fakeIo()
    expect(await run('tenant:provision', { io, args: ['acme'] })).toBe(1)
    expect(io.errors[0]).toContain(status === 'deleting' ? 'is being deleted' : 'is suspended')
    expect(ran).toBe(false)
    expect((await src.find('acme'))?.['status']).toBe(status)
  })

  it('tenant:migrate runs the hook for all tenants, or one with --tenant', async () => {
    const seen: string[] = []
    const { run } = await boot({ source: source(), resolvers: [], onMigrate: (t: Tenant) => void seen.push(t.id) })
    await run('tenant:migrate', { io: fakeIo() })
    expect(seen.sort()).toEqual(['acme', 'globex'])
    seen.length = 0
    await run('tenant:migrate', { io: fakeIo(), flags: { tenant: 'acme' } })
    expect(seen).toEqual(['acme'])
  })

  it('tenant:migrate errors when no hook is configured', async () => {
    const { run } = await boot({ source: source(), resolvers: [] })
    const io = fakeIo()
    const code = await run('tenant:migrate', { io })
    expect(code).toBe(1)
    expect(io.errors[0]).toMatch(/No migrate hook configured/)
  })

  it('tenant:run executes a sub-command inside the tenant context', async () => {
    let sawTenant: string | undefined
    const probe = definePlugin({
      name: 'probe',
      register({ container }) {
        ensureMetadata(container).add('commands', {
          name: 'whoami',
          description: 'probe',
          handle: () => {
            sawTenant = container.get(TENANCY).current()?.id
          },
        })
      },
    })
    const { run } = await boot({ source: source(), resolvers: [] }, [probe])
    await run('tenant:run', { io: fakeIo(), args: ['globex', 'whoami'] })
    expect(sawTenant).toBe('globex')
  })

  it('tenant:run reports an unknown tenant or command', async () => {
    const { run } = await boot({ source: source(), resolvers: [] })
    const io = fakeIo()
    expect(await run('tenant:run', { io, args: ['nope', 'whoami'] })).toBe(1)
    expect(io.errors[0]).toMatch(/not found/)
  })
})
