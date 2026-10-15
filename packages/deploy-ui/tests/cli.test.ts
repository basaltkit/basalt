import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { main, parseFlags, processDeps, USAGE, type CliDeps } from '../src/cli.js'
import { openBrowser, openerCommand } from '../src/open.js'
import type { Spawn } from '../src/remote.js'
import type { UiServer, UiServerOptions } from '../src/server.js'

describe('flags', () => {
  it('targets, ssh, no-open, idle minutes; never a host or a port', () => {
    expect(parseFlags(['--targets=t.json', '--ssh=/usr/bin/ssh', '--no-open', '--idle-minutes=30'], '/home/alice')).toEqual({ targets: '/home/alice/t.json', ssh: '/usr/bin/ssh', open: false, pair: false, idleMinutes: 30, help: false })
    expect(parseFlags(['--pair'], '/')).toMatchObject({ pair: true, open: true })
    expect(parseFlags(['-h'], '/')).toMatchObject({ help: true })
    for (const bad of ['--host=0.0.0.0', '--port=8080', '--ssh=ssh', '--idle-minutes=0', '--idle-minutes=241', '--idle-minutes=x', 'serve', '--targets']) {
      expect(() => parseFlags([bad], '/'), bad).toThrow()
    }
  })
})

describe('the browser opener', () => {
  it('argv per platform, never a shell', () => {
    const url = 'http://127.0.0.1:41234/#launch=abc'
    expect(openerCommand('darwin', url)).toEqual({ command: 'open', args: [url] })
    expect(openerCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] })
    expect(openerCommand('freebsd', url)).toEqual({ command: 'xdg-open', args: [url] })
    // Absolute on Windows: a bare name would be looked up in the working directory first.
    expect(openerCommand('win32', url)).toEqual({ command: 'C:\\Windows\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler', url] })
    expect(openerCommand('win32', url, { SystemRoot: 'D:\\WINNT' }).command).toBe('D:\\WINNT\\System32\\rundll32.exe')
    expect(openerCommand('win32', url, { SystemRoot: '.\\planted' }).command).toBe('C:\\Windows\\System32\\rundll32.exe')
  })

  it('reports whether it worked', async () => {
    const fake = (code: number | 'error' | 'throw'): Spawn => (command, args, options) => {
      expect(options.shell).toBe(false)
      if (code === 'throw') throw new Error('nope')
      const child = Object.assign(new EventEmitter(), { unref: () => undefined }) as unknown as ChildProcess
      setTimeout(() => (code === 'error' ? child.emit('error', new Error('ENOENT')) : child.emit('exit', code)), 1)
      return child
    }
    expect(await openBrowser(fake(0), 'linux', 'u')).toBe(true)
    let seen: { command: string; cwd: unknown } | undefined
    const recording: Spawn = (command, args, options) => { seen = { command, cwd: options.cwd }; return fake(0)(command, args, options) }
    expect(await openBrowser(recording, 'win32', 'u', 'C:\\Users\\alice', { SystemRoot: 'C:\\Windows' })).toBe(true)
    expect(seen).toEqual({ command: 'C:\\Windows\\System32\\rundll32.exe', cwd: 'C:\\Users\\alice' })
    expect(await openBrowser(fake(3), 'linux', 'u')).toBe(false)
    expect(await openBrowser(fake('error'), 'darwin', 'u')).toBe(false)
    expect(await openBrowser(fake('throw'), 'win32', 'u')).toBe(false)
  })
})

describe('main', () => {
  function deps(overrides: Partial<CliDeps> = {}) {
    const printed: string[] = []
    let options: UiServerOptions | undefined
    let signal: (() => void) | undefined
    let closed = false
    const server: UiServer = { port: 41234, url: 'http://127.0.0.1:41234/', launchUrl: 'http://127.0.0.1:41234/#launch=CODE', close: async () => { closed = true } }
    const d: CliDeps = {
      platform: 'linux', env: { XDG_CONFIG_HOME: '/home/alice/.cfg' }, cwd: '/home/alice/app', home: '/home/alice', osUser: 'alice',
      spawn: (() => { throw new Error('no spawn in this test') }) as Spawn,
      print: (line) => printed.push(line),
      open: async () => true,
      start: async (o) => { options = o; return server },
      onSignal: (listener) => { signal = listener },
      ...overrides,
    }
    return { d, printed, options: () => options as UiServerOptions, signal: () => signal?.(), closed: () => closed }
  }

  it('help and usage errors exit at once', async () => {
    const help = deps()
    expect(await main(['--help'], help.d)).toBe(0)
    expect(help.printed.join('\n')).toBe(USAGE.trimEnd())
    expect(USAGE).toContain('Never add @basaltkit/deploy-ui to an app\'s package.json')
    const bad = deps()
    expect(await main(['--port=80'], bad.d)).toBe(2)
    expect(bad.printed[0]).toMatch(/no --host or --port/)
  })

  it('starts the server with the operator\'s targets and ssh, opens the browser, stops on a signal', async () => {
    const run = deps()
    const done = main([], run.d)
    await new Promise((r) => setTimeout(r, 5))
    const o = run.options()
    expect(o.targetsPath).toBe('/home/alice/.cfg/basalt/deploy-targets.json')
    // ssh starts in the operator's home, never in the folder the UI was started from.
    expect(o.runner).toMatchObject({ program: 'ssh', prefix: [], cwd: '/home/alice' })
    expect(o.runner.env).toBe(run.d.env)
    expect(o.osUser).toBe('alice')
    expect(run.printed.join('\n')).toContain('listening on http://127.0.0.1:41234/')
    // The launch code is not printed when the browser opened.
    expect(run.printed.join('\n')).not.toContain('CODE')
    run.signal()
    expect(await done).toBe(0)
    expect(run.closed()).toBe(true)
  })

  it('--no-open or a failed opener prints the one-time URL; idle and quit end it', async () => {
    const quiet = deps({ open: async () => { throw new Error('must not open') } })
    const done = main(['--no-open', '--ssh=/opt/ssh', '--idle-minutes=5'], quiet.d)
    await new Promise((r) => setTimeout(r, 5))
    expect(quiet.printed.join('\n')).toContain('http://127.0.0.1:41234/#launch=CODE')
    expect(quiet.options()).toMatchObject({ idleMinutes: 5, runner: { program: '/opt/ssh' } })
    quiet.options().onStop?.('idle')
    expect(await done).toBe(0)
    expect(quiet.printed.join('\n')).toContain('stopped after 5 idle minutes')

    const failed = deps({ open: async () => false, platform: 'win32' })
    const ended = main([], failed.d)
    await new Promise((r) => setTimeout(r, 5))
    expect(failed.printed.join('\n')).toContain('#launch=CODE')
    expect(failed.options().runner.program).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
    failed.options().onStop?.('quit')
    expect(await ended).toBe(0)
  })

  it('--pair: the browser gets the bare URL, the terminal the code — nothing secret in the opener\'s argv', async () => {
    const opened: string[] = []
    const paired = deps({ open: async (url) => { opened.push(url); return true }, start: async (o) => { paired.options = () => o; return { port: 41234, url: 'http://127.0.0.1:41234/', launchUrl: 'http://127.0.0.1:41234/', pairCode: 'ABCD-EFGH', close: async () => undefined } } }) as ReturnType<typeof deps> & { options: () => UiServerOptions }
    const done = main(['--pair'], paired.d)
    await new Promise((r) => setTimeout(r, 5))
    expect(paired.options()).toMatchObject({ pair: true })
    expect(opened).toEqual(['http://127.0.0.1:41234/'])
    expect(paired.printed.join('\n')).toContain('pairing code ABCD-EFGH — type it in the page within 2 minutes (5 tries)')
    paired.options().onStop?.('quit')
    expect(await done).toBe(0)
    expect(USAGE).toContain('--pair')
  })

  it('the process dependencies are the real ones', () => {
    const real = processDeps()
    expect(real.platform).toBe(process.platform)
    expect(real.env).toBe(process.env)
    expect(typeof real.home).toBe('string')
  })
})
