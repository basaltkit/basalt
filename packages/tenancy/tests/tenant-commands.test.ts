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
