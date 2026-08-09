import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { commandsPlugin, defineCommand, memoryIo, parseArgv, renderTable, runCli } from '../src/index.js'

describe('parseArgv', () => {
  it('splits command, positional args and flags', () => {
    expect(parseArgv(['tenant:migrate', 'acme', '--fresh', '--step=2'])).toEqual({
      command: 'tenant:migrate',
      args: ['acme'],
      flags: { fresh: true, step: '2' },
    })
    expect(parseArgv([])).toEqual({ command: undefined, args: [], flags: {} })
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

  it('schedule:list reports when there is nothing scheduled', async () => {
    const io = memoryIo()
    const code = await runCli({ app: createApp(), argv: ['schedule:list'], io })
    expect(code).toBe(0)
    expect(io.lines).toEqual(['No scheduled tasks.'])
  })
})
