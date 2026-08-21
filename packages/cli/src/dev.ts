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

/** `basalt dev [--entry=<file>]` — run the app with watch + restart. */
export const devCommand: CommandDefinition = defineCommand({
  name: 'dev',
  description: 'Run the app with file watching and auto-restart',
  async handle({ io, flags }) {
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
    const tsx = await canResolve('tsx')
    const runner = resolveDevRunner(entry, { tsx })
    io.log(`Starting: ${runner.command} ${runner.args.join(' ')}`)

    const { spawn } = await import('node:child_process')
    return await new Promise<number>((resolve) => {
      const child = spawn(runner.command, runner.args, { stdio: 'inherit' })
      const stop = () => child.kill('SIGINT')
      process.once('SIGINT', stop)
      child.on('exit', (code) => {
        process.removeListener('SIGINT', stop)
        resolve(code ?? 0)
      })
      child.on('error', (error) => {
        io.error(`Failed to start dev runner: ${(error as Error).message}`)
        resolve(1)
      })
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
