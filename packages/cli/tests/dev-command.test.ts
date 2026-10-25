import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { memoryIo, runCli } from '../src/index.js'

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
