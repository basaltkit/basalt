import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { commandsPlugin, defineCommand, memoryIo, parseArgv, renderTable, routeAllowPattern, runCli } from '../src/index.js'

describe('parseArgv', () => {
  it('splits command, positional args and flags', () => {
    expect(parseArgv(['tenant:migrate', 'acme', '--fresh', '--step=2'])).toEqual({
      command: 'tenant:migrate',
      args: ['acme'],
      flags: { fresh: true, step: '2' },
    })
    expect(parseArgv([])).toEqual({ command: undefined, args: [], flags: {} })
  })

  // `basalt dev --no-routes` is documented (CLI README, queue/dev changelogs)
  // but was a no-op: `--no-routes` landed as `flags['no-routes'] = true` while
  // dev.ts tests `flags['routes'] !== false`, which is never false.
  it('negates --no-<flag> into <flag>: false, so documented opt-outs work', () => {
    expect(parseArgv(['dev', '--no-routes'])).toEqual({
      command: 'dev',
      args: [],
      flags: { routes: false },
    })
  })

  it('lets a later explicit flag win over the negation, and vice versa', () => {
    expect(parseArgv(['dev', '--no-routes', '--routes']).flags).toEqual({ routes: true })
    expect(parseArgv(['dev', '--routes', '--no-routes']).flags).toEqual({ routes: false })
  })

  it('only negates the bare form — --no-x=value stays a literal key', () => {
    expect(parseArgv(['gen', '--no-register=maybe']).flags).toEqual({ 'no-register': 'maybe' })
  })
})

describe('renderTable', () => {
  it('aligns columns and handles missing cells', () => {
    const output = renderTable([
      { method: 'GET', url: '/health' },
      { method: 'DELETE', url: '/projects/:id' },
    ])
    expect(output).toContain('method  url')
    expect(output).toContain('DELETE  /projects/:id')
  })
})

describe('runCli', () => {
  it('runs a registered command with args, flags and exit code 0', async () => {
    const io = memoryIo()
    const seen: unknown[] = []
    const app = createApp({
      plugins: [
        commandsPlugin([
          defineCommand({
            name: 'greet',
            description: 'Greets someone',
            handle: ({ args, flags, io }) => {
              seen.push({ args, flags })
              io.log(`Hello, ${args[0]}!`)
            },
          }),
        ]),
      ],
    })

    const code = await runCli({ app, argv: ['greet', 'world', '--loud'], io })
    expect(code).toBe(0)
    expect(seen).toEqual([{ args: ['world'], flags: { loud: true } }])
    expect(io.lines).toEqual(['Hello, world!'])
    expect(app.phase).toBe('stopped') // app was booted and shut down by the runner
  })

  it('propagates the command exit code', async () => {
    const io = memoryIo()
    const app = createApp({
      plugins: [commandsPlugin([defineCommand({ name: 'fail', handle: () => 3 })])],
    })
    expect(await runCli({ app, argv: ['fail'], io })).toBe(3)
  })

  it('unknown command prints an error and returns 1', async () => {
    const io = memoryIo()
    const code = await runCli({ app: createApp(), argv: ['nope'], io })
    expect(code).toBe(1)
    expect(io.errors[0]).toMatch(/Unknown command "nope"/)
    expect(io.errors).toHaveLength(1)
  })

  it('points an old bin/basalt.ts at create-basalt for the project commands', async () => {
    const io = memoryIo()
    expect(await runCli({ app: createApp(), argv: ['update'], io })).toBe(1)
    expect(io.errors[1]).toContain('npx create-basalt@latest update')
  })

  it('list (and empty argv) shows built-ins plus registered commands', async () => {
    const io = memoryIo()
    const app = createApp({
      plugins: [commandsPlugin([defineCommand({ name: 'db:seed', description: 'Seed', handle: () => {} })])],
    })
    const code = await runCli({ app, argv: [], io })
    expect(code).toBe(0)
    const output = io.lines.join('\n')
    expect(output).toContain('routes')
    expect(output).toContain('schedule:list')
    expect(output).toContain('db:seed')
  })

  it('routes command renders the http:routes metadata bucket', async () => {
    const io = memoryIo()
    const producer = definePlugin({
      name: 'fake-adapter',
      register({ container }) {
        const metadata = ensureMetadata(container)
        metadata.add('http:routes', { method: 'GET', url: '/health' })
        metadata.add('http:routes', { method: 'POST', url: '/projects' })
      },
    })
    const code = await runCli({ app: createApp({ plugins: [producer] }), argv: ['routes'], io })
    expect(code).toBe(0)
    expect(io.lines[0]).toContain('GET')
    expect(io.lines[0]).toContain('/projects')
  })

  describe('routes guards, --json and --unguarded (BK-025)', () => {
    const producer = definePlugin({
      name: 'fake-adapter',
      register({ container }) {
        const metadata = ensureMetadata(container)
        metadata.add('http:routes', { method: 'GET', url: '/health', meta: { auth: false } })
        metadata.add('http:routes', {
          method: 'POST',
          url: '/projects',
          meta: { auth: true, can: 'projects:create', rateLimit: { limit: 10, windowMs: 60_000 }, tenant: true },
        })
        metadata.add('http:routes', { method: 'GET', url: '/projects', meta: { auth: true } })
        metadata.add('http:routes', { method: 'POST', url: '/webhooks/stripe', meta: {} })
      },
    })
    const run = async (...argv: string[]) => {
      const io = memoryIo()
      const code = await runCli({ app: createApp({ plugins: [producer] }), argv: ['routes', ...argv], io })
      return { code, io }
    }

    it('prints a guard column per declared key', async () => {
      const { code, io } = await run()
      expect(code).toBe(0)
      const [table] = io.lines
      expect(table?.split('\n')[0]).toMatch(/^method\s+url\s+auth\s+can\s+rateLimit\s+tenant\s+guards/)
      expect(table).toMatch(/POST\s+\/projects\s+true\s+projects:create\s+10\/1m\s+required/)
      expect(table).toMatch(/GET\s+\/health\s+false/)
    })

    it('--json prints one parseable array of route rows', async () => {
      const { code, io } = await run('--json')
      expect(code).toBe(0)
      expect(io.lines).toHaveLength(1)
      const rows = JSON.parse(io.lines[0] as string) as { url: string; method: string; can: string[] | null }[]
      expect(rows.map((r) => `${r.method} ${r.url}`)).toEqual([
        'GET /health',
        'GET /projects',
        'POST /projects',
        'POST /webhooks/stripe',
      ])
      expect(rows[2]?.can).toEqual(['projects:create'])
    })

    it('--unguarded exits 1 and names the offenders and what they miss', async () => {
      const { code, io } = await run('--unguarded', '--require=auth,can')
      expect(code).toBe(1)
      expect(io.errors[0]).toContain('2 route(s) do not declare auth + can')
      const output = io.lines.join('\n')
      expect(output).toMatch(/GET\s+\/projects\s+can/)
      expect(output).toMatch(/POST\s+\/webhooks\/stripe\s+auth, can/)
      expect(output).toContain('Checks route meta only')
    })

    it('--allow exempts matching routes; a clean run exits 0', async () => {
      const { code, io } = await run('--unguarded', '--require=auth', '--allow=POST /webhooks/*')
      expect(code).toBe(0)
      expect(io.lines[0]).toContain('declare auth')
    })

    it('--unguarded --json prints the offenders with their missing guards', async () => {
      const { code, io } = await run('--unguarded', '--require=can', '--json', '--allow=/webhooks/**')
      expect(code).toBe(1)
      expect(JSON.parse(io.lines[0] as string)).toEqual([
        expect.objectContaining({ method: 'GET', url: '/projects', missing: ['can'] }),
      ])
    })

    it('--unguarded refuses to run without an explicit, known --require', async () => {
      expect((await run('--unguarded')).code).toBe(2)
      const unknown = await run('--unguarded', '--require=auth,mfa')
      expect(unknown.code).toBe(2)
      expect(unknown.io.errors[0]).toContain('mfa')
    })
  })

  it('routeAllowPattern matches * within a segment and ** across segments', () => {
    expect(routeAllowPattern('/webhooks/*')({ method: 'POST', url: '/webhooks/stripe' })).toBe(true)
    expect(routeAllowPattern('/webhooks/*')({ method: 'POST', url: '/webhooks/a/b' })).toBe(false)
    expect(routeAllowPattern('/webhooks/**')({ method: 'POST', url: '/webhooks/a/b' })).toBe(true)
    expect(routeAllowPattern('get /health')({ method: 'GET', url: '/health' })).toBe(true)
    expect(routeAllowPattern('GET /health')({ method: 'POST', url: '/health' })).toBe(false)
    expect(routeAllowPattern('/a.b')({ method: 'GET', url: '/axb' })).toBe(false)
  })

  it('schedule:list reports when there is nothing scheduled', async () => {
    const io = memoryIo()
    const code = await runCli({ app: createApp(), argv: ['schedule:list'], io })
    expect(code).toBe(0)
    expect(io.lines).toEqual(['No scheduled tasks.'])
  })
})
