import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT_ABORTED, EXIT_LOCKED, main } from '../src/cli.js'
import { DeployAbortedError } from '../src/context.js'
import { nodeHost, type Output } from '../src/host.js'
import { acquireLock, DeployLockedError, lockFile, takeoverFile } from '../src/lock.js'
import { envCommand, rollback, run, status } from '../src/pipeline.js'
import { readReleases } from '../src/state.js'
import { acmeConfig, context, DIR, FakeHost, jlist, ok } from './fake-host.js'
import { NEW, OLD, server } from './acme-server.js'

const LOCK = lockFile(`${DIR}/.basalt`)
const config = () => acmeConfig({ backup: { beforeMigrate: false } })
const holder = (pid: number, host = 'server-1') => JSON.stringify({ pid, host, startedAt: '2026-10-11T11:59:00.000Z', actor: 'alice', command: 'run' })

describe('the deploy lock', () => {
  it('refuses a second deploy while one runs, and changes nothing', async () => {
    const { host, head } = server()
    host.alive.add(777)
    host.put(LOCK, holder(777), 0o600)
    const ctx = context(host, config())
    await expect(run(ctx)).rejects.toThrow(DeployLockedError)
    await expect(envCommand(ctx)).rejects.toThrow(/another deploy is running: run by alice \(pid 777 on server-1/)
    await expect(rollback(ctx, OLD)).rejects.toThrow(DeployLockedError)
    expect(head()).toBe(OLD)
    expect(host.commands('git')).toEqual([])
    expect(host.file(LOCK)).toBe(holder(777))
  })

  it('two runs at once: one deploys, the other is refused; one release recorded', async () => {
    const { host } = server()
    const ctx = context(host, config())
    const [first, second] = await Promise.allSettled([run(ctx), run({ ...ctx })])
    expect(first).toEqual({ status: 'fulfilled', value: 0 })
    expect(second.status).toBe('rejected')
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(DeployLockedError)
    expect(await readReleases(ctx)).toHaveLength(1)
    expect(host.files.has(LOCK)).toBe(false)
  })

  it('takes over a stale lock (its process is gone on this host)', async () => {
    const { host } = server()
    host.put(LOCK, holder(999), 0o600)
    expect(await run(context(host, config()))).toBe(0)
    expect(host.transcript).toContain('removed a stale lock: run by alice (pid 999 on server-1')
    expect(host.files.has(LOCK)).toBe(false)
  })

  it('never guesses about another host or an unreadable lock', async () => {
    const { host } = server()
    host.put(LOCK, holder(999, 'server-2'), 0o600)
    await expect(run(context(host, config()))).rejects.toThrow(`or, if nothing runs on server-2: rm ${LOCK}`)
    host.put(LOCK, '', 0o600)
    await expect(run(context(host, config()))).rejects.toThrow(/is not a deploy lock/)
  })

  it('is released after a failure too, with the lock file 0600 while held', async () => {
    const { host } = server({ buildFails: true })
    let seen: number | undefined
    host.handlers.unshift(({ command, args }) => {
      if (command === 'pnpm' && args[0] === 'install') seen = host.mode(LOCK)
      return undefined
    })
    await expect(run(context(host, config()))).rejects.toThrow(/pnpm install/)
    expect(seen).toBe(0o600)
    expect(host.files.has(LOCK)).toBe(false)
    expect(host.signalListeners).toEqual([])
  })

  it('does not remove a lock that is no longer its own', async () => {
    const { host } = server()
    host.handlers.unshift(({ command, args }) => {
      // Someone removed the lock by hand and another deploy took it meanwhile.
      if (command === 'pnpm' && args[0] === 'install') host.put(LOCK, holder(888), 0o600)
      return undefined
    })
    host.alive.add(888)
    expect(await run(context(host, config()))).toBe(0)
    expect(host.file(LOCK)).toBe(holder(888))
  })

  it('RACE: two deploys that both judged the same lock stale — only one takes it', async () => {
    // A and B share one server (one file tree); both see pid 999's lock, dead.
    const a = new FakeHost()
    const b = new FakeHost()
    b.files = a.files
    b.processId = 4200
    a.alive.add(4200)
    b.alive = a.alive
    const state = `${DIR}/.basalt`
    a.dir(state, 0o700)
    a.put(LOCK, holder(999), 0o600)
    // B stops right after it read the stale holder; A then takes over and holds the lock.
    let resume!: () => void
    const paused = new Promise<void>((r) => { resume = r })
    let reads = 0
    const read = b.readPlainFile.bind(b)
    b.readPlainFile = async (path, max) => {
      const text = await read(path, max)
      if (path === LOCK && ++reads === 1) await paused
      return text
    }
    const second = acquireLock(b, state, 'run', 'bob')
    const releaseA = await acquireLock(a, state, 'run', 'alice')
    expect(JSON.parse(a.file(LOCK) ?? '{}')).toMatchObject({ pid: 4100 })
    resume()
    await expect(second).rejects.toThrow(/another deploy is running: run by alice \(pid 4100/)
    // A's lock is still there, still A's — B removed nothing.
    expect(JSON.parse(a.file(LOCK) ?? '{}')).toMatchObject({ pid: 4100 })
    expect(a.files.has(takeoverFile(state))).toBe(false)
    await releaseA()
    expect(a.files.has(LOCK)).toBe(false)
  })

  it('a takeover in progress refuses the other deploy, and says how to clear one left behind', async () => {
    const host = new FakeHost()
    const state = `${DIR}/.basalt`
    host.put(LOCK, holder(999), 0o600).put(takeoverFile(state), holder(998), 0o600)
    await expect(acquireLock(host, state, 'run', 'bob')).rejects.toThrow(`another deploy is taking over the stale lock in ${state} — if none runs (a takeover lasts milliseconds): rm ${takeoverFile(state)}`)
    expect(host.file(LOCK)).toBe(holder(999))
  })

  it('EXPLOIT: a lock swapped for a directory or a link is never removed recursively, nor read through', async () => {
    const host = new FakeHost()
    const state = `${DIR}/.basalt`
    const release = await acquireLock(host, state, 'install', 'root')
    // The app user owns the directory: it replaces the lock with a directory holding a file.
    host.files.delete(LOCK)
    host.dir(LOCK, 0o755).put(`${LOCK}/victim`, 'x')
    await release()
    expect(host.file(`${LOCK}/victim`)).toBe('x')
    // A link to a device is not read (a FIFO or /dev/zero would hang root).
    host.files.delete(`${LOCK}/victim`)
    host.files.delete(LOCK)
    host.files.set(LOCK, { kind: 'symlink', target: '/dev/zero' })
    await expect(acquireLock(host, state, 'install', 'root')).rejects.toThrow(/is not a deploy lock/)
  })

  it('status says whether a deploy runs, and whose', async () => {
    const { host } = server()
    host.on(({ command }) => (command === 'pm2' ? ok(jlist()) : undefined))
    const ctx = context(host, config())
    await status(ctx)
    expect(host.transcript).toContain('no deploy running')
    host.alive.add(777)
    host.put(LOCK, holder(777), 0o600)
    await status(ctx)
    expect(host.transcript).toContain('deploy running: run by alice (pid 777 on server-1')
    host.alive.delete(777)
    await status(ctx)
    expect(host.transcript).toMatch(/stale lock: .* the next deploy takes it over/)
  })
})

describe('signals', () => {
  it('SIGINT during the build: stops at the next step, puts the code back, records "aborted"', async () => {
    const { host, head } = server()
    host.handlers.unshift(({ command, args }) => {
      if (command === 'pnpm' && args[0] === 'install' && head() === NEW && !host.transcript.includes('SIGINT')) host.signal('SIGINT')
      return undefined
    })
    const ctx = context(host, config())
    await expect(run(ctx)).rejects.toThrow(DeployAbortedError)
    expect(head()).toBe(OLD)
    expect(host.printed.filter((l) => l.startsWith('STEP')).map((l) => l.slice(5))).not.toContain('validate')
    expect(host.commands('pm2').filter((c) => c.startsWith('pm2 restart') || c.startsWith('pm2 start'))).toEqual([])
    expect((await readReleases(ctx))[0]).toMatchObject({ sha: NEW, status: 'aborted' })
    expect(host.files.has(LOCK)).toBe(false)
    expect(host.signalListeners).toEqual([])
  })

  it('a child killed by the same SIGINT is reported as the signal, not as a build failure', async () => {
    const { host, head } = server({ buildFails: true })
    host.handlers.unshift(({ command, args }) => {
      if (command === 'pnpm' && args[0] === 'install' && head() === NEW) host.signal('SIGINT')
      return undefined
    })
    const ctx = context(host, config())
    await expect(run(ctx)).rejects.toThrow(/stopped by SIGINT — pnpm install --frozen-lockfile failed/)
    expect((await readReleases(ctx))[0]).toMatchObject({ status: 'aborted' })
  })

  it('a signal during the release does not interrupt it: the deploy finishes', async () => {
    const { host } = server()
    host.handlers.unshift(({ command, args }) => {
      if (command === 'pm2' && args[0] === 'restart') host.signal('SIGTERM')
      return undefined
    })
    const ctx = context(host, config())
    expect(await run(ctx)).toBe(0)
    expect(host.transcript).toContain('SIGTERM: run cannot stop safely at this point')
    expect((await readReleases(ctx))[0]).toMatchObject({ status: 'ok' })
  })

  it('env stops before writing when a signal arrives first', async () => {
    const { host } = server({ env: 'PAYCO_FAKE=0\n' })
    host.answers = ['', 'tok']
    host.handlers.unshift(({ command }) => {
      if (command === 'ss') host.signal('SIGHUP')
      return undefined
    })
    await expect(envCommand(context(host, config()))).rejects.toThrow(/stopped by SIGHUP/)
    expect(host.file(`${DIR}/.env`)).toBe('PAYCO_FAKE=0\n')
  })
})

describe('the CLI exit codes', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-lock-'))
    await writeFile(join(dir, 'deploy.config.mjs'), `export default { app: 'acme', domain: 'acme.example.com', env: {}, runtime: { kind: 'pm2', script: 'start', port: 3002, avoid: [] } }\n`)
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('3 when another deploy holds the lock', async () => {
    const { host } = server()
    host.alive.add(777)
    host.put(lockFile(join(dir, '.basalt')), holder(777), 0o600)
    expect(await main(['run', '--config=deploy.config.mjs'], host, dir)).toBe(EXIT_LOCKED)
    expect(host.transcript).toContain('another deploy is running')
    expect(EXIT_ABORTED).toBe(130)
  })
})

describe('the real host', () => {
  const quiet: Output = { step() {}, info() {}, ok() {}, warn() {}, error() {} }
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-excl-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('creates a lock exclusively and never through a symlink', async () => {
    const host = nodeHost(quiet)
    const path = join(dir, 'deploy.lock')
    expect(await host.createExclusive(path, 'a', 0o600)).toBe(true)
    expect(await host.createExclusive(path, 'b', 0o600)).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('a')
    const target = join(dir, 'target')
    await symlink(target, join(dir, 'planted.lock'))
    expect(await host.createExclusive(join(dir, 'planted.lock'), 'x', 0o600)).toBe(false)
    await expect(readFile(target, 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('removeFile unlinks a link itself, refuses a directory, ignores what is not there', async () => {
    const host = nodeHost(quiet)
    const target = join(dir, 'kept')
    await writeFile(target, 'keep')
    await symlink(target, join(dir, 'link.lock'))
    await host.removeFile(join(dir, 'link.lock'))
    expect(await readFile(target, 'utf8')).toBe('keep')
    await mkdir(join(dir, 'swapped.lock'))
    await writeFile(join(dir, 'swapped.lock', 'victim'), 'x')
    await expect(host.removeFile(join(dir, 'swapped.lock'))).rejects.toThrow()
    expect((await stat(join(dir, 'swapped.lock', 'victim'))).isFile()).toBe(true)
    await host.removeFile(join(dir, 'never-there'))
  })

  it('knows whether a process runs', () => {
    const host = nodeHost(quiet)
    expect(host.processAlive(process.pid)).toBe(true)
    expect(host.processAlive(2 ** 22 + 12345)).toBe(false)
    expect(host.pid()).toBe(process.pid)
    expect(host.hostname()).toBeTruthy()
  })

  it('hands the first signal to the listener and unsubscribes cleanly', () => {
    const host = nodeHost(quiet)
    const heard: string[] = []
    const before = process.listenerCount('SIGTERM')
    const off = host.onSignal((s) => heard.push(s))
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    process.emit('SIGTERM', 'SIGTERM')
    expect(heard).toEqual(['SIGTERM'])
    off()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})
