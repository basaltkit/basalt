import { spawn as nodeSpawn } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { openBrowser } from './open.js'
import type { Spawn, SshRunner } from './remote.js'
import { MAX_IDLE_MINUTES, startUiServer, type UiServer, type UiServerOptions } from './server.js'
import { sshProgram } from './ssh.js'
import { defaultTargetsPath } from './targets.js'

export const USAGE = `basalt-deploy-ui — a local UI for @basaltkit/deploy (RFC 0009)

Runs on YOUR machine, never on the server. Listens on 127.0.0.1 only and drives
each server over your own ssh (keys, agent, known_hosts), as the app user.

  npx @basaltkit/deploy-ui@<exact version> [options]

Options:
  --targets=<file>      the targets file (default: $XDG_CONFIG_HOME/basalt/deploy-targets.json,
                        %APPDATA%\\basalt\\deploy-targets.json on Windows)
  --ssh=<absolute path> the ssh client (default: ssh from PATH; on Windows
                        %SystemRoot%\\System32\\OpenSSH\\ssh.exe, else the first ssh.exe
                        in an absolute PATH entry — never the current folder)
  --no-open             print the URL instead of opening the browser
  --pair                open the bare URL and type a short code this terminal shows:
                        nothing secret in the browser's command line, which other
                        users of a shared machine can read
  --idle-minutes=<n>    stop after n idle minutes (1–${MAX_IDLE_MINUTES}, default 15)
  -h, --help

Never add @basaltkit/deploy-ui to an app's package.json: the deploy installs an
app's devDependencies on the server.
`

export interface CliFlags {
  targets?: string
  ssh?: string
  open: boolean
  pair: boolean
  idleMinutes: number
  help: boolean
}

export class UsageError extends Error {}

export function parseFlags(argv: readonly string[], cwd: string): CliFlags {
  const flags: CliFlags = { open: true, pair: false, idleMinutes: 15, help: false }
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') { flags.help = true; continue }
    if (arg === '--no-open') { flags.open = false; continue }
    if (arg === '--pair') { flags.pair = true; continue }
    const match = /^--(targets|ssh|idle-minutes)=(.+)$/.exec(arg)
    if (!match) throw new UsageError(`unknown argument ${JSON.stringify(arg)} (there is no --host or --port: the UI listens on 127.0.0.1 and a port the OS picks)`)
    const [, name, value] = match as unknown as [string, string, string]
    if (name === 'targets') flags.targets = resolve(cwd, value)
    else if (name === 'ssh') {
      if (!isAbsolute(value)) throw new UsageError('--ssh takes an absolute path')
      flags.ssh = value
    } else {
      if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > MAX_IDLE_MINUTES) throw new UsageError(`--idle-minutes takes 1 to ${MAX_IDLE_MINUTES}`)
      flags.idleMinutes = Number(value)
    }
  }
  return flags
}

export interface CliDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  cwd: string
  home: string
  osUser: string | undefined
  spawn: Spawn
  /** One line to the terminal (stderr). */
  print: (line: string) => void
  /** The browser opener; the URL carries the one-time launch code. */
  open: (url: string) => Promise<boolean>
  start: (options: UiServerOptions) => Promise<UiServer>
  /** Ctrl-C and friends. */
  onSignal: (listener: () => void) => void
  /** Overrides for tests (the fake ssh). */
  runner?: Partial<SshRunner>
  clientDir?: string | null
}

export function processDeps(): CliDeps {
  let osUser: string | undefined
  try {
    osUser = userInfo().username
  } catch {
    osUser = undefined
  }
  return {
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    osUser,
    spawn: nodeSpawn as Spawn,
    print: (line) => { process.stderr.write(`${line}\n`) },
    open: (url) => openBrowser(nodeSpawn as Spawn, process.platform, url, homedir(), process.env),
    start: startUiServer,
    onSignal: (listener) => { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, listener) },
  }
}

/** Starts the UI; resolves with an exit code once it has stopped (idle, quit, a signal) — or at once on a usage error. */
export async function main(argv: readonly string[], deps: CliDeps = processDeps()): Promise<number> {
  let flags: CliFlags
  try {
    flags = parseFlags(argv, deps.cwd)
  } catch (error) {
    deps.print(`basalt-deploy-ui: ${(error as Error).message}`)
    return 2
  }
  if (flags.help) {
    deps.print(USAGE.trimEnd())
    return 0
  }
  const targetsPath = flags.targets ?? defaultTargetsPath(deps.platform, deps.env, deps.home)
  let finish: (code: number) => void = () => undefined
  const finished = new Promise<number>((resolve) => { finish = resolve })
  const server = await deps.start({
    targetsPath,
    runner: { program: sshProgram(deps.platform, flags.ssh, deps.env), prefix: [], spawn: deps.spawn, env: deps.env, cwd: deps.home, ...deps.runner },
    ...(deps.osUser ? { osUser: deps.osUser } : {}),
    idleMinutes: flags.idleMinutes,
    pair: flags.pair,
    ...(deps.clientDir === undefined ? {} : { clientDir: deps.clientDir }),
    log: (line) => deps.print(`basalt-deploy-ui: ${line}`),
    onStop: (reason) => {
      deps.print(reason === 'idle' ? `basalt-deploy-ui: stopped after ${flags.idleMinutes} idle minutes` : 'basalt-deploy-ui: stopped')
      finish(0)
    },
  })
  deps.onSignal(() => {
    void server.close().then(() => {
      deps.print('basalt-deploy-ui: stopped (detached runs go on on the server)')
      finish(0)
    })
  })
  deps.print(`basalt-deploy-ui: listening on ${server.url} (this machine only)`)
  deps.print(`basalt-deploy-ui: targets in ${targetsPath}`)
  const opened = flags.open && await Promise.race([deps.open(server.launchUrl), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000).unref())])
  if (server.pairCode) {
    if (!opened) deps.print(`basalt-deploy-ui: open this URL in your browser:\n  ${server.launchUrl}`)
    deps.print(`basalt-deploy-ui: pairing code ${server.pairCode} — type it in the page within 2 minutes (5 tries)`)
  } else if (!opened) {
    deps.print(`basalt-deploy-ui: open this URL in your browser within 2 minutes (it works once):\n  ${server.launchUrl}`)
  }
  return finished
}
