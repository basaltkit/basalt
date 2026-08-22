import { ensureMetadata } from '@basaltkit/core'
import { defineCommand, type CommandDefinition } from './command.js'

/** Default entry files probed in order when `--entry` is not given. */
export const DEV_ENTRY_CANDIDATES = ['src/main.ts', 'src/server.ts', 'src/index.ts', 'src/main.js', 'src/index.js']

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
 */
export const devCommand: CommandDefinition = defineCommand({
  name: 'dev',
  description: 'Run the app with watch + restart, print the route table, and (--worker) an embedded queue worker',
  async handle({ container, io, flags }) {
    const { existsSync } = await import('node:fs')
    const entry =
      typeof flags['entry'] === 'string'
        ? flags['entry']
        : resolveDevEntry(DEV_ENTRY_CANDIDATES, existsSync)
    if (!entry) {
      io.error(
        `No entry file found. Looked for ${DEV_ENTRY_CANDIDATES.join(', ')}. Pass --entry=<file>.`,
      )
      return 1
    }

    // The route table — the app was already booted by runCli, so `http:routes`
    // is populated by whichever adapter is in use. Adapter-agnostic (metadata only).
    if (flags['routes'] !== false) {
      const routes = ensureMetadata(container).get<DevRoute>('http:routes')
      if (routes.length > 0) {
        io.log(`Routes (${routes.length}):`)
        io.table(devRouteRows(routes))
      }
    }

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
  },
})

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
