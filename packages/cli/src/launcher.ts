/**
 * The global `basalt` launcher: `npm i -g @basaltkit/cli`, then `basalt <command>`
 * anywhere inside an app does what `pnpm basalt <command>` does there.
 *
 * It never runs commands itself. It finds the app (the nearest package.json
 * with a `basalt` script) and hands the arguments to that script through the
 * app's own package manager — so the code that runs is always the app's, at
 * the versions its lockfile pins, never the launcher's. Node built-ins only:
 * nothing of the framework is loaded.
 *
 * One command is the launcher's own: `basalt new <name> [flags]` scaffolds an
 * app through `create-basalt@latest` (`pnpm dlx`, else `npx`) — the latest
 * scaffolder, whatever version the launcher is.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

export interface LauncherProject {
  /** The directory whose package.json declares the `basalt` script. */
  root: string
  /** The script itself, e.g. `tsx bin/basalt.ts`. */
  script: string
  pm: PackageManager
}

/** Set on the script's environment: a `basalt` script that calls `basalt` again would loop. */
export const LAUNCHER_ENV = 'BASALT_LAUNCHER_ROOT'

interface Manifest {
  scripts?: Record<string, unknown>
  packageManager?: unknown
}

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof value === 'object' && value !== null ? (value as Manifest) : undefined
  } catch {
    return undefined // an unreadable package.json is not an app: keep walking
  }
}

/** Every directory from `from` up to the filesystem root, nearest first. */
function* ancestors(from: string): Generator<string> {
  let dir = resolve(from)
  while (true) {
    yield dir
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

/** The nearest app at or above `from`: a package.json with a `basalt` script. */
export function findProject(from: string): LauncherProject | undefined {
  for (const dir of ancestors(from)) {
    const script = readManifest(dir)?.scripts?.['basalt']
    if (typeof script === 'string' && script.trim() !== '') {
      return { root: dir, script, pm: detectPackageManager(dir) }
    }
  }
  return undefined
}

const LOCKFILES: Array<[PackageManager, string[]]> = [
  ['pnpm', ['pnpm-lock.yaml']],
  ['bun', ['bun.lock', 'bun.lockb']],
  ['yarn', ['yarn.lock']],
  ['npm', ['package-lock.json']],
]

/**
 * `packageManager` in the nearest package.json that has one, else the nearest
 * lockfile — both walking up, so an app inside a workspace uses the
 * workspace's manager. Nothing found: npm.
 */
export function detectPackageManager(root: string): PackageManager {
  for (const dir of ancestors(root)) {
    const declared = readManifest(dir)?.packageManager
    if (typeof declared === 'string') {
      const name = declared.split('@')[0]
      if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name
    }
    for (const [pm, files] of LOCKFILES) if (files.some((file) => existsSync(join(dir, file)))) return pm
  }
  return 'npm'
}

/**
 * The command that runs the app's `basalt` script with `args`, as given:
 * pnpm, yarn and bun pass everything after the script name through (a `--`
 * included); npm needs a `--` first.
 */
export function launchCommand(pm: PackageManager, args: readonly string[]): { command: string; args: string[] } {
  switch (pm) {
    case 'pnpm': return { command: 'pnpm', args: ['run', '--silent', 'basalt', ...args] }
    case 'npm': return { command: 'npm', args: ['run', '--silent', 'basalt', '--', ...args] }
    case 'yarn': return { command: 'yarn', args: ['run', 'basalt', ...args] }
    case 'bun': return { command: 'bun', args: ['run', 'basalt', ...args] }
  }
}

function launcherVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface RunLauncherOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Where the launcher's own lines go (never the app's output). */
  error?: (line: string) => void
  log?: (line: string) => void
  /** Whether pnpm is installed — what `basalt new` runs create-basalt with. Default: `pnpm --version` answers. */
  hasPnpm?: () => boolean
}

/**
 * How `basalt new` runs `create-basalt@latest`: through the manager `--pm=`
 * names, else pnpm when it is installed, else npx. create-basalt reads the
 * manager it was started with, so the new app uses the same one.
 */
export function scaffoldCommand(args: readonly string[], hasPnpm: () => boolean): { command: string; args: string[] } {
  const pm = args.find((arg) => arg.startsWith('--pm='))?.slice('--pm='.length)
  const pkg = 'create-basalt@latest'
  if (pm === 'pnpm' || (pm === undefined && hasPnpm())) return { command: 'pnpm', args: ['--silent', 'dlx', pkg, ...args] }
  if (pm === 'bun') return { command: 'bunx', args: [pkg, ...args] }
  return { command: 'npx', args: ['--yes', pkg, ...args] } // npm, and yarn (create-basalt honours --pm=yarn)
}

const pnpmInstalled = (): boolean =>
  spawnSync('pnpm', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0

const NOT_AN_APP = [
  'basalt: no Basalt app here — no package.json with a "basalt" script in this directory or above it.',
  '  Start one:   basalt new my-app',
  '  Or cd into an app first; `basalt <command>` then runs `<pm> basalt <command>` there.',
]

/** Runs `basalt <argv>`: the app's `basalt` script, through the app's package manager. Resolves to the exit code. */
export async function runLauncher(argv: readonly string[], options: RunLauncherOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const error = options.error ?? ((line: string) => process.stderr.write(`${line}\n`))
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))

  // The launcher's own command, inside an app too: a new app is never the current one's business.
  if (argv[0] === 'new') {
    const scaffold = scaffoldCommand(argv.slice(1), options.hasPnpm ?? pnpmInstalled)
    return spawnAndWait(scaffold.command, scaffold.args, { cwd, env, error, what: 'create a new app' })
  }

  const project = findProject(cwd)
  if (!project) {
    if (argv[0] === '--version' || argv[0] === '-v') {
      log(`basalt launcher ${launcherVersion()} (@basaltkit/cli)`)
      return 0
    }
    for (const line of NOT_AN_APP) error(line)
    return 1
  }
  if (env[LAUNCHER_ENV] === project.root) {
    error(`basalt: the "basalt" script in ${join(project.root, 'package.json')} runs \`basalt\` again (${project.script}).`)
    error('  Point it at the app\'s own CLI instead, e.g. "basalt": "tsx bin/basalt.ts".')
    return 1
  }

  const { command, args } = launchCommand(project.pm, argv)
  return spawnAndWait(command, args, {
    cwd: project.root,
    env: { ...env, [LAUNCHER_ENV]: project.root },
    error,
    what: `run this app's basalt script (${project.root})`,
  })
}

/** Runs one command with the terminal attached; resolves to its exit code. */
function spawnAndWait(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; error: (line: string) => void; what: string },
): Promise<number> {
  const { error } = options
  return new Promise<number>((done) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    // Ctrl-C reaches the whole foreground group: the child handles it; the
    // launcher only waits for it to finish and reports its code.
    const ignore = () => {}
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    for (const signal of signals) process.on(signal, ignore)
    const settle = (code: number) => {
      for (const signal of signals) process.off(signal, ignore)
      done(code)
    }
    child.on('error', (cause: NodeJS.ErrnoException) => {
      error(cause.code === 'ENOENT'
        ? `basalt: ${command} is not installed, and it is needed to ${options.what}.`
        : `basalt: could not start ${command}: ${cause.message}`)
      settle(1)
    })
    child.on('exit', (code, signal) => {
      settle(code ?? (signal ? 128 + signalNumber(signal) : 1))
    })
  })
}

function signalNumber(signal: NodeJS.Signals): number {
  return { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }[signal as string] ?? 1
}
