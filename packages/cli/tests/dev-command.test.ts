import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { memoryIo, runCli, runDev } from '../src/index.js'

// What happened, in order: the app's own shutdown and each process `basalt dev` starts.
const events: string[] = []

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    events.push(`spawn ${command} ${args.join(' ')}`)
    const child = Object.assign(new EventEmitter(), { kill: () => true })
    setTimeout(() => child.emit('exit', 0), 0) // the server stops at once: the session ends
    return child
  },
}))

describe('basalt dev', () => {
  it('prints the routes, then shuts its own boot down before the server starts: one app per session', async () => {
    events.length = 0
    const app = createApp({
      plugins: [
        definePlugin({
          name: 'app:db',
          boot: ({ container }) => {
            events.push('boot')
            ensureMetadata(container).add('http:routes', { method: 'get', url: '/health' })
          },
          shutdown: () => { events.push('shutdown') },
        }),
      ],
    })
    const io = memoryIo()
    const code = await runCli({ app, argv: ['dev', '--entry=src/dev.ts'], io })

    expect(code).toBe(0)
    expect(io.lines.join('\n')).toContain('/health')
    expect(events[0]).toBe('boot')
    expect(events[1]).toBe('shutdown') // before the server, and only once (runCli's own is a no-op)
    expect(events[2]).toMatch(/^spawn (tsx watch|node --watch --experimental-strip-types) src\/dev\.ts$/)
    expect(events.filter((e) => e === 'shutdown')).toHaveLength(1)
  })

  it('with --worker, starts the server and the worker after the shutdown too', async () => {
    events.length = 0
    const app = createApp({
      plugins: [definePlugin({ name: 'app:db', shutdown: () => { events.push('shutdown') } })],
    })
    await runCli({ app, argv: ['dev', '--entry=src/dev.ts', '--worker', '--no-routes'], io: memoryIo() })
    expect(events[0]).toBe('shutdown')
    expect(events.slice(1).every((e) => e.startsWith('spawn '))).toBe(true)
    expect(events[2]).toContain('queue:work')
  })
})

describe('runDev (bin/basalt.ts sends `dev` here before booting anything)', () => {
  const dbPlugin = (boot: () => void | Promise<void>) =>
    definePlugin({
      name: 'app:db',
      boot: async ({ container }) => {
        await boot()
        events.push('boot')
        ensureMetadata(container).add('http:routes', { method: 'get', url: '/health' })
      },
      shutdown: () => { events.push('shutdown') },
    })

  it('boots once for the route table, shuts it down, then starts the server', async () => {
    events.length = 0
    const io = memoryIo()
    const code = await runDev({ argv: ['dev', '--entry=src/dev.ts'], io, loadApp: () => createApp({ plugins: [dbPlugin(() => {})] }) })
    expect(code).toBe(0)
    expect(io.lines.join('\n')).toContain('/health')
    expect(events.slice(0, 2)).toEqual(['boot', 'shutdown'])
    expect(events[2]).toMatch(/^spawn .* src\/dev\.ts$/)
  })

  it('an app that does not boot (invalid env) still gets its server: the reason is printed, the watcher starts', async () => {
    events.length = 0
    const io = memoryIo()
    const invalid = Object.assign(new Error('Invalid environment'), { code: 'ENV_INVALID', report: ['DATABASE_URL: Required'] })
    const code = await runDev({ argv: ['dev', '--entry=src/dev.ts'], io, loadApp: () => { throw invalid } })
    expect(code).toBe(0)
    expect(io.errors[0]).toContain('does not boot yet')
    expect(io.errors.join('\n')).toContain('- DATABASE_URL: Required')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatch(/^spawn /)
  })

  it('a boot that fails half-way (database down) is shut down, and the server starts', async () => {
    events.length = 0
    const io = memoryIo()
    const down = Object.assign(new Error("Can't reach database server at localhost:5432\n  more"), { code: 'P1001' })
    const code = await runDev({
      argv: ['dev', '--entry=src/dev.ts'], io,
      loadApp: () => createApp({ plugins: [definePlugin({ name: 'app:ok', shutdown: () => { events.push('shutdown') } }), dbPlugin(() => { throw down })] }),
    })
    expect(code).toBe(0)
    expect(io.errors.join('\n')).toContain("Can't reach database server at localhost:5432")
    expect(io.errors.join('\n')).not.toContain('more')
    expect(events[0]).toBe('shutdown') // what did boot is released before the server starts
    expect(events[1]).toMatch(/^spawn /)
  })

  it('a boot that hangs does not hold the session: after the timeout the server starts', async () => {
    events.length = 0
    const io = memoryIo()
    const code = await runDev({
      argv: ['dev', '--entry=src/dev.ts'], io, bootTimeoutMs: 20,
      loadApp: () => createApp({ plugins: [dbPlugin(() => new Promise(() => {}))] }),
    })
    expect(code).toBe(0)
    expect(io.errors[0]).toContain('did not boot within')
    expect(events[0]).toMatch(/^spawn /)
  })

  it('--no-routes never loads the app', async () => {
    events.length = 0
    const loadApp = vi.fn()
    expect(await runDev({ argv: ['dev', '--entry=src/dev.ts', '--no-routes'], io: memoryIo(), loadApp })).toBe(0)
    expect(loadApp).not.toHaveBeenCalled()
  })
})
