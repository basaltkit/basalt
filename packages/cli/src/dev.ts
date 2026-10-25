import { ensureMetadata, type BasaltApp, type Container } from '@basaltkit/core'
import { defineCommand, type CommandDefinition, type CommandIo } from './command.js'
import { consoleIo } from './io.js'
import { parseArgv } from './parse.js'

/**
 * Default entry files probed in order when `--entry` is not given. A
 * create-basalt app's `src/dev.ts` comes first: it is what `pnpm dev` runs
 * (it loads `.env` and opts into NODE_ENV=development before the server).
 */
export const DEV_ENTRY_CANDIDATES = ['src/dev.ts', 'src/main.ts', 'src/server.ts', 'src/index.ts', 'src/main.js', 'src/index.js']

/**
 * Picks the first candidate that exists. Pure — `exists` is injected so the
 * resolution is testable without touching disk.
 */
export function resolveDevEntry(
  candidates: string[],
  exists: (path: string) => boolean,
): string | undefined {
  return candidates.find(exists)
}

export interface DevRunner {
  command: string
  args: string[]
}

/**
 * Chooses how to run the entry with watch/restart, delegating the actual
 * watching to the runtime (no bespoke watcher). Pure and testable:
 *
 * - `.ts` with tsx available → `tsx watch <entry>`
 * - `.ts` without tsx        → `node --watch --experimental-strip-types <entry>` (Node ≥ 22.6)
 * - `.js`                     → `node --watch <entry>`
 */
export function resolveDevRunner(entry: string, options: { tsx?: boolean } = {}): DevRunner {
  const isTs = /\.tsx?$/.test(entry)
  if (isTs && options.tsx) return { command: 'tsx', args: ['watch', entry] }
  if (isTs) return { command: 'node', args: ['--watch', '--experimental-strip-types', entry] }
  return { command: 'node', args: ['--watch', entry] }
}

/** A route as published into the `http:routes` metadata bucket by an adapter. */
export interface DevRoute {
  method: string
  url: string
  meta?: Record<string, unknown>
}

/**
 * Formats the registered routes into printable rows (method, url, and a compact
 * flags column for auth/rate-limit) — sorted by url then method. Pure: this is
 * what `basalt dev` prints on boot, and `pnpm dev` (plain tsx watch) can't.
 */
export function devRouteRows(routes: DevRoute[]): { method: string; url: string; flags: string }[] {
  return [...routes]
    .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))
    .map((r) => {
      const flags: string[] = []
      if (r.meta?.['auth'] === true) flags.push('auth')
      if (r.meta?.['rateLimit']) flags.push('rate-limit')
      const tags = r.meta?.['tags']
      if (Array.isArray(tags) && tags.length) flags.push(...tags.map(String))
      return { method: r.method.toUpperCase(), url: r.url, flags: flags.join(', ') }
    })
}

/**
 * `basalt dev [--entry=<file>] [--worker] [--queue=<name>] [--no-routes]`
 *
 * A richer dev loop than a bare `tsx watch`: prints the app's **route table** on
 * boot (the app is already booted by the CLI runner, so routes are known), then
 * runs the server with watch/restart — and, with `--worker`, also starts a
 * watched queue worker alongside it (server + worker in one command, the real
 * producer/worker topology).
 *
 * The CLI's own boot exists only to read the route table: it is shut down
 * before the server starts, so a dev session holds one app (one database
 * pool, one set of connections), not two. A create-basalt `bin/basalt.ts`
 * sends `dev` to {@link runDev} before booting anything, so the session also
 * starts while the app cannot boot; this command is the path for a bin
 * without that prelude.
 */
export const devCommand: CommandDefinition = defineCommand({
  name: 'dev',
  description: 'Run the app with watch + restart, print the route table, and (--worker) an embedded queue worker',
  async handle({ app, container, io, flags }) {
    const entry = await devEntry(flags, io)
    if (!entry) return 1
    if (flags['routes'] !== false) printRoutes(container, io)
    // Done with the CLI's boot: the server below is the app from here on.
    // runCli's own shutdown afterwards is a no-op.
    await app.shutdown()
    return startDevProcesses(entry, flags, io)
  },
})

export interface RunDevOptions {
  /** Defaults to process.argv.slice(2) — `dev` first, as typed. */
  argv?: string[]
  /** Imports and builds the app, unbooted — only to read its route table. */
  loadApp: () => BasaltApp | Promise<BasaltApp>
  io?: CommandIo
  /** How long the route table may wait for the boot before the server starts without it. @default 10000 */
  bootTimeoutMs?: number
}

/**
 * `basalt dev` without depending on the app booting. The app is loaded and
 * booted once, only to print the route table, then shut down. When that fails
 * — a variable missing, the database down, code mid-edit — the reason is
 * printed and the watcher starts anyway: it restarts the server on every save,
 * as `pnpm dev` does, so you fix the problem and the session carries on.
 */
export async function runDev(options: RunDevOptions): Promise<number> {
  const io = options.io ?? consoleIo()
  const { flags } = parseArgv(options.argv ?? process.argv.slice(2))
  const entry = await devEntry(flags, io)
  if (!entry) return 1
  if (flags['routes'] !== false) await routesIfItBoots(options, io)
  return startDevProcesses(entry, flags, io)
}

async function routesIfItBoots(options: RunDevOptions, io: CommandIo): Promise<void> {
  let app: BasaltApp | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = options.bootTimeoutMs ?? 10_000
  const boot = (async () => {
    app = await options.loadApp()
    if (app.phase === 'created') await app.boot()
    return app
  })()
  const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
  try {
    const booted = await Promise.race([boot, timedOut])
    if (booted === 'timeout') {
      io.error(`! The app did not boot within ${timeoutMs / 1000}s, so no route table — starting the server anyway.`)
      // It may still finish: shut it down then, so the session holds one app.
      boot.then((late) => late.shutdown()).catch(() => {})
      return
    }
    printRoutes(booted.container, io)
  } catch (error) {
    io.error('! The app does not boot yet, so no route table — starting the server anyway; it restarts on every save:')
    for (const line of bootFailureLines(error)) io.error(`  ${line}`)
  } finally {
    clearTimeout(timer)
    if (app && app.phase !== 'created') await app.shutdown().catch(() => {})
  }
}

/** The reason a boot failed, in a few lines: the env report when there is one, else the first line of the message. */
export function bootFailureLines(error: unknown): string[] {
  const failure = (error ?? {}) as { code?: unknown; report?: unknown; message?: unknown; stack?: unknown }
  if (process.env['BASALT_DEBUG'] === '1' && typeof failure.stack === 'string') return failure.stack.split('\n')
  if (failure.code === 'ENV_INVALID' && Array.isArray(failure.report)) {
    return ['invalid environment variables:', ...failure.report.map((line) => `- ${String(line)}`)]
  }
  const first = String(failure.message ?? error).split('\n')[0] ?? ''
  return [first, '(BASALT_DEBUG=1 shows the stack trace)']
}

async function devEntry(flags: Record<string, string | boolean>, io: CommandIo): Promise<string | undefined> {
  if (typeof flags['entry'] === 'string') return flags['entry']
  const { existsSync } = await import('node:fs')
  const entry = resolveDevEntry(DEV_ENTRY_CANDIDATES, existsSync)
  if (!entry) io.error(`No entry file found. Looked for ${DEV_ENTRY_CANDIDATES.join(', ')}. Pass --entry=<file>.`)
  return entry
}

/** The route table, from the `http:routes` metadata whichever adapter published. Adapter-agnostic. */
function printRoutes(container: Container, io: CommandIo): void {
  const routes = ensureMetadata(container).get<DevRoute>('http:routes')
  if (routes.length === 0) return
  io.log(`Routes (${routes.length}):`)
  io.table(devRouteRows(routes))
}

async function startDevProcesses(entry: string, flags: Record<string, string | boolean>, io: CommandIo): Promise<number> {
  const tsx = await canResolve('tsx')
  const server = resolveDevRunner(entry, { tsx })
  const runners: { label: string; runner: DevRunner }[] = [{ label: 'server', runner: server }]

  // Embedded worker: a watched `queue:work` on the same CLI bin, so jobs
  // process in dev without a second terminal. Separate process (correct
  // producer/worker split) — each restarts independently on file change.
  if (flags['worker'] === true || flags['w'] === true) {
    const bin = process.argv[1] ?? entry
    const workerBase = resolveDevRunner(bin, { tsx })
    const queue = typeof flags['queue'] === 'string' ? [`--queue=${flags['queue']}`] : []
    runners.push({ label: 'worker', runner: { command: workerBase.command, args: [...workerBase.args, 'queue:work', ...queue] } })
  }

  for (const { label, runner } of runners) {
    io.log(`▶ ${label}: ${runner.command} ${runner.args.join(' ')}`)
  }

  const { spawn } = await import('node:child_process')
  return await new Promise<number>((resolve) => {
    const children = runners.map(({ runner }) => spawn(runner.command, runner.args, { stdio: 'inherit' }))
    const stop = () => children.forEach((c) => c.kill('SIGINT'))
    process.once('SIGINT', stop)
    let done = false
    const finish = (code: number) => {
      if (done) return
      done = true
      process.removeListener('SIGINT', stop)
      children.forEach((c) => c.kill('SIGINT'))
      resolve(code)
    }
    // The server is primary — when it exits, tear everything down.
    children[0]?.on('exit', (code) => finish(code ?? 0))
    children.forEach((child, i) =>
      child.on('error', (error) => {
        io.error(`Failed to start ${runners[i]?.label}: ${(error as Error).message}`)
        finish(1)
      }),
    )
  })
}

/** True if a module specifier resolves from the app's node_modules. */
async function canResolve(specifier: string): Promise<boolean> {
  try {
    const { createRequire } = await import('node:module')
    createRequire(`${process.cwd()}/`).resolve(specifier)
    return true
  } catch {
    return false
  }
}
