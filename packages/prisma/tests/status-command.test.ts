import { describe, expect, it } from 'vitest'
import { dbStatusCommand, parseMigrateStatus, prismaStatusArgs, type PrismaCliRunner } from '../src/index.js'

const UP = `3 migrations found in prisma/migrations\n\nDatabase schema is up to date!\n`
const PENDING = `3 migrations found in prisma/migrations\nFollowing migrations have not yet been applied:\n20240101_a\n20240102_b\n\nTo apply migrations in production run prisma migrate deploy.\n`
const UNREACHABLE = `Error: P1001: Can't reach database server at \`db:5432\``

describe('parseMigrateStatus (BK-041)', () => {
  it('recognises the states Prisma prints', () => {
    expect(parseMigrateStatus(UP, 0)).toEqual({ state: 'up-to-date' })
    expect(parseMigrateStatus(PENDING, 1)).toMatchObject({ state: 'pending', pending: 2, detail: '20240101_a, 20240102_b' })
    expect(parseMigrateStatus('Following migration have failed:\n20240101_a\n', 1)).toMatchObject({ state: 'failed' })
    expect(
      parseMigrateStatus('Your local migration history and the migrations table from your database are different:', 1),
    ).toMatchObject({ state: 'drift' })
    expect(parseMigrateStatus('The current database is not managed by Prisma Migrate.', 1)).toMatchObject({
      state: 'unmanaged',
      fix: expect.stringContaining('migrate resolve --applied'),
    })
    expect(parseMigrateStatus(UNREACHABLE, 1)).toMatchObject({ state: 'error', fix: expect.stringContaining('DATABASE_URL') })
    // an unknown failure is never "up to date"
    expect(parseMigrateStatus('something odd', 1).state).toBe('error')
  })

  it('builds read-only argv per plane', () => {
    expect(prismaStatusArgs({ configPath: 'prisma/tenant/prisma.config.ts' })).toEqual([
      'prisma',
      'migrate',
      'status',
      '--config',
      'prisma/tenant/prisma.config.ts',
    ])
  })
})

const ioCapture = () => {
  const lines: string[] = []
  return {
    lines,
    io: {
      log: (m: string) => void lines.push(m),
      error: (m: string) => void lines.push(m),
      table: () => {},
      confirm: async () => false,
    },
  }
}

describe('db:status (BK-041)', () => {
  const calls: { args: string[]; env: Record<string, string | undefined> }[] = []
  const runner =
    (byUrl: Record<string, string>): PrismaCliRunner =>
    async (args, env) => {
      calls.push({ args, env })
      const output = env['DATABASE_URL'] ? (byUrl[env['DATABASE_URL']] ?? UP) : UP
      return { output, exitCode: output === UP ? 0 : 1 }
    }

  it('checks the central plane and every tenant, and exits 1 when a tenant lags', async () => {
    calls.length = 0
    const { io, lines } = ioCapture()
    const command = dbStatusCommand({
      central: { configPath: 'prisma.config.ts' },
      tenants: {
        list: () => ['acme', 'globex'],
        target: { mode: 'schema', url: 'postgresql://u:p@db:5432/app' },
        configPath: 'prisma/tenant/prisma.config.ts',
      },
      run: runner({ 'postgresql://u:p@db:5432/app?schema=tenant_globex': PENDING }),
    })
    const code = await command.handle({ io, args: [], flags: {} })
    expect(code).toBe(1)
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.args.slice(0, 3).join(' ') === 'prisma migrate status')).toBe(true)
    expect(lines.join('\n')).toContain('ok   central')
    expect(lines.join('\n')).toContain('FAIL tenant globex (tenant_globex): 2 pending')
    expect(lines.join('\n')).toContain('Tenants: 1 up to date, 1 not.')
  })

  it('--json reports every plane and exits 0 when all are up to date', async () => {
    const { io, lines } = ioCapture()
    const command = dbStatusCommand({
      tenants: { list: () => ['acme'], target: { mode: 'database', urlFor: (id) => `postgresql://db/${id}` } },
      run: runner({}),
    })
    expect(await command.handle({ io, args: [], flags: { json: true } })).toBe(0)
    const report = JSON.parse(lines[0]!) as { ok: boolean; planes: { plane: string; state: string }[] }
    expect(report.ok).toBe(true)
    expect(report.planes.map((p) => `${p.plane}:${p.state}`)).toEqual(['central:up-to-date', 'tenant:up-to-date'])
  })

  it('reports an unreachable plane with its fix, not a crash', async () => {
    const { io, lines } = ioCapture()
    const command = dbStatusCommand({
      run: async () => ({ output: UNREACHABLE, exitCode: 1 }),
    })
    expect(await command.handle({ io, args: [], flags: {} })).toBe(1)
    expect(lines.join('\n')).toMatch(/fix: Check DATABASE_URL/)
  })
})
