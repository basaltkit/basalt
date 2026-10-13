import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { RUN_ID } from '@basaltkit/deploy/protocol'
import { ACTOR, validConfig, validDir, validSsh, type Target } from './targets.js'

/**
 * The system `ssh` (RFC 0009 §6): an argv array, never a shell; options that
 * win over the operator's `~/.ssh/config` for everything that could prompt,
 * forward or run something locally; `--` before the destination; and a
 * remote command built from validated pieces, each single-quoted for the
 * remote POSIX shell.
 */

/** Command-line `-o` values win over ssh_config (ssh keeps the first value it obtains). */
export const SSH_OPTIONS = [
  'BatchMode=yes',
  'StrictHostKeyChecking=yes',
  'ConnectTimeout=10',
  'ServerAliveInterval=15',
  'ServerAliveCountMax=3',
  'ForwardAgent=no',
  'ForwardX11=no',
  'ClearAllForwardings=yes',
  'PermitLocalCommand=no',
  'RequestTTY=no',
  'LogLevel=ERROR',
] as const

/** The app's lockfile-pinned copy of the deploy, the invocation the CLI documents — never npx. */
export const DEPLOY_BIN = 'node_modules/@basaltkit/deploy/dist/bin.js'

export const REMOTE_COMMANDS = ['status', 'plan', 'env', 'run', 'rollback', 'attach', 'cancel'] as const
export type RemoteCommand = typeof REMOTE_COMMANDS[number]

/** The commands that change the server (one at a time per target). */
export const MUTATING: ReadonlySet<RemoteCommand> = new Set(['env', 'run', 'rollback', 'cancel'])

export const SHA = /^[0-9a-f]{7,40}$/

/** What a remote invocation may carry: every flag is built here, never copied from a request. */
export interface RemoteSpec {
  command: RemoteCommand
  /** attach, cancel. */
  runId?: string
  /** env, run: the answers come on stdin. */
  answers?: boolean
  /** run, rollback. */
  detach?: boolean
  /** run. */
  unhold?: boolean
  /** rollback. */
  to?: string
  /** attach. */
  fromSeq?: number
  /** attach. */
  follow?: boolean
  /** cancel: refused by the server when the run was already cancelled once. */
  firstOnly?: boolean
}

export class UnsafeValueError extends Error {}

/** One word for a POSIX shell: `'` … `'`, an embedded `'` as `'\''`. */
export function shQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

/**
 * The remote command line: `cd '<dir>' && exec '<node>' '<bin>' '<cmd>' '--json=1' …`.
 * Every value is checked again here — the target grammar is the first wall,
 * this is the second — and then quoted.
 */
export function remoteCommand(target: Target, spec: RemoteSpec, actor?: string): string {
  const refuse = (what: string) => { throw new UnsafeValueError(`refused to build the remote command: ${what}`) }
  if (!(REMOTE_COMMANDS as readonly string[]).includes(spec.command)) refuse(`unknown command ${JSON.stringify(spec.command)}`)
  if (!validDir(target.dir)) refuse('the target dir')
  const node = target.node ?? 'node'
  if (target.node !== undefined && !validDir(target.node)) refuse('the target node')
  const words: string[] = [spec.command]
  if (spec.command === 'attach' || spec.command === 'cancel') {
    if (spec.runId === undefined || !RUN_ID.test(spec.runId)) refuse('the run id')
    words.push(spec.runId as string)
  }
  words.push('--json=1')
  if (spec.answers) {
    if (spec.command !== 'env' && spec.command !== 'run') refuse('answers on a command that asks nothing')
    words.push('--answers=stdin')
  }
  if (spec.detach) {
    if (spec.command !== 'run' && spec.command !== 'rollback') refuse('--detach on a command that does not detach')
    words.push('--detach')
  }
  if (spec.unhold) {
    if (spec.command !== 'run') refuse('--unhold off run')
    words.push('--unhold')
  }
  if (spec.to !== undefined) {
    if (spec.command !== 'rollback' || !SHA.test(spec.to)) refuse('the rollback commit')
    words.push(`--to=${spec.to}`)
  }
  if (spec.firstOnly) {
    if (spec.command !== 'cancel') refuse('--first-only off cancel')
    words.push('--first-only')
  }
  if (spec.command === 'attach') {
    const from = spec.fromSeq ?? 0
    if (!Number.isSafeInteger(from) || from < 0) refuse('the attach seq')
    if (spec.follow) words.push('--follow')
    words.push(`--from-seq=${from}`)
  }
  if (spec.command === 'env' || spec.command === 'run' || spec.command === 'rollback') {
    words.push('--via=ui')
    if (actor !== undefined) {
      if (!ACTOR.test(actor)) refuse('the actor')
      words.push(`--actor=${actor}`)
    }
  }
  if (target.config !== undefined) {
    if (!validConfig(target.config)) refuse('the target config')
    words.push(`--config=${target.config}`)
  }
  return `cd ${shQuote(target.dir)} && exec ${shQuote(node)} ${shQuote(DEPLOY_BIN)} ${words.map(shQuote).join(' ')}`
}

/** `%SystemRoot%` when it is an absolute drive path, else `C:\Windows`. */
export function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT']
  return root && /^[A-Za-z]:[\\/]/.test(root) ? root : 'C:\\Windows'
}

/**
 * The ssh client: `--ssh=<absolute path>`; else `ssh` through PATH on POSIX
 * (execvp never looks in the working directory unless PATH says so). On
 * Windows a bare name is looked up in the working directory BEFORE PATH, so
 * a planted `ssh.exe` in the folder the operator started from would get the
 * answers: there it is always an absolute path — the OpenSSH Client feature
 * (`%SystemRoot%\System32\OpenSSH\ssh.exe`) or the first `ssh.exe` in an
 * absolute PATH entry (never `.`, a relative or an empty one).
 */
export function sshProgram(platform: NodeJS.Platform, explicit?: string, env: NodeJS.ProcessEnv = {}, exists: (path: string) => boolean = existsSync): string {
  if (explicit) return explicit
  if (platform !== 'win32') return 'ssh'
  const builtIn = win32.join(windowsSystemRoot(env), 'System32', 'OpenSSH', 'ssh.exe')
  const path = env['Path'] ?? env['PATH'] ?? ''
  const fromPath = path.split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => /^[A-Za-z]:[\\/]/.test(entry))
    .map((entry) => win32.join(entry, 'ssh.exe'))
  // Not found anywhere: the built-in path, so the error is "no ssh client" and never a lookup in the working directory.
  return [builtIn, ...fromPath].find((candidate) => exists(candidate)) ?? builtIn
}

/** The ssh argv, without the program. */
export function sshArgs(target: Target, remote: string): string[] {
  if (!validSsh(target.ssh)) throw new UnsafeValueError('refused to run ssh: the destination is not [user@]host or an alias')
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) throw new UnsafeValueError('refused to run ssh: the port')
  return [
    '-T',
    ...SSH_OPTIONS.flatMap((option) => ['-o', option]),
    '-e', 'none',
    ...(target.port === undefined ? [] : ['-p', String(target.port)]),
    '--',
    target.ssh,
    remote,
  ]
}

export interface SshFailure {
  code: 'ssh-missing' | 'auth' | 'passphrase' | 'host-key' | 'timeout' | 'resolve' | 'refused' | 'network' | 'no-node' | 'no-dir' | 'no-deploy' | 'ssh'
  message: string
  hint?: string
}

/**
 * The common ways an ssh invocation fails, from its exit code and stderr, as
 * something the operator can act on. The UI never offers to fix them itself.
 */
export function classifySshFailure(exitCode: number | null, stderr: string, destination: string): SshFailure | undefined {
  const has = (pattern: RegExp) => pattern.test(stderr)
  if (has(/passphrase/i)) return { code: 'passphrase', message: 'your SSH key needs its passphrase, and ssh runs here in batch mode', hint: 'add the key to your agent first: ssh-add' }
  if (has(/Permission denied \(publickey/)) return { code: 'auth', message: 'the server refused your SSH key', hint: 'is the key loaded in your agent (ssh-add -l)? Can you `ssh ' + destination + '` from a terminal?' }
  if (has(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No \S+ host key is known/)) {
    return { code: 'host-key', message: 'this host\'s key is not in your known_hosts, or it changed', hint: `connect once from a terminal (ssh ${destination}) and check the fingerprint` }
  }
  if (has(/Could not resolve hostname|Name or service not known|nodename nor servname/i)) return { code: 'resolve', message: 'the host name does not resolve', hint: 'check the target\'s ssh field, or the Host alias in ~/.ssh/config' }
  if (has(/timed out|Connection timed out|Operation timed out/i)) return { code: 'timeout', message: 'the connection timed out', hint: 'is the server up, and port 22 (or the target\'s port) reachable from here?' }
  if (has(/Connection refused/i)) return { code: 'refused', message: 'the connection was refused', hint: 'is sshd listening on that port?' }
  if (has(/No route to host|Network is unreachable/i)) return { code: 'network', message: 'the network cannot reach the host' }
  if (has(/Cannot find module[^\n]*@basaltkit[/\\]deploy/)) return { code: 'no-deploy', message: 'the checkout has no installed @basaltkit/deploy', hint: 'install the app\'s dependencies on the server (pnpm install) once from a terminal' }
  if (has(/^.*\bcd\b.*(No such file or directory|can't cd)/m)) return { code: 'no-dir', message: 'the target\'s dir does not exist on the server', hint: 'check the target\'s dir (the app\'s checkout)' }
  if (exitCode === 127 || has(/node: (command )?not found|exec: .*node.*not found/)) {
    return { code: 'no-node', message: 'node was not found on the server for a non-interactive shell', hint: 'set the target\'s node to an absolute path (for example the output of `command -v node` in a login shell)' }
  }
  if (exitCode === 255) return { code: 'ssh', message: 'ssh failed (exit 255)' }
  return undefined
}
